const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

for (const folder of ['book-splitter-extension', 'notebooklm-chapter-splitter']) {
  function fixture() {
    let listener;
    const calls = [];
    const chrome = {
      runtime: {id: 'extension-id', getURL: file => `chrome-extension://extension-id/${file}`,
        onMessage: {addListener: value => {listener = value;}}, onInstalled: {addListener() {}}},
      downloads: {download: (options, callback) => {calls.push(options); callback(7);},
        onChanged: {addListener() {}}},
      storage: {local: {
        get: (keys, callback) => {calls.push(keys); callback({setting: true});},
        set: (data, callback) => {calls.push(data); callback();}
      }}
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', folder, 'background.js'), 'utf8'), {chrome});
    const sender = {id: chrome.runtime.id, url: chrome.runtime.getURL('popup.html')};
    function send(message, from = sender) {
      let response;
      listener(message, from, value => {response = value;});
      return response;
    }
    return {calls, chrome, sender, send};
  }

  const download = {action: 'downloadFile', url: 'blob:chrome-extension://extension-id/uuid', filename: 'chapter.txt'};

  test(`${folder}: privileged messages reject untrusted senders`, () => {
    const f = fixture();
    const messages = [download];
    if (folder.startsWith('notebooklm')) messages.push(
      {action: 'getStorage', keys: null}, {action: 'setStorage', data: {setting: true}}
    );
    for (const sender of [undefined, {}, {...f.sender, id: 'other'},
      {...f.sender, url: 'https://notebooklm.google.com/'},
      {...f.sender, url: f.sender.url + '?other'}, {...f.sender, tab: {id: 1}}]) {
      for (const message of messages) {
        f.send(message, sender || {});
        assert.equal(f.calls.length, 0);
      }
    }
  });

  test(`${folder}: download accepts only local blob URLs and leaf filenames`, () => {
    const f = fixture();
    for (const url of ['https://example.invalid/file', 'file:///private/file', 'data:text/html,hello',
      'blob:chrome-extension://other/uuid', 'blob:chrome-extension://extension-id/', null]) {
      f.send({...download, url});
    }
    for (const filename of ['../chapter.txt', 'dir/chapter.txt', 'dir\\chapter.txt', '..', '',
      'chapter\0.txt', 'x\n.txt', 1]) f.send({...download, filename});
    assert.equal(f.calls.length, 0);
    assert.equal(f.send(download).downloadId, 7);
    assert.equal(f.calls.length, 1);
  });

  test(`${folder}: malformed messages and API errors are handled`, () => {
    const f = fixture();
    for (const message of [null, undefined, {}, 'downloadFile']) assert.doesNotThrow(() => f.send(message));
    f.chrome.downloads.download = () => {throw new Error('invalid request');};
    assert.equal(f.send(download).success, false);
    f.chrome.downloads.download = (options, callback) => {
      f.chrome.runtime.lastError = {message: 'blocked'}; callback();
    };
    assert.equal(f.send(download).error, 'blocked');
  });

  if (folder.startsWith('notebooklm')) {
    test(`${folder}: trusted storage calls preserve success and report read failures`, () => {
      const f = fixture();
      assert.equal(f.send({action: 'getStorage', keys: ['setting']}).data.setting, true);
      assert.equal(f.send({action: 'setStorage', data: {setting: false}}).success, true);
      f.chrome.storage.local.get = (keys, callback) => {
        f.chrome.runtime.lastError = {message: 'unavailable'}; callback();
      };
      assert.equal(f.send({action: 'getStorage', keys: null}).success, false);
    });
  }
}

test('extension resources stay private and splitters do not request activeTab', () => {
  for (const folder of ['book-splitter-extension', 'notebooklm-chapter-splitter', 'pinyin-extension']) {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', folder, 'manifest.json'), 'utf8'));
    assert.equal(manifest.web_accessible_resources, undefined);
    if (folder !== 'pinyin-extension') assert.equal(manifest.permissions.includes('activeTab'), false);
  }
});
