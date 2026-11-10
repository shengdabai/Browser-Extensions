const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function load(file, globals = {}) {
  const context = vm.createContext(globals);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  return context;
}

const parsers = [
  ['notebooklm-chapter-splitter/fileParser.js', (ctx, text) => ctx.detectChapters(text)],
  ['book-splitter-extension/fileProcessor.js', (ctx, text) => ctx.splitIntoChapters(text, {autoDetect: true, pattern: 'auto'})]
];

for (const [file, split] of parsers) {
  test(`${file}: blank text produces no downloadable chapters`, () => {
    assert.equal(split(load(file), ' \n\t\n').length, 0);
  });

  test(`${file}: retains preface and short chapters in order`, () => {
    const text = '序言不可丢失\n\n第一章：开始\n短文\n第二章：结束\n尾声';
    const result = split(load(file), text);
    assert.equal(result.length, 3);
    assert.equal(result[0].title, '前言');
    assert.equal(result.map(c => c.content).join('\n\n'), text.replace('\n第二章', '\n\n第二章'));
  });

  test(`${file}: preserves text without headings`, () => {
    const text = '只有正文，没有章节标题。';
    assert.equal(split(load(file), text)[0].content, text);
  });

  test(`${file}: PDF TOC titles do not create empty chapters or duplicate filenames`, async () => {
    const lines = [
      '短序言', '目录',
      'Chapter 1: Topic1', ' ', 'Chapter 2: Topic2', '\t', 'Chapter 3: Topic3', '',
      'Chapter 1: Topic1', '短文一',
      'Chapter 2: Topic2', '短文二',
      'Chapter 3: Topic3', '短文三'
    ];
    const ctx = load(file, {pdfjsLib: {
      GlobalWorkerOptions: {},
      getDocument: () => ({destroy: async () => {}, promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({getTextContent: async () => ({
          items: lines.map(str => ({str, hasEOL: true}))
        })})
      })})
    }});
    const result = file.includes('fileParser')
      ? await ctx.parsePDF({arrayBuffer: async () => new ArrayBuffer(0)})
      : await ctx.processPDF(new Uint8Array(), {autoDetect: true, pattern: 'auto'});

    assert.equal(result.length, 4);
    assert.deepEqual(Array.from(result, c => c.title), ['前言', 'Topic1', 'Topic2', 'Topic3']);
    assert.equal(result[0].content, '短序言\n目录');
    assert.deepEqual(Array.from(result.slice(1), c => c.content), [
      'Chapter 1: Topic1\n短文一', 'Chapter 2: Topic2\n短文二', 'Chapter 3: Topic3\n短文三'
    ]);
    // These titles need no filename sanitization in either popup.
    const filenames = Array.from(result, c => `${c.title}.txt`);
    assert.equal(new Set(filenames).size, filenames.length);
    assert.equal(filenames[1], 'Topic1.txt');
  });

  test(`${file}: skips heading-only entries before and after real content without a preface`, () => {
    const text = 'Chapter 1: Topic1\n \nChapter 1: Topic1\n正文\nChapter 2: Topic2\n\t';
    const result = split(load(file), text);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Topic1');
    assert.equal(result[0].content, 'Chapter 1: Topic1\n正文');
  });

  test(`${file}: PDF extraction preserves line breaks for chapter detection`, async () => {
    const globals = {pdfjsLib: {
      GlobalWorkerOptions: {},
      getDocument: () => ({destroy: async () => {}, promise: Promise.resolve({
        numPages: 1,
        getPage: async () => ({getTextContent: async () => ({items: [
          {str: '第一章：开始', hasEOL: true},
          {str: '正文'.repeat(40), hasEOL: true},
          {str: '第二章：结束', hasEOL: true},
          {str: '末章'.repeat(40), hasEOL: true}
        ]})})
      })})
    }};
    const ctx = load(file, globals);
    const result = file.includes('fileParser')
      ? await ctx.parsePDF({arrayBuffer: async () => new ArrayBuffer(0)})
      : await ctx.processPDF(new Uint8Array(), {autoDetect: true, pattern: 'auto'});
    assert.equal(result.length, 2);
    assert.match(result[0].content, /开始\n正文/);
    assert.match(result[1].content, /结束\n末章/);
  });
}

test('Markdown chapter titles use heading text', () => {
  const result = load('notebooklm-chapter-splitter/fileParser.js').detectChapters('# 开始\n正文\n## 结束\n末章');
  assert.deepEqual(Array.from(result, c => c.title), ['开始', '结束']);
});

function popup(script = 'notebooklm-chapter-splitter/popup.js') {
  const elements = new Map();
  const alerts = [];
  function element() {
    return {style: {}, disabled: false, checked: true, textContent: '', innerHTML: '', listeners: {},
      addEventListener(event, callback) { this.listeners[event] = callback; },
      appendChild() {}, querySelector() { return element(); }};
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement: element
  };
  const ctx = load(script, {
    document, window: {}, Blob, alert: message => alerts.push(message), setTimeout: callback => callback(),
    URL: {createObjectURL: () => 'blob:test', revokeObjectURL() {}}, chrome: {runtime: {}, downloads: {download: async () => 1}}
  });
  const select = file => document.getElementById('fileInput').listeners.change({target: {files: [file]}});
  return {ctx, document, select, alerts};
}

const file = name => ({name, size: 1024, type: '', arrayBuffer: async () => new ArrayBuffer(0)});
const chapter = title => [{title, content: '正文'}];

test('file name is displayed as text, not HTML', async () => {
  const {ctx, document, select} = popup();
  ctx.parsePDF = async () => chapter('新书');
  await select(file('<img src=x onerror=alert(1)>.pdf'));
  const info = document.getElementById('fileInfo');
  assert.equal(info.innerHTML, '');
  assert.match(info.textContent, /<img src=x onerror=alert\(1\)>/);
});

test('latest file wins when an older parse finishes later', async () => {
  const {ctx, document, select} = popup();
  let finishOld;
  ctx.parsePDF = () => new Promise(resolve => {finishOld = resolve;});
  const old = select(file('old.pdf'));
  ctx.parsePDF = async () => chapter('新书');
  await select(file('new.pdf'));
  finishOld(chapter('旧书'));
  await old;
  assert.equal(vm.runInContext('chapters[0].title', ctx), '新书');
  assert.equal(document.getElementById('splitBtn').disabled, false);
});

test('old parse errors do not overwrite latest success', async () => {
  const {ctx, document, select} = popup();
  let failOld;
  ctx.parsePDF = () => new Promise((resolve, reject) => {failOld = reject;});
  const old = select(file('old.pdf'));
  ctx.parsePDF = async () => chapter('新书');
  await select(file('new.pdf'));
  failOld(new Error('old error'));
  await old;
  assert.equal(document.getElementById('status').className, 'status success');
});

test('new selection clears old chapters and download state, even if parsing fails', async () => {
  const {ctx, document, select} = popup();
  ctx.parsePDF = async () => chapter('旧书');
  await select(file('old.pdf'));
  ctx.window._chapterFiles = [{url: 'blob:old'}];
  document.getElementById('downloadAllBtn').disabled = false;
  await select(file('invalid.txt'));
  assert.equal(vm.runInContext('chapters.length', ctx), 0);
  assert.equal(document.getElementById('downloadAllBtn').disabled, true);
  assert.equal(document.getElementById('chapterPreview').style.display, 'none');
  assert.equal(ctx.window._chapterFiles, null);
});

test('empty parse results cannot enable splitting', async () => {
  const {ctx, document, select} = popup();
  ctx.parsePDF = async () => [];
  await select(file('empty.pdf'));
  assert.equal(document.getElementById('splitBtn').disabled, true);
  assert.equal(document.getElementById('status').className, 'status error');
});

test('download failures are counted and never reported as success', async () => {
  const {ctx, document} = popup();
  ctx.chrome.downloads.download = async ({filename}) => {
    if (filename === 'bad.txt') throw new Error('blocked');
    return 1;
  };
  await ctx.downloadAllChapters([{url: 'blob:a', filename: 'good.txt'}, {url: 'blob:b', filename: 'bad.txt'}]);
  const status = document.getElementById('status');
  assert.equal(status.className, 'status error');
  assert.match(status.textContent, /成功 1.*失败 1/);
});

test('successful download requests report accepted count', async () => {
  const {ctx, document} = popup();
  await ctx.downloadAllChapters([{url: 'blob:a', filename: 'good.txt'}]);
  assert.equal(document.getElementById('status').className, 'status success');
  assert.match(document.getElementById('status').textContent, /1/);
});

for (const [file, split] of parsers) {
  test(`${file}: fragmented Chinese PDF headings and English word boundaries`, async () => {
    const lines = ['前言', '第一章 开始', 'Hello world', '第二章：结束', '短正文'];
    const items = lines.flatMap(line => /[\u4e00-\u9fff]/.test(line)
      ? Array.from(line, (str, i) => ({str, hasEOL: i === line.length - 1}))
      : [{str: 'Hello'}, {str: 'world', hasEOL: true}]);
    const ctx = load(file, {pdfjsLib: {GlobalWorkerOptions: {}, getDocument: () => ({destroy: async () => {}, promise: Promise.resolve({
      numPages: 1, getPage: async () => ({getTextContent: async () => ({items})})
    })})}});
    const result = file.includes('fileParser')
      ? await ctx.parsePDF({arrayBuffer: async () => new ArrayBuffer(0)})
      : await ctx.processPDF(new Uint8Array(), {autoDetect: true, pattern: 'auto'});
    assert.deepEqual(Array.from(result, c => c.title), ['前言', '开始', '结束']);
    assert.match(result[1].content, /Hello world/);
    assert.match(result[2].content, /短正文/);
    assert.equal(split(ctx, '第一章\n甲\n第二章\n乙').length, 2);
  });

  test(`${file}: PDF normalizes Kangxi radicals in fragmented chapter headings`, async () => {
    const lines = ['前言', '第⼀章：开始', '正文', '第⼆章：继续', '尾声'];
    const items = lines.flatMap(line => Array.from(line, (str, i) => ({str, hasEOL: i === line.length - 1})));
    const ctx = load(file, {pdfjsLib: {GlobalWorkerOptions: {}, getDocument: () => ({destroy: async () => {}, promise: Promise.resolve({
      numPages: 1, getPage: async () => ({getTextContent: async () => ({items})})
    })})}});
    const result = file.includes('fileParser')
      ? await ctx.parsePDF({arrayBuffer: async () => new ArrayBuffer(0)})
      : await ctx.processPDF(new Uint8Array(), {autoDetect: true, pattern: 'auto'});
    assert.deepEqual(Array.from(result, c => c.title), ['前言', '开始', '继续']);
    assert.match(result[1].content, /^第一章：开始\n正文$/);
    assert.match(result[2].content, /^第二章：继续\n尾声$/);
    assert.equal(ctx.pdfPageText([{str: '第⼀章', hasEOL: true}]), '第一章\n');
  });

  test(`${file}: PDF joins split Han and full-width punctuation without normalizing punctuation`, () => {
    const ctx = load(file);
    const line = '中⽂，继续。｛结束｝';
    const items = Array.from(line, (str, i) => ({str, hasEOL: i === line.length - 1}));
    assert.equal(ctx.pdfPageText(items), '中文，继续。｛结束｝\n');
    assert.equal(ctx.pdfPageText([{str: 'Hello'}, {str: 'world', hasEOL: true}]), 'Hello world\n');
  });

  test(`${file}: PDF supplement radicals become unified ideographs in chapter titles`, async () => {
    const lines = ['第三章：⻓⻔⻅⻛⻢⻆⻜⻦⻥⻰⻩⻝⻋⻉⻚⻮⻨', '正文'];
    const items = lines.flatMap(line => Array.from(line, (str, i) => ({str, hasEOL: i === line.length - 1})));
    const ctx = load(file, {pdfjsLib: {GlobalWorkerOptions: {}, getDocument: () => ({destroy: async () => {}, promise: Promise.resolve({
      numPages: 1, getPage: async () => ({getTextContent: async () => ({items})})
    })})}});
    const result = file.includes('fileParser')
      ? await ctx.parsePDF({arrayBuffer: async () => new ArrayBuffer(0)})
      : await ctx.processPDF(new Uint8Array(), {autoDetect: true, pattern: 'auto'});
    assert.deepEqual(Array.from(result, c => c.title), ['长门见风马角飞鸟鱼龙黄食车贝页齿麦']);
    assert.equal(result[0].content, '第三章：长门见风马角飞鸟鱼龙黄食车贝页齿麦\n正文');
    // Unmapped radicals still join without guessing their semantic equivalent.
    assert.equal(ctx.pdfPageText([{str: '中'}, {str: '\u2e80'}, {str: '文', hasEOL: true}]), '中\u2e80文\n');
  });

  test(`${file}: PDF joins curly quotes, dashes and ellipsis without spaces from empty items`, () => {
    const ctx = load(file);
    const line = '中文“引号”‘单引号’——省略…结束';
    assert.equal(ctx.pdfPageText([...Array.from(line, str => ({str})), {str: ''}]), line);
    assert.equal(ctx.pdfPageText([{str: '中文'}, {str: '', hasEOL: true}]), '中文\n');
    assert.equal(ctx.pdfPageText([{str: 'Hello'}, {str: ''}, {str: 'world'}, {str: ''}]), 'Hello world');
  });

  test(`${file}: EPUB resolves encoded relative paths and preserves block boundaries`, async () => {
    const entry = text => ({async: async () => text});
    const files = {'OEBPS/package.opf': entry('opf'), 'Text/第一章.xhtml': entry('html')};
    const attrs = data => ({getAttribute: key => data[key]});
    const nodes = [['h1', '第一章：开始'], ['p', '正文'], ['script', 'ignored();']].map(([tag, text]) => ({
      tag, textContent: text, removed: false,
      append(value) {this.textContent += value;}, remove() {this.removed = true;}
    }));
    const html = {
      body: {get textContent() {return nodes.filter(n => !n.removed).map(n => n.textContent).join('');}},
      querySelector: () => nodes[0],
      querySelectorAll: selector => nodes.filter(n => selector.split(',').map(s => s.trim()).includes(n.tag))
    };
    class DOMParser {
      parseFromString(text) {
        if (text === 'html') return html;
        return {querySelectorAll: query => query === 'manifest item'
          ? [attrs({id: 'ch1', href: '../Text/%E7%AC%AC%E4%B8%80%E7%AB%A0.xhtml#start'})]
          : [attrs({idref: 'ch1'})]};
      }
    }
    const ctx = load(file, {DOMParser, JSZip: {loadAsync: async () => ({files})}});
    const parse = () => file.includes('fileParser')
      ? ctx.parseEPUB({arrayBuffer: async () => new ArrayBuffer(0)})
      : ctx.processEPUB(new Uint8Array(), {autoDetect: true, pattern: 'auto'});
    const content = (await parse())[0].content;
    assert.match(content, /第一章：开始\n+正文/);
    assert.equal(content.includes('ignored();'), false);
    for (const href of ['https://example.invalid/book', '../../outside', '/root.xhtml', '%2e%2e/%2e%2e/outside']) {
      assert.throws(() => ctx.resolveEPUBPath('OEBPS/', href), /EPUB/);
    }
  });

  for (const failure of ['missing reference', 'missing file', 'invalid path', 'unreadable file', 'invalid document']) {
    test(`${file}: EPUB skips and reports ${failure} while keeping later chapters`, async () => {
      const fixture = epubFixture(file, failure);
      const result = await fixture.parse();
      assert.deepEqual(Array.from(result, c => c.title), [file.includes('fileParser') ? '第一章：保留' : '保留']);
      assert.match(result[0].content, /第一章：保留\n正文/);
      assert.equal(fixture.warnings.length, 1);
      assert.match(fixture.warnings[0], /跳过 EPUB 章节/);
      assert.equal(fixture.warnings[0].includes('private-chapter'), false);
    });
  }

  test(`${file}: EPUB tries the raw encoded href when the decoded filename is absent`, async () => {
    const fixture = epubFixture(file);
    fixture.files['Text/%E4%B8%80.xhtml'] = fixture.files['Text/一.xhtml'];
    delete fixture.files['Text/一.xhtml'];
    const result = await fixture.parse();
    assert.deepEqual(Array.from(result, c => c.title), [file.includes('fileParser') ? '第一章：保留' : '保留']);
    assert.equal(fixture.warnings.length, 0);
  });

  for (const href of ['100%.xhtml', '%ZZ.xhtml']) {
    test(`${file}: EPUB reads raw href after decoding fails (${href})`, async () => {
      const fixture = epubFixture(file, undefined, `../Text/${href}#start`);
      fixture.files[`Text/${href}`] = fixture.files['Text/一.xhtml'];
      delete fixture.files['Text/一.xhtml'];
      const result = await fixture.parse();
      assert.equal(result.length, 1);
      assert.match(result[0].content, /第一章：保留\n正文/);
      assert.equal(fixture.warnings.length, 0);
    });
  }

  test(`${file}: EPUB prefers decoded href and returns no chapters when all entries are missing`, async () => {
    const fixture = epubFixture(file);
    fixture.files['Text/%E4%B8%80.xhtml'] = {async: async () => {throw new Error('raw path must not be read');}};
    assert.equal((await fixture.parse()).length, 1);
    delete fixture.files['Text/一.xhtml'];
    delete fixture.files['Text/%E4%B8%80.xhtml'];
    assert.equal((await fixture.parse()).length, 0);
    assert.equal(fixture.warnings.length, 1);
  });
}

function epubFixture(file, failure, href = '../Text/%E4%B8%80.xhtml#start') {
  const entry = text => ({async: async () => text});
  const attrs = data => ({getAttribute: key => data[key]});
  const files = {'OEBPS/package.opf': entry('opf'), 'Text/一.xhtml': entry('good')};
  const manifest = [attrs({id: 'good', href})];
  const spine = [attrs({idref: 'good'})];
  if (failure) {
    spine.unshift(attrs({idref: 'bad'}));
    if (failure !== 'missing reference') {
      manifest.push(attrs({id: 'bad', href: failure === 'invalid path' ? '../../private-chapter.xhtml' : 'private-chapter.xhtml'}));
    }
    if (failure === 'unreadable file') files['OEBPS/private-chapter.xhtml'] = {async: async () => {throw new Error('private-chapter');}};
    if (failure === 'invalid document') files['OEBPS/private-chapter.xhtml'] = entry('invalid');
  }
  class DOMParser {
    parseFromString(text) {
      if (text === 'opf') return {querySelectorAll: query => query === 'manifest item' ? manifest : spine};
      if (text === 'invalid') return {body: null, querySelectorAll: () => []};
      return {
        body: {textContent: '第一章：保留\n正文'},
        querySelector: () => ({textContent: '第一章：保留'}), querySelectorAll: () => []
      };
    }
  }
  const warnings = [];
  const ctx = load(file, {DOMParser, JSZip: {loadAsync: async () => ({files})},
    console: {warn: message => warnings.push(message)}});
  return {files, warnings, parse: () => file.includes('fileParser')
    ? ctx.parseEPUB({arrayBuffer: async () => new ArrayBuffer(0)})
    : ctx.processEPUB(new Uint8Array(), {autoDetect: true, pattern: 'auto'})};
}

test('NotebookLM auto detection can be disabled without dropping heading-only text', () => {
  const ctx = load('notebooklm-chapter-splitter/fileParser.js');
  const text = '第一章：目录\n第二章：目录\n第一章：正文\n短文';
  const result = ctx.detectChapters(text, {autoDetect: false});
  assert.equal(result.length, 1);
  assert.equal(result[0].content, text);
});

test('NotebookLM popup passes detection option and numbers filenames only when checked', async () => {
  const {ctx, document, select} = popup();
  document.getElementById('autoDetectChapters').checked = false;
  let options;
  ctx.parsePDF = async (file, value) => {options = value; return chapter('开始');};
  await select(file('book.pdf'));
  assert.equal(options.autoDetect, false);
  await document.getElementById('splitBtn').listeners.click();
  assert.equal(ctx.window._chapterFiles[0].filename, '1._开始.txt');
  document.getElementById('includeChapterNumbers').checked = false;
  await document.getElementById('splitBtn').listeners.click();
  assert.equal(ctx.window._chapterFiles[0].filename, '开始.txt');
});

test('changing automatic detection reparses the selected file and invalidates old downloads', async () => {
  const {ctx, document, select} = popup();
  ctx.parsePDF = async (file, options) => options.autoDetect ? chapter('拆分') : chapter('完整内容');
  await select(file('book.pdf'));
  ctx.window._chapterFiles = [{url: 'blob:old'}];
  document.getElementById('autoDetectChapters').checked = false;
  await document.getElementById('autoDetectChapters').listeners.change();
  assert.equal(vm.runInContext('chapters[0].title', ctx), '完整内容');
  assert.equal(ctx.window._chapterFiles, null);
  assert.equal(document.getElementById('downloadAllBtn').disabled, true);
});

test('HTML exports escape untrusted chapter titles in both title and heading', () => {
  const {ctx} = popup('book-splitter-extension/popup.js');
  const title = '</title><script>alert(1)</script><h1>"&';
  const html = ctx.formatContent('<b>正文</b>', 'html', title);
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;\/title&gt;/);
  assert.match(html, /&lt;b&gt;正文&lt;\/b&gt;/);
});

for (const phase of ['reading', 'parsing']) {
  test(`book popup discards stale ${phase} results after file selection changes`, async () => {
    const {ctx, document, select} = popup('book-splitter-extension/popup.js');
    let finish;
    const oldFile = file('old.PDF');
    if (phase === 'reading') oldFile.arrayBuffer = () => new Promise(resolve => {finish = resolve;});
    ctx.processPDF = phase === 'parsing' ? () => new Promise(resolve => {finish = resolve;}) : async () => chapter('旧书');
    await select(oldFile);
    const pending = document.getElementById('splitBtn').listeners.click();
    for (let i = 0; i < 10 && !finish; i++) await Promise.resolve();
    assert.equal(typeof finish, 'function');
    await select(file('new.pdf'));
    finish(phase === 'reading' ? new ArrayBuffer(0) : chapter('旧书'));
    await pending;
    assert.equal(vm.runInContext('chapters.length', ctx), 0);
    assert.equal(document.getElementById('resultSection').style.display, 'none');
    assert.equal(document.getElementById('downloadAllBtn').disabled, true);
  });
}

test('book popup rejects empty parsed content instead of reporting success', async () => {
  const {ctx, document, select, alerts} = popup('book-splitter-extension/popup.js');
  ctx.processPDF = async () => [];
  await select(file('empty.pdf'));
  await document.getElementById('splitBtn').listeners.click();
  assert.equal(document.getElementById('resultSection').style.display, 'none');
  assert.match(alerts[0], /未提取到/);
});

test('book popup stops submitting old downloads after selecting another file', async () => {
  const {ctx, document, select, alerts} = popup('book-splitter-extension/popup.js');
  ctx.processPDF = async () => [...chapter('一'), ...chapter('二')];
  await select(file('old.pdf'));
  await document.getElementById('splitBtn').listeners.click();
  let finish; const calls = [];
  ctx.chrome.downloads.download = (options, callback) => {
    calls.push(options);
    if (calls.length === 1) finish = callback;
    else callback(1);
  };
  const pending = document.getElementById('downloadAllBtn').listeners.click();
  await select(file('new.pdf'));
  finish(1); await pending;
  assert.equal(calls.length, 1);
  assert.equal(alerts.length, 0);
  assert.equal(document.getElementById('downloadAllBtn').disabled, true);
});

for (const [file] of parsers) {
  test(`${file}: untrusted PDFs cannot enable dynamic code evaluation`, async () => {
    let parameters;
    const ctx = load(file, {pdfjsLib: {GlobalWorkerOptions: {}, getDocument: options => {
      parameters = options;
      return {destroy: async () => {}, promise: Promise.resolve({numPages: 0})};
    }}});
    if (file.includes('fileParser')) await ctx.parsePDF({arrayBuffer: async () => new ArrayBuffer(0)});
    else await ctx.processPDF(new Uint8Array(), {autoDetect: true, pattern: 'auto'});
    assert.equal(parameters.isEvalSupported, false);
  });

  for (const failure of [null, 'load', 'text']) {
    test(`${file}: PDF worker is released after ${failure || 'successful extraction'}`, async () => {
      let destroyed = 0;
      const ctx = load(file, {pdfjsLib: {GlobalWorkerOptions: {}, getDocument: () => ({
        destroy: async () => {destroyed++;},
        promise: failure === 'load' ? Promise.reject(new Error('load')) : Promise.resolve({
          numPages: 1, getPage: async () => ({getTextContent: async () => {
            if (failure === 'text') throw new Error('text');
            return {items: [{str: '正文', hasEOL: true}]};
          }})
        })
      })}});
      const parse = () => file.includes('fileParser')
        ? ctx.parsePDF({arrayBuffer: async () => new ArrayBuffer(0)})
        : ctx.processPDF(new Uint8Array(), {autoDetect: true, pattern: 'auto'});
      if (failure) await assert.rejects(parse, new RegExp(failure));
      else assert.equal((await parse()).length, 1);
      assert.equal(destroyed, 1);
    });
  }
}

test('NotebookLM popup stops old downloads after the selected file changes', async () => {
  const {ctx, document, select} = popup();
  let finish;
  const calls = [];
  ctx.chrome.downloads.download = options => {
    calls.push(options);
    return calls.length === 1 ? new Promise(resolve => {finish = resolve;}) : Promise.resolve(2);
  };
  const pending = ctx.downloadAllChapters([
    {url: 'blob:old1', filename: 'one.txt'}, {url: 'blob:old2', filename: 'two.txt'}
  ]);
  ctx.parsePDF = async () => chapter('新书');
  await select(file('new.pdf'));
  finish(1);
  await pending;
  assert.equal(calls.length, 1);
  assert.match(document.getElementById('status').textContent, /成功检测到/);
});

test('NotebookLM popup releases obsolete blob URLs on split and file change', async () => {
  const {ctx, document, select} = popup();
  const revoked = [];
  let next = 0;
  ctx.URL.createObjectURL = () => `blob:${++next}`;
  ctx.URL.revokeObjectURL = url => revoked.push(url);
  ctx.parsePDF = async () => chapter('开始');
  await select(file('book.pdf'));
  const split = document.getElementById('splitBtn').listeners.click;
  await split();
  await split();
  assert.deepEqual(revoked, ['blob:1']);
  await select(file('new.pdf'));
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
});

test('NotebookLM re-splitting cancels the previous download queue', async () => {
  const {ctx, document, select} = popup();
  ctx.setTimeout = () => {}; // Keep automatic downloads queued for this test.
  ctx.parsePDF = async () => [...chapter('一'), ...chapter('二')];
  await select(file('book.pdf'));
  const split = document.getElementById('splitBtn').listeners.click;
  await split();
  let finish;
  const calls = [];
  ctx.chrome.downloads.download = options => {
    calls.push(options);
    return calls.length === 1 ? new Promise(resolve => {finish = resolve;}) : Promise.resolve(2);
  };
  const pending = ctx.downloadAllChapters(ctx.window._chapterFiles);
  await split();
  ctx.setTimeout = callback => callback();
  finish(1);
  await pending;
  assert.equal(calls.length, 1);
});
