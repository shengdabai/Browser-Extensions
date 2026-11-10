// Background Service Worker - 处理下载请求和其他消息

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;
  // Content scripts must not be able to invoke the privileged download API.
  if (message.action === 'downloadFile') {
    if (sender?.id !== chrome.runtime.id || sender.tab || sender.url !== chrome.runtime.getURL('popup.html')) {
      sendResponse({success: false, error: 'Unauthorized sender'});
      return false;
    }
    const blobPrefix = 'blob:' + chrome.runtime.getURL('');
    if (typeof message.url !== 'string' || !message.url.startsWith(blobPrefix) || message.url === blobPrefix ||
        typeof message.filename !== 'string' || !message.filename.trim() || /^\.{1,2}$/.test(message.filename) ||
        /[<>:"/\\|?*\u0000-\u001f\u007f]/.test(message.filename)) {
      sendResponse({success: false, error: 'Invalid download request'});
      return false;
    }
    try {
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
      return true;
    } catch (error) {
      sendResponse({success: false, error: error.message});
      return false;
    }
  }
  
  if (message.action === 'openPopup') {
    // 尝试打开 popup（实际上 content script 无法直接打开 popup）
    // 这里只是返回一个响应，提示用户手动点击
    sendResponse({ success: false, message: '请手动点击扩展图标' });
    return true;
  }
});

