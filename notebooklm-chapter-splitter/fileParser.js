// fileParser.js - 文件解析模块

async function loadPDFJS() {
  if (typeof pdfjsLib !== 'undefined') return;

  const script = document.createElement('script');
  script.src = 'libs/pdf.min.js';

  await new Promise((resolve, reject) => {
    script.onload = () => {
      if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'libs/pdf.worker.min.js';
        resolve();
      } else {
        reject(new Error('PDF.js 加载失败'));
      }
    };
    script.onerror = () => reject(new Error('无法加载 PDF.js，请确保扩展文件完整'));
    document.head.appendChild(script);
  });
}

async function loadJSZip() {
  if (typeof JSZip !== 'undefined') return;

  const script = document.createElement('script');
  script.src = 'libs/jszip.min.js';

  await new Promise((resolve, reject) => {
    script.onload = () => {
      if (typeof JSZip !== 'undefined') {
        resolve();
      } else {
        reject(new Error('JSZip 加载失败'));
      }
    };
    script.onerror = () => reject(new Error('无法加载 JSZip，请确保扩展文件完整'));
    document.head.appendChild(script);
  });
}

// 解析 PDF 文件
async function parsePDF(file, options = {}) {
  await loadPDFJS();

  const arrayBuffer = await file.arrayBuffer();
  // Disable PDF.js dynamic code generation (CVE-2024-4367 workaround).
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer, isEvalSupported: false });
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

    // 检测章节
    return detectChapters(fullText, options);
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

// 解析 EPUB 文件
async function parseEPUB(file, options = {}) {
  await loadJSZip();

  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // 查找 OPF 文件
  let opfContent = null;
  let opfPath = '';

  for (const filename in zip.files) {
    if (filename.endsWith('.opf')) {
      opfPath = filename.substring(0, filename.lastIndexOf('/') + 1);
      opfContent = await zip.files[filename].async('text');
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

  const chapters = [];
  let chapterIndex = 1;

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
      let title = titleElement ? titleElement.textContent.trim() : `章节 ${chapterIndex}`;

      if (text.trim()) {
        chapters.push({
          title: title,
          content: text.trim()
        });
        chapterIndex++;
      }
    } catch {
      console.warn('跳过 EPUB 章节：路径无效或内容无法读取');
    }
  }

  if (options.autoDetect === false) return detectChapters(chapters.map(c => c.content).join('\n\n'), options);
  return chapters.length > 0 ? chapters : detectChapters(chapters.map(c => c.content).join('\n\n'));
}

// 解析 MOBI 文件
async function parseMOBI(file, options = {}) {
  const arrayBuffer = await file.arrayBuffer();
  const uint8Array = new Uint8Array(arrayBuffer);

  // MOBI 格式较复杂，这里提供基础实现
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let text = '';

  // 尝试查找 HTML 内容
  for (let i = 0; i < uint8Array.length - 100; i++) {
    const chunk = decoder.decode(uint8Array.slice(i, i + 100));
    if (chunk.includes('<html') || chunk.includes('<body')) {
      let htmlStart = i;
      while (htmlStart > 0 && uint8Array[htmlStart] !== 0x3C) htmlStart--;

      const remaining = uint8Array.slice(htmlStart);
      text = decoder.decode(remaining);
      break;
    }
  }

  if (!text || text.trim().length < 100) {
    // 如果无法解析，尝试直接解码
    text = decoder.decode(uint8Array);
    text = text.replace(/[\x00-\x1F\x7F-\x9F]/g, ' ');
  }

  if (!text || text.trim().length < 100) {
    throw new Error('无法从 MOBI 文件中提取内容。建议先转换为 EPUB 或 PDF 格式。');
  }

  return detectChapters(text, options);
}

// 检测章节
function detectChapters(text, options = {}) {
  if (!text.trim()) return [];
  if (options.autoDetect === false) return [{title: '完整内容', content: text.trim()}];
  const chapters = [];

  // 章节检测模式（按优先级排序）
  const patterns = [
    /^第\s*[零一二三四五六七八九十百千万\d]+\s*章[：:\s]*(.+)?$/m,
    /^第\d+章[：:\s]*(.+)?$/m,
    /^Chapter\s+\d+[：:\s]*(.+)?$/im,
    /^[IVX]+\.\s*(.+)?$/m,
    /^(#{1,3})\s+(.+)$/m
  ];

  const lines = text.split('\n');
  const chapterStarts = [];

  // 查找所有章节标题
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        chapterStarts.push({
          index: i,
          title: (match[2] || match[1] || match[0]).trim(),
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

    if (content) {
      chapters.push({
        title: start.title,
        content: content
      });
    }
  }

  return chapters.length > 0 ? chapters : [{
    title: '完整内容',
    content: text.trim()
  }];
}
