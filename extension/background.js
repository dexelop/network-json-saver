// Background script for Network JSON Saver

let attachedTabs = new Set(); // Set of tabIds
let pendingRequests = new Map(); // requestId -> { url, timestamp }

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

// Service Worker 시작 시 녹화 상태 복원 (Extension 재로드/Chrome 재시작 대응)
chrome.runtime.onStartup.addListener(async () => {
  console.log('[Service Worker] Starting up...');
  const settings = await chrome.storage.local.get(['isRecording']);
  if (settings.isRecording) {
    console.log('[Service Worker] Restoring recording state...');
    startRecording();
  }
});

// Service Worker가 깨어날 때도 상태 복원 시도
(async function initOnWakeup() {
  const settings = await chrome.storage.local.get(['isRecording']);
  if (settings.isRecording && attachedTabs.size === 0) {
    console.log('[Service Worker] Waking up - restoring recording state...');
    startRecording();
  }
})();

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

// Tab 활성화 시 attach 상태 확인 및 재연결
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const settings = await chrome.storage.local.get(['isRecording', 'whitelist']);
  if (!settings.isRecording) return;

  const tabId = activeInfo.tabId;

  // 이미 attach되어 있으면 스킵
  if (attachedTabs.has(tabId)) return;

  // Attach 시도
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab && tab.url) {
      console.log(`[Tab Activated] Tab ${tabId} not attached - attempting attach...`);
      checkAndAttach(tabId, tab.url, settings.whitelist);
    }
  } catch (err) {
    // Tab이 이미 닫혔거나 접근 불가
    console.log(`[Tab Activated] Cannot access tab ${tabId}`);
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

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId;
  console.log(`[Detach] Debugger detached from tab ${tabId}, reason: ${reason}`);
  attachedTabs.delete(tabId);

  // 녹화 중이면 자동 재연결 시도
  const settings = await chrome.storage.local.get(['isRecording']);
  if (settings.isRecording) {
    // 사용자가 DevTools를 열었을 경우는 재연결하지 않음 (충돌 방지)
    if (reason === 'target_closed' || reason === 'canceled_by_user') {
      console.log(`[Detach] Tab closed or user canceled - skipping re-attach`);
      return;
    }

    // Tab이 여전히 존재하는지 확인
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab && tab.url) {
        console.log(`[Re-attach] Attempting to re-attach to tab ${tabId}...`);
        // 짧은 딜레이 후 재연결 (안정성)
        setTimeout(async () => {
          try {
            await chrome.debugger.attach({ tabId: tabId }, '1.3');
            await chrome.debugger.sendCommand({ tabId: tabId }, 'Network.enable');
            attachedTabs.add(tabId);
            console.log(`[Re-attach] Successfully re-attached to tab ${tabId}`);
          } catch (err) {
            console.error(`[Re-attach] Failed to re-attach to tab ${tabId}:`, err.message);
          }
        }, 500);
      }
    } catch (err) {
      // Tab이 닫힌 경우 - 정상
      console.log(`[Detach] Tab ${tabId} no longer exists`);
    }
  }
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

    // CRITICAL FIX: Add to queue IMMEDIATELY to avoid race condition
    // (loadingFinished can arrive before async filter check completes)
    console.log(`[Queue] Request queued: ${requestId} (pre-filter)`);
    pendingRequests.set(requestId, {
      url: url,
      timestamp: new Date()
    });

    // Now do async filter checks and remove from queue if needed
    const settings = await chrome.storage.local.get(['whitelist', 'blacklist', 'smartFilter']);

    // Smart Filter (Noise reduction)
    if (settings.smartFilter) {
      const noiseKeywords = ['notification', 'notice', 'log', 'menu', 'alarm', 'event', 'track', 'analytics'];
      const hit = noiseKeywords.some(k => url.toLowerCase().includes(k));
      if (hit) {
        console.log(`[Skip] Smart Filter hit: ${url}`);
        pendingRequests.delete(requestId);
        return;
      }
    }

    // Blacklist check
    if (settings.blacklist && settings.blacklist.length > 0) {
      const hit = settings.blacklist.some(b => url.includes(b));
      if (hit) {
        console.log(`[Skip] Blacklist hit: ${url}`);
        pendingRequests.delete(requestId);
        return;
      }
    }

    console.log(`[Queue] Request ${requestId} passed filters: ${url}`);

  } else if (method === 'Network.loadingFinished') {
    const { requestId } = params;
    console.log(`[LoadingFinished] Request ${requestId} finished`);
    const reqInfo = pendingRequests.get(requestId);

    if (reqInfo) {
      console.log(`[LoadingFinished] Found in pending: ${reqInfo.url}`);
      pendingRequests.delete(requestId);

      try {
        console.log(`[LoadingFinished] Fetching body for: ${reqInfo.url}`);
        const result = await chrome.debugger.sendCommand(
          { tabId: source.tabId },
          'Network.getResponseBody',
          { requestId }
        );

        if (result.body) {
          console.log(`[Process] Body received from tab ${source.tabId}, size: ${result.body.length} bytes`);
          processCapturedData(reqInfo.url, result.body, reqInfo.timestamp);
        } else {
          console.warn(`[LoadingFinished] No body in result for: ${reqInfo.url}`);
        }
      } catch (err) {
        // Ignore "No resource with given identifier found" error (common for redirects/cached/preflight)
        if (err.message.includes('No resource with given identifier found') || err.code === -32000) {
          console.log(`[Debug] Skipped body fetch for ${reqInfo.url} (Resource unavailable - likely cached/redirected)`);
        } else {
          console.error(`[Error] Failed to get body for ${reqInfo.url}:`, err);
        }
      }
    } else {
      console.log(`[LoadingFinished] Request ${requestId} not found in pending queue (probably filtered out earlier)`);
    }
  }
}

async function processCapturedData(url, body, timestamp) {
  console.log(`[ProcessData] Processing: ${url}`);
  const settings = await chrome.storage.local.get(['mode', 'filenamePrefix', 'capturedRequests', 'whitelist']);
  console.log(`[ProcessData] Mode: ${settings.mode}, Whitelist:`, settings.whitelist);

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
  console.log(`[ProcessData] isWhitelisted: ${isWhitelisted}`);

  const isAuto = settings.mode === 'auto';

  // Logic:
  // 1. Auto Mode: Download all (Blacklist already filtered out in onDebuggerEvent)
  // 2. Manual Mode:
  //    - Whitelisted -> Download immediately (Don't add to list)
  //    - New items (not whitelisted, not blacklisted) -> Add to list for review

  if (isAuto) {
    // Auto 모드: Blacklist 아닌 모든 것 다운로드
    console.log(`[Download] Auto mode - downloading: ${url}`);
    downloadFile(url, jsonContent, timestamp, settings.filenamePrefix);
  } else {
    // Manual 모드
    if (isWhitelisted) {
      // Whitelist는 자동 다운로드 (목록 추가 안 함)
      console.log(`[Download] Manual mode + Whitelisted - downloading: ${url}`);
      downloadFile(url, jsonContent, timestamp, settings.filenamePrefix);
    } else {
      console.log(`[List] Manual mode + Not whitelisted - adding to list: ${url}`);
      // 새로운 것은 목록에 추가 (Blacklist는 이미 앞단에서 필터링됨)
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
}

function downloadFile(url, content, timestamp, prefix) {
  console.log(`[DownloadFile] Starting download for: ${url}`);
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
    console.log(`[DownloadFile] Calling chrome.downloads.download for: ${filename}`);
    chrome.downloads.download({
      url: reader.result,
      filename: filename,
      saveAs: false
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error(`[DownloadFile] Failed to download ${filename}:`, chrome.runtime.lastError);
      } else {
        console.log(`[DownloadFile] Successfully initiated download: ${filename} (ID: ${downloadId})`);
      }
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
