// 文件处理逻辑 - 在 popup 中使用

// 加载本地库的辅助函数
async function loadLibrary(src, checkFunc, name) {
  if (checkFunc()) return;

  const script = document.createElement('script');
  script.src = src;

  await new Promise((resolve, reject) => {
    script.onload = () => {
      if (checkFunc()) {
        resolve();
      } else {
        reject(new Error(`${name} 加载后初始化失败`));
      }
    };
    script.onerror = () => reject(new Error(`无法加载 ${name}，请确保扩展文件完整`));
    document.head.appendChild(script);
  });
}

// 处理 PDF 文件
async function processPDF(fileData, options) {
  // 加载本地 pdf.js
  await loadLibrary(
    'libs/pdf.min.js',
    () => typeof pdfjsLib !== 'undefined',
    'PDF.js'
  );

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';

  // Disable PDF.js dynamic code generation (CVE-2024-4367 workaround).
  const loadingTask = pdfjsLib.getDocument({ data: fileData, isEvalSupported: false });
  try {
    const pdf = await loadingTask.promise;

    let fullText = '';
  
    // 提取所有页面的文本
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = pdfPageText(textContent.items);
      fullText += pageText + '\n';
    }

    return splitIntoChapters(fullText, options);
  } finally {
    await loadingTask.destroy();
  }
}

// Clear equivalents from Unicode EquivalentUnifiedIdeograph.txt:
// https://www.unicode.org/Public/UCD/latest/ucd/EquivalentUnifiedIdeograph.txt
const pdfSupplementRadicals = Object.freeze({
  '⻓': '长', '⻔': '门', '⻅': '见', '⻛': '风', '⻢': '马', '⻆': '角',
  '⻜': '飞', '⻦': '鸟', '⻥': '鱼', '⻰': '龙', '⻩': '黄', '⻝': '食',
  '⻋': '车', '⻉': '贝', '⻚': '页', '⻮': '齿', '⻨': '麦'
});

function pdfPageText(items) {
  const textItems = items.filter(item => typeof item.str === 'string' && (item.str || item.hasEOL)).map(item => ({
    ...item, str: item.str.replace(/[⺀-⿟]/g, c => pdfSupplementRadicals[c] || c.normalize('NFKC'))
  }));
  return textItems.map((item, i) => {
    if (item.hasEOL) return item.str + '\n';
    const next = textItems[i + 1];
    // Keep Han, radicals and Chinese punctuation together without changing punctuation.
    const adjacentHan = next && /[\u3400-\u9fff\u2e80-\u2fdf\u3000-\u303f\uff00-\uffef\u2014\u2018\u2019\u201c\u201d\u2026]$/.test(item.str)
      && /^[\u3400-\u9fff\u2e80-\u2fdf\u3000-\u303f\uff00-\uffef\u2014\u2018\u2019\u201c\u201d\u2026:]/.test(next.str);
    return item.str + (next && next.str && item.str && !adjacentHan ? ' ' : '');
  }).join('');
}

function resolveEPUBPath(base, href, decode = true) {
  if (!href) throw new Error('EPUB 章节路径为空');
  let relative = href.split(/[?#]/)[0];
  if (decode) {
    try { relative = decodeURIComponent(relative); }
    catch { /* Malformed percent escapes may be literal ZIP filenames; use the raw path. */ }
  }
  if (!relative || /^[\\/]|^[a-z][a-z\d+.-]*:/i.test(relative) || /[\\\0]/.test(relative)) {
    throw new Error('EPUB 章节路径必须位于书籍内');
  }
  const parts = base.split('/').filter(Boolean);
  for (const part of relative.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) throw new Error('EPUB 章节路径超出书籍范围');
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/');
}

// 处理 EPUB 文件
async function processEPUB(fileData, options) {
  // 使用 JSZip 解压 EPUB（EPUB 是 ZIP 格式）
  await loadLibrary(
    'libs/jszip.min.js',
    () => typeof JSZip !== 'undefined',
    'JSZip'
  );

  const zip = await JSZip.loadAsync(fileData);

  // 读取 OPF 文件以获取章节信息
  let opfContent = null;
  let opfPath = null;

  // 查找 .opf 文件
  for (const fileName in zip.files) {
    if (fileName.endsWith('.opf')) {
      opfPath = fileName.substring(0, fileName.lastIndexOf('/') + 1);
      opfContent = await zip.files[fileName].async('text');
      break;
    }
  }

  if (!opfContent) {
    throw new Error('无法找到 EPUB 的 OPF 文件');
  }

  // 解析 OPF 获取章节列表
  const parser = new DOMParser();
  const opfDoc = parser.parseFromString(opfContent, 'text/xml');
  const manifestItems = opfDoc.querySelectorAll('manifest item');
  const spineItems = opfDoc.querySelectorAll('spine itemref');

  let fullText = '';

  // 按 spine 顺序读取章节
  for (const spineItem of spineItems) {
    const idref = spineItem.getAttribute('idref');
    const manifestItem = Array.from(manifestItems).find(item => item.getAttribute('id') === idref);
    
    if (!manifestItem) {
      console.warn('跳过 EPUB 章节：章节引用无效');
      continue;
    }
    try {
      const href = manifestItem.getAttribute('href');
      const filePath = resolveEPUBPath(opfPath, href);
      const chapterFile = zip.files[filePath] || zip.files[resolveEPUBPath(opfPath, href, false)];
      if (!chapterFile) {
        console.warn('跳过 EPUB 章节：章节文件缺失');
        continue;
      }
      
      const content = await chapterFile.async('text');
      const htmlDoc = parser.parseFromString(content, 'text/html');
      htmlDoc.querySelectorAll('script, style, noscript').forEach(node => node.remove());
      htmlDoc.querySelectorAll('h1, h2, h3, h4, h5, h6, p, div, section, article, li, blockquote, pre, br, tr')
        .forEach(node => node.append('\n'));
      const text = htmlDoc.body.textContent || htmlDoc.body.innerText || '';

      // 尝试提取章节标题
      const titleElement = htmlDoc.querySelector('h1, h2, .chapter-title, [class*="chapter"]');
      const title = titleElement ? titleElement.textContent.trim() : '';

      if (title && !text.trimStart().startsWith(title)) {
        fullText += `\n\n${title}\n\n${text}\n\n`;
      } else {
        fullText += `\n\n${text}\n\n`;
      }
    } catch {
      console.warn('跳过 EPUB 章节：路径无效或内容无法读取');
    }
  }

  return splitIntoChapters(fullText, options);
}

// 处理 MOBI 文件
async function processMOBI(fileData, options) {
  // MOBI 文件格式较复杂，这里提供一个基础实现
  // 注意：完整的 MOBI 解析需要专门的库，这里使用简化方法
  
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';
  
  // 尝试提取可读文本（MOBI 格式包含 HTML 内容）
  let htmlContent = '';
  
  // MOBI 文件通常包含 HTML 内容，查找 HTML 标签
  for (let i = 0; i < fileData.length - 100; i++) {
    const chunk = decoder.decode(fileData.slice(i, i + 100));
    if (chunk.includes('<html') || chunk.includes('<body')) {
      // 找到 HTML 开始位置
      let htmlStart = i;
      while (htmlStart > 0 && fileData[htmlStart] !== 0x3C) htmlStart--;
      
      // 尝试提取 HTML 内容
      const remaining = fileData.slice(htmlStart);
      htmlContent = decoder.decode(remaining);
      break;
    }
  }

  if (htmlContent) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(htmlContent, 'text/html');
    text = doc.body.textContent || doc.body.innerText || '';
  } else {
    // 如果无法解析 HTML，尝试直接解码
    text = decoder.decode(fileData);
    // 移除不可打印字符
    text = text.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ');
  }

  if (!text || text.trim().length < 100) {
    throw new Error('无法从 MOBI 文件中提取文本内容。建议先将 MOBI 转换为 EPUB 或 PDF 格式。');
  }

  return splitIntoChapters(text, options);
}

// 将文本拆分为章节
function splitIntoChapters(text, options) {
  if (!text.trim()) return [];
  const chapters = [];
  
  if (!options.autoDetect) {
    // 如果不自动检测，将整个文本作为一个章节
    return [{
      title: '完整内容',
      content: text.trim()
    }];
  }

  // 定义章节匹配模式
  let patterns = [];
  
  if (options.pattern === 'auto' || options.pattern === 'numbered') {
    patterns.push(
      /^第\s*[零一二三四五六七八九十百千万\d]+\s*章[：:\s]*(.+)?$/m,
      /^Chapter\s+[IVX\d]+\s*[：:]\s*(.+)$/mi,
      /^第\s*\d+\s*章[：:]\s*(.+)$/m
    );
  }
  
  if (options.pattern === 'auto' || options.pattern === 'chinese') {
    patterns.push(
      /^第[一二三四五六七八九十百千万]+章[：:]\s*(.+)$/m,
      /^[一二三四五六七八九十百千万]+、\s*(.+)$/m
    );
  }
  
  if (options.pattern === 'auto' || options.pattern === 'roman') {
    patterns.push(
      /^[IVX]+\.\s*(.+)$/m,
      /^Chapter\s+[IVX]+\s*[：:]\s*(.+)$/mi
    );
  }
  
  if (options.pattern === 'custom' && options.customPattern) {
    try {
      const regex = new RegExp(options.customPattern, 'm');
      patterns = [regex];
    } catch (e) {
      // invalid regex — fall through to default patterns
    }
  }

  // 如果没有任何模式匹配，使用默认模式
  if (patterns.length === 0) {
    patterns.push(
      /^第\s*[零一二三四五六七八九十百千万\d]+\s*章[：:]\s*(.+)$/m,
      /^Chapter\s+[IVX\d]+\s*[：:]\s*(.+)$/mi
    );
  }

  // 查找所有章节标题
  const lines = text.split('\n');
  const chapterStarts = [];
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        chapterStarts.push({
          index: i,
          title: match[1] || match[0],
          fullMatch: match[0]
        });
        break;
      }
    }
  }

  // 如果没有找到章节，将整个文本作为一个章节
  if (chapterStarts.length === 0) {
    return [{
      title: '完整内容',
      content: text.trim()
    }];
  }

  // 保留首个章节标题之前的序言或说明。
  const preface = lines.slice(0, chapterStarts[0].index).join('\n').trim();
  if (preface) {
    chapters.push({ title: '前言', content: preface });
  }

  // 根据章节标题拆分内容
  for (let i = 0; i < chapterStarts.length; i++) {
    const start = chapterStarts[i];
    const end = i < chapterStarts.length - 1 ? chapterStarts[i + 1].index : lines.length;

    // 目录中的连续标题没有正文，不生成独立章节。
    const body = lines.slice(start.index + 1, end).join('\n').trim();
    if (!body) continue;
    
    const chapterLines = lines.slice(start.index, end);
    const content = chapterLines.join('\n').trim();
    
    chapters.push({
      title: sanitizeTitle(start.title),
      content: content
    });
  }

  return chapters;
}

function sanitizeTitle(title) {
  return title
    .replace(/[<>:"/\\|?*]/g, '_')
    .trim()
    .substring(0, 100); // 限制标题长度
}

