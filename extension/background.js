// Background script for Network JSON Saver

let attachedTabs = new Set(); // Set of tabIds
let pendingRequests = new Map(); // requestId -> { url, timestamp }

// Initialize default settings
// Initialize default settings
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['isRecording', 'mode', 'smartFilter', 'whitelist', 'blacklist', 'filenamePrefix', 'capturedRequests'], (result) => {
    const defaults = {
      isRecording: false,
      mode: 'auto',
      smartFilter: true,
      whitelist: ['wehago'],
      blacklist: [],
      filenamePrefix: '',
      capturedRequests: []
    };

    const settingsToSet = {};
    Object.keys(defaults).forEach(key => {
      if (result[key] === undefined) {
        settingsToSet[key] = defaults[key];
      }
    });

    if (Object.keys(settingsToSet).length > 0) {
      chrome.storage.local.set(settingsToSet);
    }
  });
});

// Listen for storage changes to toggle recording
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.isRecording) {
    if (changes.isRecording.newValue) {
      startRecording();
    } else {
      stopRecording();
    }
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'downloadAll') {
    downloadAll();
  } else if (message.action === 'downloadOne') {
    downloadOne(message.index);
  } else if (message.action === 'clearList') {
    chrome.storage.local.set({ capturedRequests: [] });
  } else if (message.action === 'blockUrl') {
    handleBlockUrl(message.url);
  } else if (message.action === 'allowUrl') {
    handleAllowUrl(message.url, message.memo);
  } else if (message.action === 'getRecordingStatus') {
    sendResponse({ isRecording: attachedTabs.size > 0 });
    return true; // Required for async sendResponse
  }
});

async function handleBlockUrl(url) {
  const settings = await chrome.storage.local.get(['blacklist', 'capturedRequests']);
  let blacklist = settings.blacklist || [];
  let capturedRequests = settings.capturedRequests || [];

  try {
    const urlObj = new URL(url);
    const keyword = urlObj.pathname;

    // Add to blacklist if not exists
    if (!blacklist.includes(keyword)) {
      blacklist.push(keyword);
    }

    // Remove from captured list
    const initialLen = capturedRequests.length;
    capturedRequests = capturedRequests.filter(req => !req.url.includes(keyword));

    await chrome.storage.local.set({ blacklist, capturedRequests });

    // Notify popup
    chrome.runtime.sendMessage({ action: 'updateList', data: capturedRequests }).catch(() => { });

    // If list changed, we might want to notify about blacklist update too,
    // but popup reloads settings on focus/init usually.
    // We can force a reload of tags if needed, but let's rely on popup refreshing.
  } catch (e) {
    console.error('Block URL failed:', e);
  }
}

async function handleAllowUrl(url, memo) {
  const settings = await chrome.storage.local.get(['whitelist', 'capturedRequests']);
  let whitelist = settings.whitelist || [];
  let capturedRequests = settings.capturedRequests || [];

  try {
    const urlObj = new URL(url);
    const keyword = urlObj.pathname;

    // Add to whitelist if not exists
    const exists = whitelist.some(w => {
      const k = typeof w === 'string' ? w : w.keyword;
      return k === keyword;
    });

    if (!exists) {
      whitelist.push({ keyword, memo: memo || '' });
    }

    // Remove from captured list
    capturedRequests = capturedRequests.filter(req => !req.url.includes(keyword));

    await chrome.storage.local.set({ whitelist, capturedRequests });
    chrome.runtime.sendMessage({ action: 'updateList', data: capturedRequests }).catch(() => { });
  } catch (e) {
    console.error('Allow URL failed:', e);
  }
}

// Auto-attach on navigation if recording is on
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const settings = await chrome.storage.local.get(['isRecording', 'whitelist']);
  if (!settings.isRecording) return;

  if (changeInfo.status === 'loading' && tab.url) {
    checkAndAttach(tabId, tab.url, settings.whitelist);
  }
});

async function startRecording() {
  const settings = await chrome.storage.local.get(['whitelist']);
  const tabs = await chrome.tabs.query({});

  // Attach to all matching tabs initially
  for (const tab of tabs) {
    if (tab.url) {
      checkAndAttach(tab.id, tab.url, settings.whitelist);
    }
  }
}

async function stopRecording() {
  for (const tabId of attachedTabs) {
    try {
      await chrome.debugger.detach({ tabId: tabId });
    } catch (err) {
      // Ignore
    }
  }
  attachedTabs.clear();
  pendingRequests.clear();
}

async function checkAndAttach(tabId, url, whitelist) {
  // Always attach when recording to allow capturing non-whitelisted requests for discovery
  let shouldAttach = true;

  if (shouldAttach) {
    if (!attachedTabs.has(tabId)) {
      try {
        await chrome.debugger.attach({ tabId: tabId }, '1.3');
        await chrome.debugger.sendCommand({ tabId: tabId }, 'Network.enable');
        attachedTabs.add(tabId);
        console.log(`[Auto-Attach] Attached to tab ${tabId} (${url})`);
      } catch (err) {
        if (!err.message.includes('Already attached')) {
          console.error(`[Error] Failed to attach to ${tabId}:`, err);
        } else {
          attachedTabs.add(tabId); // Mark as attached if already so
        }
      }
    }
  } else {
    if (attachedTabs.has(tabId)) {
      try {
        await chrome.debugger.detach({ tabId: tabId });
        attachedTabs.delete(tabId);
        console.log(`[Auto-Detach] Detached from tab ${tabId} (URL mismatch)`);
      } catch (err) {
        // Ignore
      }
    }
  }
}

chrome.debugger.onEvent.addListener(onDebuggerEvent);
chrome.debugger.onDetach.addListener(onDebuggerDetach);

function onDebuggerDetach(source, reason) {
  console.log(`Debugger detached from ${source.tabId}:`, reason);
  attachedTabs.delete(source.tabId);
}

async function onDebuggerEvent(source, method, params) {
  if (method === 'Network.responseReceived') {
    const { requestId, response } = params;
    const url = response.url;

    // Filter by MIME type (JSON only)
    if (!response.mimeType.includes('json')) return;

    // Check status code (Skip redirects, empty responses)
    if (response.status >= 300 && response.status < 400) return; // Redirects
    if (response.status === 204 || response.status === 205) return; // No Content

    // Check filters
    const settings = await chrome.storage.local.get(['whitelist', 'blacklist', 'smartFilter']);

    // Smart Filter (Noise reduction)
    if (settings.smartFilter) {
      const noiseKeywords = ['notification', 'notice', 'log', 'menu', 'alarm', 'event', 'track', 'analytics'];
      const hit = noiseKeywords.some(k => url.toLowerCase().includes(k));
      if (hit) {
        console.log(`[Skip] Smart Filter hit: ${url}`);
        return;
      }
    }

    // Whitelist check removed here to allow discovery in list.
    // Filtering is now done in processCapturedData.

    // Blacklist check
    if (settings.blacklist && settings.blacklist.length > 0) {
      const hit = settings.blacklist.some(b => url.includes(b));
      if (hit) {
        console.log(`[Skip] Blacklist hit: ${url}`);
        return;
      }
    }

    console.log(`[Queue] Request queued: ${requestId}`);
    pendingRequests.set(requestId, {
      url: url,
      timestamp: new Date()
    });

  } else if (method === 'Network.loadingFinished') {
    const { requestId } = params;
    const reqInfo = pendingRequests.get(requestId);

    if (reqInfo) {
      pendingRequests.delete(requestId);

      try {
        const result = await chrome.debugger.sendCommand(
          { tabId: source.tabId },
          'Network.getResponseBody',
          { requestId }
        );

        if (result.body) {
          console.log(`[Process] Body received from tab ${source.tabId}`);
          processCapturedData(reqInfo.url, result.body, reqInfo.timestamp);
        }
      } catch (err) {
        // Ignore "No resource with given identifier found" error (common for redirects/cached/preflight)
        if (err.message.includes('No resource with given identifier found') || err.code === -32000) {
          console.log(`[Debug] Skipped body fetch for ${reqInfo.url} (Resource unavailable)`);
        } else {
          console.error(`[Error] Failed to get body:`, err);
        }
      }
    }
  }
}

async function processCapturedData(url, body, timestamp) {
  const settings = await chrome.storage.local.get(['mode', 'filenamePrefix', 'capturedRequests', 'whitelist']);

  let jsonContent = body;
  try {
    const parsed = JSON.parse(body);
    jsonContent = JSON.stringify(parsed, null, 2);
  } catch (e) {
    // Keep original
  }

  // Check Whitelist
  let isWhitelisted = false;
  if (settings.whitelist && settings.whitelist.length > 0) {
    isWhitelisted = settings.whitelist.some(w => {
      const keyword = typeof w === 'string' ? w : w.keyword;
      return url.includes(keyword);
    });
  }

  const isAuto = settings.mode === 'auto';

  // Logic:
  // 1. If Auto Mode AND Whitelisted -> Download immediately (Don't add to list)
  // 2. If Manual Mode OR Not Whitelisted -> Add to list (for review/discovery)

  if (isAuto && isWhitelisted) {
    downloadFile(url, jsonContent, timestamp, settings.filenamePrefix);
  } else {
    // Calculate size
    const sizeBytes = new Blob([jsonContent]).size;
    let sizeDisplay = sizeBytes + ' B';
    if (sizeBytes > 1024) {
      sizeDisplay = (sizeBytes / 1024).toFixed(1) + ' KB';
    }

    const newRequest = {
      url: url,
      content: jsonContent,
      timestamp: timestamp.toISOString(),
      autoSaved: false,
      size: sizeDisplay
    };

    let updatedList = [...(settings.capturedRequests || []), newRequest];

    // Limit list size (reduce from 50 to 20 to save space)
    const MAX_ITEMS = 20;
    if (updatedList.length > MAX_ITEMS) {
      updatedList = updatedList.slice(updatedList.length - MAX_ITEMS);
    }

    try {
      await chrome.storage.local.set({ capturedRequests: updatedList });
      chrome.runtime.sendMessage({ action: 'updateList', data: updatedList }).catch(() => {
        // Ignore error if popup is closed
      });
    } catch (err) {
      if (err.message.includes('Quota exceeded')) {
        console.warn('[Storage] Quota exceeded. Trimming list...');
        // Emergency trim: keep only last 5 items
        updatedList = updatedList.slice(updatedList.length - 5);
        try {
          await chrome.storage.local.set({ capturedRequests: updatedList });
          chrome.runtime.sendMessage({ action: 'updateList', data: updatedList }).catch(() => { });
        } catch (retryErr) {
          console.error('[Storage] Critical: Failed to save even after trimming.', retryErr);
          // If still failing, clear list to restore functionality
          await chrome.storage.local.set({ capturedRequests: [] });
        }
      } else {
        console.error('[Storage] Save failed:', err);
      }
    }
  }
}

function downloadFile(url, content, timestamp, prefix) {
  // Filename generation
  const date = new Date(timestamp);
  const dateStr = date.getFullYear() +
    String(date.getMonth() + 1).padStart(2, '0') +
    String(date.getDate()).padStart(2, '0') + '_' +
    String(date.getHours()).padStart(2, '0') +
    String(date.getMinutes()).padStart(2, '0') +
    String(date.getSeconds()).padStart(2, '0') + '_' +
    String(date.getMilliseconds()).padStart(3, '0');

  // Extract meaningful part from URL (start of path, max 10 chars)
  let urlSlug = 'unknown';
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname; // e.g. /api/user/list
    // Remove leading slash and replace slashes with underscores
    let cleanPath = pathname.replace(/^\//, '').replace(/\//g, '_');
    // Take first 10 chars
    urlSlug = cleanPath.substring(0, 10);
  } catch (e) {
    urlSlug = 'url';
  }

  // Sanitize
  urlSlug = urlSlug.replace(/[^a-zA-Z0-9-_]/g, '');

  let filename = `${dateStr}_${urlSlug}.json`;
  if (prefix) {
    filename = `${prefix}_${filename}`;
  }

  const blob = new Blob([content], { type: 'application/json' });
  const reader = new FileReader();
  reader.onload = function () {
    chrome.downloads.download({
      url: reader.result,
      filename: filename,
      saveAs: false
    });
  };
  reader.readAsDataURL(blob);
}

async function downloadOne(index) {
  const settings = await chrome.storage.local.get(['capturedRequests', 'filenamePrefix']);
  const req = settings.capturedRequests[index];
  if (req) {
    downloadFile(req.url, req.content, new Date(req.timestamp), settings.filenamePrefix);
  }
}

async function downloadAll() {
  const settings = await chrome.storage.local.get(['capturedRequests', 'filenamePrefix']);
  if (settings.capturedRequests) {
    for (const req of settings.capturedRequests) {
      downloadFile(req.url, req.content, new Date(req.timestamp), settings.filenamePrefix);
    }
  }
}
