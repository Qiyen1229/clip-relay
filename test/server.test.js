'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');

async function boot(envOver = {}, clock = { t: Date.now() }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-test-'));
  const config = loadConfig({ DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', MAX_ITEM_BYTES: '2048', ...envOver });
  const app = createApp(config, { now: () => clock.t });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const call = (p, { method = 'GET', body, headers = {} } = {}) =>
    fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
  const post = (body, extra) => call('/api/items', { method: 'POST', body, ...extra });
  return { app, call, post, clock, base, close: () => app.close() };
}

test('不需要令牌即可讀寫；health 與 config 可用', async () => {
  const t = await boot();
  try {
    assert.equal((await t.call('/api/health')).status, 200);
    assert.equal((await t.call('/api/config')).status, 200);
    assert.equal((await t.post({ text: 'hi' })).status, 201);
    const list = await (await t.call('/api/items')).json();
    assert.equal(list.items[0].text, 'hi');
  } finally { await t.close(); }
});

test('文字內容（含 Unicode 與 HTML）原樣往返', async () => {
  const t = await boot();
  try {
    const text = '<script>alert(1)</script> 你好 🚀\n\ttab';
    const { id } = await (await t.post({ text })).json();
    assert.equal((await (await t.call('/api/items/' + id)).json()).text, text);
  } finally { await t.close(); }
});

test('超大內容回 413（以 UTF-8 位元組計，含遠超上限的 body）', async () => {
  const t = await boot(); // 上限 2048 bytes
  try {
    let r = await t.post({ text: 'a'.repeat(2049) });
    assert.equal(r.status, 413);
    assert.equal((await r.json()).error.code, 'too_large');
    r = await t.post({ text: '中'.repeat(700) }); // 2100 bytes（700 字元）
    assert.equal(r.status, 413);
    r = await t.post({ text: 'a'.repeat(500_000) });
    assert.equal(r.status, 413);
    assert.equal((await t.post({ text: 'a'.repeat(2048) })).status, 201); // 邊界
  } finally { await t.close(); }
});

test('輸入驗證：型別、空字串、TTL', async () => {
  const t = await boot();
  try {
    assert.equal((await t.post('not json')).status, 400);
    assert.equal((await t.post([])).status, 400);
    assert.equal((await t.post({ text: 123 })).status, 400);
    assert.equal((await t.post({ text: '' })).status, 400);
    assert.equal((await t.post({})).status, 400);
    assert.equal((await t.post({ text: 'x', ttl: 1 })).status, 400);
    assert.equal((await t.post({ text: 'x', ttl: 999999999 })).status, 400);
    assert.equal((await t.post({ text: 'x', ttl: '60' })).status, 400);
    assert.equal((await t.post({ text: 'x', burn: 'yes' })).status, 400);
    assert.equal((await t.post({ text: 'x' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    assert.equal((await t.post({ text: 'x', ttl: 60, burn: false })).status, 201);
  } finally { await t.close(); }
});

test('阅後即焚：列表不洩漏內容，第一次 GET 取出，第二次 404', async () => {
  const t = await boot();
  try {
    const { id } = await (await t.post({ text: 'secret', burn: true })).json();
    const list = await (await t.call('/api/items')).json();
    assert.equal(list.items[0].burn, true);
    assert.equal(list.items[0].text, null);
    const first = await t.call('/api/items/' + id);
    assert.equal(first.status, 200);
    assert.equal((await first.json()).text, 'secret');
    assert.equal((await t.call('/api/items/' + id)).status, 404);
    assert.equal((await (await t.call('/api/items')).json()).items.length, 0);
  } finally { await t.close(); }
});

test('阅後即焚：併發讀取只有一個成功', async () => {
  const t = await boot();
  try {
    const { id } = await (await t.post({ text: 'x', burn: true })).json();
    const rs = await Promise.all(Array.from({ length: 8 }, () => t.call('/api/items/' + id)));
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
  } finally { await t.close(); }
});

test('過期：讀取時惰性刪除 + 定時清理', async () => {
  const clock = { t: 1_700_000_000_000 };
  const t = await boot({}, clock);
  try {
    const mk = async (ttl) => (await (await t.post({ text: 'x', ttl })).json()).id;
    const a = await mk(60);
    const b = await mk(600);
    assert.equal((await t.call('/api/items/' + a)).status, 200);
    clock.t += 61_000;
    assert.equal((await t.call('/api/items/' + a)).status, 404);   // 惰性
    assert.equal((await t.call('/api/items/' + b)).status, 200);
    const c = await mk(10);
    clock.t += 11_000;
    assert.equal(t.app.store.items.has(c), true);                  // 還沒被讀過
    assert.equal(t.app.sweep(), 1);                                 // 定時任務
    assert.equal(t.app.store.items.has(c), false);
  } finally { await t.close(); }
});

test('列表：新到舊、ETag 304、DELETE', async () => {
  const t = await boot();
  try {
    const mk = async () => (await (await t.post({ text: 'x' })).json()).id;
    const a = await mk(); const b = await mk();
    const r = await t.call('/api/items');
    const etag = r.headers.get('etag');
    assert.deepEqual((await r.json()).items.map((i) => i.id), [b, a]);
    assert.equal((await t.call('/api/items', { headers: { 'If-None-Match': etag } })).status, 304);
    assert.equal((await t.call('/api/items/' + a, { method: 'DELETE' })).status, 204);
    assert.equal((await t.call('/api/items/' + a, { method: 'DELETE' })).status, 404);
    const r2 = await t.call('/api/items', { headers: { 'If-None-Match': etag } });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).items.length, 1);
  } finally { await t.close(); }
});

test('發送速率限制回 429', async () => {
  const t = await boot({ POST_RATE_PER_MIN: '3' });
  try {
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await t.post({ text: 'x' })).status);
    assert.deepEqual(codes, [201, 201, 201, 429, 429]);
  } finally { await t.close(); }
});

test('靜態檔案：安全標頭、路徑穿越被擋', async () => {
  const t = await boot();
  try {
    const r = await fetch(t.base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(t.base + '/..%2fpackage.json')).status, 404);
    assert.equal((await fetch(t.base + '/../package.json')).status, 404);
    assert.equal((await fetch(t.base + '/src/server.js')).status, 404);
  } finally { await t.close(); }
});

test('PWA：manifest 與圖示可取得且內容完整', async () => {
  const t = await boot();
  try {
    const r = await fetch(t.base + '/manifest.json');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /manifest\+json/);
    const m = await r.json();
    assert.equal(m.display, 'standalone');
    for (const k of ['name', 'short_name', 'theme_color', 'background_color', 'start_url']) assert.ok(m[k], k);
    const sizes = m.icons.map((i) => `${i.sizes}:${i.purpose}`);
    assert.ok(sizes.includes('192x192:any') && sizes.includes('512x512:any') && sizes.includes('512x512:maskable'));
    for (const i of m.icons) {
      const ir = await fetch(t.base + i.src);
      assert.equal(ir.status, 200);
      assert.equal(ir.headers.get('content-type'), 'image/png');
    }
    assert.equal((await fetch(t.base + '/apple-touch-icon.png')).status, 200);
    // index.html 內每個 splash 連結都對應存在的檔案
    const html = await (await fetch(t.base + '/')).text();
    const links = [...html.matchAll(/apple-touch-startup-image" href="([^"]+)"/g)].map((x) => x[1]);
    assert.ok(links.length >= 10);
    for (const l of links) assert.equal((await fetch(t.base + l)).status, 200, l);
    for (const needle of ['viewport-fit=cover', 'apple-mobile-web-app-capable', 'black-translucent',
      'apple-mobile-web-app-title', 'rel="apple-touch-icon"', 'rel="manifest"']) {
      assert.ok(html.includes(needle), needle);
    }
  } finally { await t.close(); }
});
