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
    script: 'content-youtube.js',
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

  // Inject appropriate content script
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
    } else {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: [site.script]
      });
    }
  } catch (e) {
    await setBadge('ERR', '#cc0000', tab.id);
    console.error('Failed to inject content script:', e);
  }
});

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
  } else if (message.type === 'youtube-transcript') {
    tabsSending.add(tabId);
    sendToServer(message.data, '/summarize-youtube', tabId).finally(() => tabsSending.delete(tabId));
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
