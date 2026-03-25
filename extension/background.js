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
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: [site.script]
    });
  } catch (e) {
    await setBadge('ERR', '#cc0000', tab.id);
    console.error('Failed to inject content script:', e);
  }
});

// Track which tabs have already sent a request (prevent duplicate sends from multiple frames)
const tabsSending = new Set();

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender) => {
  const tabId = sender.tab?.id;

  if (message.error) {
    setBadge('ERR', '#cc0000', tabId);
    console.error('Content script error:', message.error);
    return;
  }

  // Prevent duplicate sends from multiple frames
  if (tabsSending.has(tabId)) return;

  if (message.type === 'transcript') {
    tabsSending.add(tabId);
    sendToServer(message.data, '/summarize', tabId).finally(() => tabsSending.delete(tabId));
  } else if (message.type === 'expert-transcript') {
    tabsSending.add(tabId);
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
