// Runs on youtube.com/watch pages. Reads embedded YT JSON via an injected
// bridge, normalizes into a transcript payload, posts to background.

(async () => {
  try {
    const globals = await readPageGlobals();
    if (!globals) {
      chrome.runtime.sendMessage({ error: 'Failed to read YouTube page globals' });
      return;
    }
    const { player, initial } = globals;

    // Resolve caption track
    const tracks =
      player &&
      player.captions &&
      player.captions.playerCaptionsTracklistRenderer &&
      player.captions.playerCaptionsTracklistRenderer.captionTracks;
    if (!Array.isArray(tracks) || tracks.length === 0) {
      chrome.runtime.sendMessage({ error: 'No captions available for this video' });
      return;
    }
    const isEnglish = code => {
      if (!code) return false;
      const lower = String(code).toLowerCase();
      return lower === 'en' || lower.startsWith('en-');
    };
    const englishTracks = tracks.filter(t => t && isEnglish(t.languageCode));
    if (englishTracks.length === 0) {
      chrome.runtime.sendMessage({ error: 'No English captions available for this video' });
      return;
    }
    const track = englishTracks.find(t => t.kind !== 'asr') || englishTracks[0];

    // Fetch caption JSON
    const captionUrl = track.baseUrl + '&fmt=json3';
    const resp = await fetch(captionUrl);
    if (!resp.ok) {
      chrome.runtime.sendMessage({ error: `Caption fetch failed: ${resp.status}` });
      return;
    }
    const captions = await resp.json();

    // Parse events to [{ startMs, text }]
    const transcript = [];
    for (const ev of captions.events || []) {
      if (!ev.segs) continue;
      const text = ev.segs.map(s => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      transcript.push({ startMs: Number(ev.tStartMs) || 0, text });
    }
    if (transcript.length === 0) {
      chrome.runtime.sendMessage({ error: 'Caption track was empty' });
      return;
    }

    // Metadata
    const vd = player.videoDetails || {};
    const micro =
      player.microformat &&
      player.microformat.playerMicroformatRenderer;
    const thumbs = (vd.thumbnail && vd.thumbnail.thumbnails) || [];
    const bestThumb = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : '';
    const meta = {
      title: vd.title || '',
      channel: vd.author || '',
      videoId: vd.videoId || '',
      durationSec: Number(vd.lengthSeconds) || 0,
      thumbnailUrl: bestThumb,
      uploadDate: (micro && micro.uploadDate) || '',
      watchUrl: vd.videoId ? `https://www.youtube.com/watch?v=${vd.videoId}` : window.location.href,
    };

    // Chapters (may or may not exist)
    const chapters = extractChapters(initial);

    // Verbosity from extension storage (defaults to 180)
    const { ytVerbosity } = await chrome.storage.local.get('ytVerbosity');
    const verbosity = typeof ytVerbosity === 'number' ? ytVerbosity : 180;

    chrome.runtime.sendMessage({
      type: 'youtube-transcript',
      data: { ...meta, chapters, transcript, verbosity },
    });
  } catch (err) {
    chrome.runtime.sendMessage({ error: `YouTube content script failed: ${err && err.message ? err.message : err}` });
  }
})();

// --- helpers ---

function readPageGlobals() {
  // Inject a bridge <script> that copies window.ytInitialPlayerResponse and
  // window.ytInitialData into a window.postMessage. We listen for the
  // response and resolve with the parsed objects.
  return new Promise((resolve) => {
    const nonce = 'reader-yt-' + Math.random().toString(36).slice(2);
    function listener(e) {
      if (e.source !== window) return;
      if (!e.data || e.data.source !== nonce) return;
      window.removeEventListener('message', listener);
      resolve({ player: e.data.player, initial: e.data.initial });
    }
    window.addEventListener('message', listener);

    const code = `
      (function(){
        try {
          window.postMessage({
            source: ${JSON.stringify(nonce)},
            player: window.ytInitialPlayerResponse || null,
            initial: window.ytInitialData || null
          }, '*');
        } catch (e) {
          window.postMessage({ source: ${JSON.stringify(nonce)}, player: null, initial: null }, '*');
        }
      })();
    `;
    const s = document.createElement('script');
    s.textContent = code;
    (document.head || document.documentElement).appendChild(s);
    s.remove();

    // Timeout fallback after 3s so we never hang.
    setTimeout(() => {
      window.removeEventListener('message', listener);
      resolve(null);
    }, 3000);
  });
}

function extractChapters(initial) {
  try {
    const markersMap =
      initial &&
      initial.playerOverlays &&
      initial.playerOverlays.playerOverlayRenderer &&
      initial.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer &&
      initial.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer &&
      initial.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar &&
      initial.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer &&
      initial.playerOverlays.playerOverlayRenderer.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer.playerBar.multiMarkersPlayerBarRenderer.markersMap;
    if (!Array.isArray(markersMap)) return [];
    const entry =
      markersMap.find(m => m && (m.key === 'DESCRIPTION_CHAPTERS' || m.key === 'AUTO_CHAPTERS'));
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
