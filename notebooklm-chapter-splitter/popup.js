// popup.js - 主界面逻辑

let selectedFile = null;
let chapters = [];
let selectionVersion = 0;

function releaseChapterFiles() {
  for (const file of window._chapterFiles || []) URL.revokeObjectURL(file.url);
  window._chapterFiles = null;
}

document.getElementById('selectFileBtn').addEventListener('click', () => {
  document.getElementById('fileInput').click();
});

document.getElementById('fileInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  await loadSelectedFile(file);
});

document.getElementById('autoDetectChapters').addEventListener('change', async () => {
  if (selectedFile) await loadSelectedFile(selectedFile);
});

async function loadSelectedFile(file) {
  const version = ++selectionVersion;
  selectedFile = file;
  chapters = [];
  releaseChapterFiles();
  document.getElementById('downloadAllBtn').disabled = true;
  document.getElementById('chapterPreview').style.display = 'none';
  document.getElementById('progress').style.display = 'none';
  const fileInfo = document.getElementById('fileInfo');
  fileInfo.textContent = `文件名：${file.name} | 大小：${(file.size / 1024 / 1024).toFixed(2)} MB | 类型：${file.type || file.name.split('.').pop().toUpperCase()}`;

  showStatus('正在解析文件...', 'info');
  document.getElementById('splitBtn').disabled = true;

  try {
    // 解析文件并检测章节
    const parsedChapters = await parseFileAndDetectChapters(file);
    if (version !== selectionVersion) return;
    chapters = parsedChapters;
    
    if (chapters.length > 0) {
      displayChapters(chapters);
      document.getElementById('splitBtn').disabled = false;
      showStatus(`成功检测到 ${chapters.length} 个章节`, 'success');
    } else {
      showStatus('未提取到可拆分的内容，请检查文件或转换格式', 'error');
    }
  } catch (error) {
    if (version !== selectionVersion) return;
    showStatus('解析文件失败: ' + error.message, 'error');
  }
}

document.getElementById('splitBtn').addEventListener('click', async () => {
  if (!selectedFile || chapters.length === 0) {
    showStatus('请先选择文件', 'error');
    return;
  }
  // A new split also invalidates downloads queued for an earlier split.
  const version = ++selectionVersion;

  const progressDiv = document.getElementById('progress');
  const progressBar = progressDiv.querySelector('.progress-bar');
  const progressText = progressDiv.querySelector('.progress-text');
  
  progressDiv.style.display = 'block';
  document.getElementById('splitBtn').disabled = true;
  document.getElementById('downloadAllBtn').disabled = true;

  try {
    // 拆分章节并准备下载
    releaseChapterFiles();
    const chapterFiles = [];

    for (let i = 0; i < chapters.length; i++) {
      const chapter = chapters[i];
      progressText.textContent = `正在处理第 ${i + 1}/${chapters.length} 章: ${chapter.title}`;
      progressBar.style.width = `${((i + 1) / chapters.length) * 100}%`;
      
      const chapterText = chapter.content;
      const blob = new Blob([chapterText], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      
      chapterFiles.push({
        url,
        filename: sanitizeFilename((document.getElementById('includeChapterNumbers').checked ? `${i + 1}. ` : '') + chapter.title) + '.txt',
        title: chapter.title
      });
    }

    window._chapterFiles = chapterFiles;
    
    progressText.textContent = '拆分完成！';
    document.getElementById('downloadAllBtn').disabled = false;
    showStatus(`成功拆分 ${chapters.length} 个章节`, 'success');
    
    setTimeout(() => {
      if (version === selectionVersion) downloadAllChapters(chapterFiles);
    }, 500);
    
  } catch (error) {
    showStatus('拆分失败: ' + error.message, 'error');
  } finally {
    document.getElementById('splitBtn').disabled = false;
  }
});

document.getElementById('downloadAllBtn').addEventListener('click', async () => {
  if (window._chapterFiles) {
    downloadAllChapters(window._chapterFiles);
  }
});

function displayChapters(chapters) {
  const chapterList = document.getElementById('chapterList');
  const preview = document.getElementById('chapterPreview');
  
  chapterList.innerHTML = '';
  chapters.forEach((chapter, index) => {
    const item = document.createElement('div');
    item.className = 'chapter-item';
    item.textContent = `${index + 1}. ${chapter.title} (${chapter.content.length} 字符)`;
    chapterList.appendChild(item);
  });
  
  preview.style.display = 'block';
}

async function parseFileAndDetectChapters(file) {
  const fileExtension = file.name.split('.').pop().toLowerCase();
  const options = {autoDetect: document.getElementById('autoDetectChapters').checked};
  
  switch (fileExtension) {
    case 'pdf':
      return await parsePDF(file, options);
    case 'epub':
      return await parseEPUB(file, options);
    case 'mobi':
    case 'azw3':
      return await parseMOBI(file, options);
    default:
      throw new Error('不支持的文件格式');
  }
}

function sanitizeFilename(filename) {
  // 清理文件名，移除非法字符
  return filename
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100);
}

function showStatus(message, type = 'info') {
  const statusDiv = document.getElementById('status');
  statusDiv.textContent = message;
  statusDiv.className = `status ${type}`;
}

async function downloadAllChapters(chapterFiles) {
  const version = selectionVersion;
  let successCount = 0;
  let failCount = 0;
  for (let i = 0; i < chapterFiles.length; i++) {
    if (version !== selectionVersion) break;
    const file = chapterFiles[i];
    try {
      await chrome.downloads.download({
        url: file.url,
        filename: file.filename,
        saveAs: false
      });
      successCount++;
      // 添加小延迟避免浏览器限制
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      failCount++;
    }
  }
  
  if (version !== selectionVersion) return;
  if (failCount > 0) {
    showStatus(`下载请求：成功 ${successCount} 个，失败 ${failCount} 个，请检查浏览器下载记录后重试`, 'error');
  } else {
    showStatus(`已开始下载 ${successCount} 个章节文件`, 'success');
  }
}

