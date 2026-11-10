// background.js - Service Worker

// 监听扩展安装
chrome.runtime.onInstalled.addListener((details) => {
  // install/update lifecycle — no action needed
});

// 监听消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  // Only the extension popup may invoke downloads or access local settings.
  if (sender?.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) {
    sendResponse({success: false, error: 'Unauthorized sender'});
    return false;
  }
  try {
    if (message.action === 'downloadFile') {
      const blobPrefix = 'blob:' + chrome.runtime.getURL('');
      if (typeof message.url !== 'string' || !message.url.startsWith(blobPrefix) || message.url === blobPrefix ||
          typeof message.filename !== 'string' || !message.filename.trim() || /^\.{1,2}$/.test(message.filename) ||
          /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(message.filename)) {
        sendResponse({success: false, error: 'Invalid download request'});
        return false;
      }
      chrome.downloads.download({
        url: message.url,
        filename: message.filename,
        saveAs: false
      }, (downloadId) => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true, downloadId: downloadId });
        }
      });
      return true; // 保持消息通道开放
    }

    if (message.action === 'getStorage') {
      chrome.storage.local.get(message.keys, (result) => {
        if (chrome.runtime.lastError) {
          sendResponse({success: false, error: chrome.runtime.lastError.message});
        } else {
          sendResponse({ success: true, data: result });
        }
      });
      return true;
    }

    if (message.action === 'setStorage') {
      chrome.storage.local.set(message.data, () => {
        if (chrome.runtime.lastError) {
          sendResponse({ success: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ success: true });
        }
      });
      return true;
    }
  } catch (error) {
    sendResponse({success: false, error: error.message});
  }
  return false;
});

// 监听下载完成事件
chrome.downloads.onChanged.addListener((_delta) => {
  // download state change — no action needed
});
