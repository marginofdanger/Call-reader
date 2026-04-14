const SERVER_URL = 'http://localhost:3210';

// Context menu — right-click extension icon
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id: 'open-status', title: 'Open Status Page', contexts: ['action'] });
  chrome.contextMenus.create({ id: 'open-settings', title: 'Settings', contexts: ['action'] });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'open-status') {
    chrome.tabs.create({ url: `${SERVER_URL}/status` });
  } else if (info.menuItemId === 'open-settings') {
    chrome.action.openPopup();
  }
});

// Supported site patterns
const SITE_PATTERNS = {
  bamsec: { match: url => url.includes('bamsec.com/transcripts'), script: 'content.js', endpoint: '/summarize' },
  expert: { match: url => /tegus\.co|alpha-sense\.com|alphasense\.com|alphasights\.com/i.test(url), script: 'content-expert.js', endpoint: '/summarize-expert' },
  youtube: {
    match: url => /(?:^|\.)youtube\.com\/watch/.test(url),
    endpoint: '/summarize-youtube'
  },
};

function detectSite(url) {
  for (const [key, site] of Object.entries(SITE_PATTERNS)) {
    if (site.match(url)) return { key, ...site };
  }
  return null;
}

// Listen for toolbar button click
chrome.action.onClicked.addListener(async (tab) => {
  const site = detectSite(tab.url || '');
  if (!site) {
    await setBadge('ERR', '#cc0000', tab.id);
    console.error('Not a supported transcript page:', tab.url);
    return;
  }

  // Check server health
  try {
    const health = await fetch(`${SERVER_URL}/health`);
    if (!health.ok) throw new Error('Server unhealthy');
  } catch (e) {
    await setBadge('OFF', '#cc0000', tab.id);
    console.error('Server not running at', SERVER_URL);
    return;
  }

  await setBadge('...', '#0066cc', tab.id);

  // Dispatch by site type
  try {
    if (site.key === 'expert') {
      // Two-phase: extract metadata from all frames first, then inject transcript script
      tabMetadata.delete(tab.id);
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content-expert-meta.js']
      });
      // Small delay to let metadata messages arrive before transcript script runs
      await new Promise(r => setTimeout(r, 300));
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: [site.script]
      });
    } else if (site.key === 'youtube') {
      // YouTube: extract page globals from MAIN world directly (bypasses CSP),
      // do caption fetch + metadata + POST all from the service worker.
      await handleYouTube(tab.id);
    } else {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: [site.script]
      });
    }
  } catch (e) {
    await setBadge('ERR', '#cc0000', tab.id);
    console.error('Failed to process page:', e);
  }
});

async function handleYouTube(tabId) {
  if (tabsSending.has(tabId)) return;

  // Get the video ID from the tab URL and fetch the watch page HTML directly.
  // YouTube is an SPA so window.ytInitialPlayerResponse may be stale or deleted
  // after the player initializes; the HTML source always has it embedded.
  const tab = await chrome.tabs.get(tabId);
  const videoId = extractVideoId(tab.url || '');
  if (!videoId) {
    await setBadge('ERR', '#cc0000', tabId);
    console.error('YouTube: no video id in tab URL');
    return;
  }

  let player, initial;
  try {
    const resp = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`);
    if (!resp.ok) {
      await setBadge('ERR', '#cc0000', tabId);
      console.error(`YouTube: watch page fetch failed ${resp.status}`);
      return;
    }
    const html = await resp.text();
    player = extractInlineJson(html, 'ytInitialPlayerResponse');
    initial = extractInlineJson(html, 'ytInitialData');
  } catch (e) {
    await setBadge('ERR', '#cc0000', tabId);
    console.error('YouTube: watch page fetch error:', e);
    return;
  }

  if (!player) {
    await setBadge('ERR', '#cc0000', tabId);
    console.error('YouTube: could not parse ytInitialPlayerResponse from HTML');
    return;
  }

  // Fast sanity check: does YouTube even think this video has captions?
  const hasCaptions =
    player.captions &&
    player.captions.playerCaptionsTracklistRenderer &&
    Array.isArray(player.captions.playerCaptionsTracklistRenderer.captionTracks) &&
    player.captions.playerCaptionsTracklistRenderer.captionTracks.length > 0;
  if (!hasCaptions) {
    await setBadge('ERR', '#cc0000', tabId);
    console.error('YouTube: no captions available for this video');
    return;
  }

  // Scrape the transcript from the YouTube tab's UI. The timedtext API
  // endpoint now returns empty bodies for anything without a Proof-of-Origin
  // token, so we go through the DOM instead: open the transcript panel if
  // it isn't already open, wait for segments to appear, read them.
  console.log('YouTube: scraping transcript from tab UI');
  const scrapeResults = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async () => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));

      const readSegments = () => {
        const nodes = document.querySelectorAll('ytd-transcript-segment-renderer');
        const out = [];
        for (const n of nodes) {
          const timeEl = n.querySelector('.segment-timestamp, [class*="segment-timestamp"]');
          const textEl = n.querySelector('.segment-text, yt-formatted-string.segment-text, [class*="segment-text"]');
          const time = timeEl ? timeEl.textContent.trim() : '';
          const text = textEl ? textEl.textContent.trim() : '';
          if (text) out.push({ time, text });
        }
        return out;
      };

      // If transcript is already open, just read it.
      let segs = readSegments();
      if (segs.length > 0) return { ok: true, segments: segs, opened: false };

      // Expand description if collapsed.
      const expand = document.querySelector('tp-yt-paper-button#expand, #expand');
      if (expand) { expand.click(); await sleep(150); }

      // Find a transcript trigger button. Try a few selectors.
      let triggerBtn = null;
      const candidates = [
        'ytd-video-description-transcript-section-renderer button',
        'ytd-video-description-transcript-section-renderer ytd-button-renderer button',
        'button[aria-label*="ranscript" i]',
      ];
      for (const sel of candidates) {
        const b = document.querySelector(sel);
        if (b) { triggerBtn = b; break; }
      }
      if (!triggerBtn) {
        // Last resort: scan all buttons for "show transcript" text
        const allBtns = document.querySelectorAll('button, yt-button-shape button, tp-yt-paper-button');
        for (const b of allBtns) {
          const label = (b.getAttribute('aria-label') || b.textContent || '').trim();
          if (/show transcript/i.test(label)) { triggerBtn = b; break; }
        }
      }
      if (!triggerBtn) {
        return { ok: false, error: 'Could not find Show transcript button' };
      }
      triggerBtn.click();

      // Poll for segments to appear, up to 5 seconds.
      for (let i = 0; i < 50; i++) {
        await sleep(100);
        segs = readSegments();
        if (segs.length > 0) return { ok: true, segments: segs, opened: true };
      }
      return { ok: false, error: 'Transcript panel did not populate within 5s' };
    },
  });

  const scrapeResult = scrapeResults && scrapeResults[0] && scrapeResults[0].result;
  if (!scrapeResult) {
    await setBadge('ERR', '#cc0000', tabId);
    console.error('YouTube: transcript scrape script returned no result');
    return;
  }
  if (!scrapeResult.ok) {
    await setBadge('ERR', '#cc0000', tabId);
    console.error('YouTube: transcript scrape failed:', scrapeResult.error);
    return;
  }
  console.log(`YouTube: scraped ${scrapeResult.segments.length} transcript segments`);

  // Parse "H:MM:SS" / "M:SS" timestamps to ms.
  const transcript = [];
  for (const seg of scrapeResult.segments) {
    const startMs = parseTimestampToMs(seg.time);
    const text = (seg.text || '').replace(/\s+/g, ' ').trim();
    if (text) transcript.push({ startMs, text });
  }
  if (transcript.length === 0) {
    await setBadge('ERR', '#cc0000', tabId);
    console.error('YouTube: transcript was empty after parsing');
    return;
  }

  // Metadata
  const vd = player.videoDetails || {};
  const micro = player.microformat && player.microformat.playerMicroformatRenderer;
  const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
  const bestThumb = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';
  const meta = {
    title: vd.title || '',
    channel: vd.author || '',
    videoId: vd.videoId || '',
    durationSec: Number(vd.lengthSeconds) || 0,
    thumbnailUrl: bestThumb,
    uploadDate: (micro && micro.uploadDate) || '',
    watchUrl: vd.videoId ? `https://www.youtube.com/watch?v=${vd.videoId}` : '',
  };

  // Chapters (optional)
  const chapters = extractYouTubeChapters(initial);

  // Verbosity from storage (default 180)
  const { ytVerbosity } = await chrome.storage.local.get('ytVerbosity');
  const verbosity = typeof ytVerbosity === 'number' ? ytVerbosity : 180;

  const payload = { ...meta, chapters, transcript, verbosity };
  tabsSending.add(tabId);
  sendToServer(payload, '/summarize-youtube', tabId).finally(() => tabsSending.delete(tabId));
}

function parseTimestampToMs(ts) {
  if (!ts) return 0;
  const parts = String(ts).split(':').map(x => parseInt(x, 10));
  if (parts.some(n => Number.isNaN(n))) return 0;
  let sec = 0;
  if (parts.length === 1) sec = parts[0];
  else if (parts.length === 2) sec = parts[0] * 60 + parts[1];
  else if (parts.length === 3) sec = parts[0] * 3600 + parts[1] * 60 + parts[2];
  return sec * 1000;
}

function extractVideoId(tabUrl) {
  try {
    const u = new URL(tabUrl);
    return u.searchParams.get('v');
  } catch (e) {
    return null;
  }
}

function extractInlineJson(html, varName) {
  // YouTube embeds these variables in different patterns across versions:
  //   var ytInitialPlayerResponse = {...};
  //   ytInitialPlayerResponse = {...};
  //   window["ytInitialPlayerResponse"] = {...};
  const escaped = varName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`var\\s+${escaped}\\s*=\\s*`),
    new RegExp(`window\\[["']${escaped}["']\\]\\s*=\\s*`),
    new RegExp(`(?:^|[;\\s])${escaped}\\s*=\\s*`, 'm'),
  ];
  let startIdx = -1;
  for (const p of patterns) {
    const m = html.match(p);
    if (m && m.index != null) {
      // startIdx points to the opening brace of the JSON
      const afterMatch = m.index + m[0].length;
      if (html[afterMatch] === '{') {
        startIdx = afterMatch;
        break;
      }
    }
  }
  if (startIdx < 0) return null;

  // Balanced-brace scan, respecting strings and escapes.
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = startIdx; i < html.length; i++) {
    const c = html[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (c === '\\') { escapeNext = true; continue; }
    if (inString) {
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(startIdx, i + 1));
        } catch (e) {
          return null;
        }
      }
    }
  }
  return null;
}

function extractYouTubeChapters(initial) {
  try {
    const overlays = initial && initial.playerOverlays && initial.playerOverlays.playerOverlayRenderer;
    const dec = overlays && overlays.decoratedPlayerBarRenderer && overlays.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer;
    const playerBar = dec && dec.playerBar && dec.playerBar.multiMarkersPlayerBarRenderer;
    const markersMap = playerBar && playerBar.markersMap;
    if (!Array.isArray(markersMap)) return [];
    const entry = markersMap.find(m => m && (m.key === 'DESCRIPTION_CHAPTERS' || m.key === 'AUTO_CHAPTERS'));
    if (!entry || !entry.value || !Array.isArray(entry.value.chapters)) return [];
    const out = [];
    for (const c of entry.value.chapters) {
      const r = c && c.chapterRenderer;
      if (!r) continue;
      const title =
        (r.title && typeof r.title.simpleText === 'string' && r.title.simpleText) ||
        (r.title && Array.isArray(r.title.runs) && r.title.runs.map(x => (x && x.text) || '').join('')) ||
        null;
      const startMs = Number(r.timeRangeStartMillis);
      if (title && Number.isFinite(startMs)) out.push({ title, startMs });
    }
    return out;
  } catch (e) {
    return [];
  }
}

// Track which tabs have already sent a request (prevent duplicate sends from multiple frames)
const tabsSending = new Set();

// Store metadata extracted from top frame, keyed by tabId
const tabMetadata = new Map();

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;

  if (message.error) {
    setBadge('ERR', '#cc0000', tabId);
    console.error('Content script error:', message.error);
    return;
  }

  // Metadata messages are always accepted (not a server send) — merge from multiple frames
  if (message.type === 'expert-metadata') {
    const existing = tabMetadata.get(tabId) || {};
    const incoming = message.data;
    // For each field, keep the first non-empty value found
    const merged = {
      title: existing.title || incoming.title || '',
      interviewDate: existing.interviewDate || incoming.interviewDate || '',
      datePublished: existing.datePublished || incoming.datePublished || '',
      expertPerspective: existing.expertPerspective || incoming.expertPerspective || '',
      analystPerspective: existing.analystPerspective || incoming.analystPerspective || '',
      primaryCompany: existing.primaryCompany || incoming.primaryCompany || '',
    };
    tabMetadata.set(tabId, merged);
    console.log('Expert metadata (merged):', merged);
    return;
  }

  // Prevent duplicate sends from multiple frames
  if (tabsSending.has(tabId)) return;

  if (message.type === 'transcript') {
    tabsSending.add(tabId);
    sendToServer(message.data, '/summarize', tabId).finally(() => tabsSending.delete(tabId));
  } else if (message.type === 'expert-transcript') {
    tabsSending.add(tabId);
    // Merge metadata from top frame (if available) into transcript data
    const meta = tabMetadata.get(tabId);
    if (meta) {
      const data = message.data;
      // Top-frame metadata wins over iframe-extracted metadata for each field
      if (meta.title && (!data.title || data.title === 'Expert Interview')) data.title = meta.title;
      if (meta.interviewDate && !data.interviewDate) data.interviewDate = meta.interviewDate;
      if (meta.datePublished && !data.datePublished) data.datePublished = meta.datePublished;
      if (meta.expertPerspective && !data.expertPerspective) data.expertPerspective = meta.expertPerspective;
      if (meta.analystPerspective && !data.analystPerspective) data.analystPerspective = meta.analystPerspective;
      if (meta.primaryCompany && !data.primaryCompany) data.primaryCompany = meta.primaryCompany;
      // For dates specifically, always prefer top-frame metadata (it's more reliable)
      if (meta.interviewDate) data.interviewDate = meta.interviewDate;
      if (meta.datePublished) data.datePublished = meta.datePublished;
      tabMetadata.delete(tabId);
    }
    sendToServer(message.data, '/summarize-expert', tabId).finally(() => tabsSending.delete(tabId));
  }
});

async function sendToServer(data, endpoint, tabId) {
  try {
    // Verbosity controlled by server settings (status page)
    const response = await fetch(`${SERVER_URL}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data)
    });

    const result = await response.json();

    if (result.success && result.jobId) {
      // Poll for completion using alarms (survives service worker restarts)
      const alarmName = `poll_${result.jobId}_${tabId}`;
      await chrome.storage.local.set({ [alarmName]: { jobId: result.jobId, tabId } });
      chrome.alarms.create(alarmName, { delayInMinutes: 0.1, periodInMinutes: 0.1 }); // every 6s
    } else {
      await setBadge('ERR', '#cc0000', tabId);
      console.error('Server error:', result.error);
    }
  } catch (e) {
    await setBadge('ERR', '#cc0000', tabId);
    console.error('Failed to reach server:', e);
  }
}

// Poll for job completion via alarms (persistent across service worker restarts)
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (!alarm.name.startsWith('poll_')) return;

  const stored = await chrome.storage.local.get(alarm.name);
  const info = stored[alarm.name];
  if (!info) { chrome.alarms.clear(alarm.name); return; }

  try {
    const response = await fetch(`${SERVER_URL}/job/${info.jobId}`);
    const job = await response.json();

    if (job.status === 'done') {
      chrome.alarms.clear(alarm.name);
      chrome.storage.local.remove(alarm.name);
      await setBadge('OK', '#00aa00', info.tabId);
      if (job.filename) {
        chrome.tabs.create({ url: `${SERVER_URL}/output/${job.filename}`, active: false });
      }
    } else if (job.status === 'error') {
      chrome.alarms.clear(alarm.name);
      chrome.storage.local.remove(alarm.name);
      await setBadge('ERR', '#cc0000', info.tabId);
      console.error('Job failed:', job.error);
    }
    // else still queued/processing — alarm will fire again
  } catch (e) {
    // Server unreachable — keep polling
    console.error('Poll error:', e);
  }
});

async function setBadge(text, color, tabId) {
  await chrome.action.setBadgeText({ text, tabId });
  await chrome.action.setBadgeBackgroundColor({ color, tabId });
  if (text !== '...') {
    setTimeout(() => {
      chrome.action.setBadgeText({ text: '', tabId });
    }, 5000);
  }
}
