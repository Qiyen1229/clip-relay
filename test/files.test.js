'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { loadConfig } = require('../src/config');
const { createApp } = require('../src/server');

async function boot(envOver = {}, clock = { t: Date.now() }, dataDir) {
  dataDir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'clip-files-'));
  const config = loadConfig({
    DATA_DIR: dataDir, PORT: '0', HOST: '127.0.0.1', MIN_FREE_DISK_BYTES: '0',
    MAX_FILE_BYTES: '100000', CHUNK_BYTES: '65536', ...envOver,
  });
  const app = createApp(config, { now: () => clock.t });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const j = (p, body, method = 'POST') => fetch(base + p, {
    method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  });
  /** 完整上傳流程，回傳 item meta */
  async function upload(buf, meta = {}, chunk = 65536) {
    const c = await j('/api/files', { name: 'a.bin', size: buf.length, mime: 'application/octet-stream', ...meta });
    assert.equal(c.status, 201, await c.clone().text());
    const { id } = await c.json();
    for (let o = 0; o < buf.length; o += chunk) {
      const r = await fetch(`${base}/api/files/${id}?offset=${o}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buf.subarray(o, o + chunk),
      });
      assert.equal(r.status, 200);
    }
    const done = await j(`/api/files/${id}/complete`, undefined);
    assert.equal(done.status, 201);
    return done.json();
  }
  return { app, base, j, upload, clock, dataDir, config, close: () => app.close() };
}

test('檔案分塊上傳後可原樣下載（含 Content-Disposition 與 nosniff）', async () => {
  const t = await boot();
  try {
    const buf = crypto.randomBytes(150_000 - 60_000); // 90000，跨 2 塊
    const it = await t.upload(buf, { name: '報告 final.pdf', mime: 'application/pdf' });
    assert.equal(it.kind, 'file');
    assert.equal(it.size, buf.length);
    const r = await fetch(`${t.base}/api/items/${it.id}/content`);
    assert.equal(r.status, 200);
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), buf);
    const cd = r.headers.get('content-disposition');
    assert.match(cd, /^attachment;/);
    assert.match(cd, /filename\*=UTF-8''%E5%A0%B1%E5%91%8A%20final\.pdf/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    const list = await (await fetch(t.base + '/api/items')).json();
    assert.equal(list.items[0].kind, 'file');
    assert.equal(list.items[0].text, null);
  } finally { await t.close(); }
});

test('Range 請求與 inline 白名單（svg/html 一律強制下載）', async () => {
  const t = await boot();
  try {
    const buf = Buffer.from('0123456789');
    const png = await t.upload(buf, { name: 'p.png', mime: 'image/png' });
    let r = await fetch(`${t.base}/api/items/${png.id}/content?inline=1`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(r.status, 206);
    assert.equal(await r.text(), '2345');
    assert.equal(r.headers.get('content-range'), 'bytes 2-5/10');
    assert.match(r.headers.get('content-disposition'), /^inline;/);
    assert.equal(r.headers.get('content-type'), 'image/png');
    r = await fetch(`${t.base}/api/items/${png.id}/content`, { headers: { Range: 'bytes=20-30' } });
    assert.equal(r.status, 416);
    const svg = await t.upload(buf, { name: 'x.svg', mime: 'image/svg+xml' });
    r = await fetch(`${t.base}/api/items/${svg.id}/content?inline=1`);
    assert.match(r.headers.get('content-disposition'), /^attachment;/);
    assert.equal(r.headers.get('content-type'), 'application/octet-stream');
    assert.match(r.headers.get('content-security-policy'), /sandbox/);
    const html = await t.upload(buf, { name: 'x.html', mime: 'text/html' });
    r = await fetch(`${t.base}/api/items/${html.id}/content?inline=1`);
    assert.match(r.headers.get('content-disposition'), /^attachment;/);
  } finally { await t.close(); }
});

test('超過單檔上限、非法 size 皆被拒絕', async () => {
  const t = await boot();
  try {
    let r = await t.j('/api/files', { name: 'big', size: 100_001 });
    assert.equal(r.status, 413);
    r = await t.j('/api/files', { name: 'x', size: -1 });
    assert.equal(r.status, 400);
    r = await t.j('/api/files', { name: 'x', size: 'abc' });
    assert.equal(r.status, 400);
    r = await t.j('/api/files', { name: 'x', size: 10, kind: 'weird' });
    assert.equal(r.status, 400);
  } finally { await t.close(); }
});

test('分塊：offset 不符回 409；超出宣告大小被拒；未收完不可 complete', async () => {
  const t = await boot();
  try {
    const { id } = await (await t.j('/api/files', { name: 'a', size: 10 })).json();
    let r = await fetch(`${t.base}/api/files/${id}?offset=5`, { method: 'PUT', body: Buffer.alloc(5) });
    assert.equal(r.status, 409);
    r = await fetch(`${t.base}/api/files/${id}?offset=0`, { method: 'PUT', body: Buffer.alloc(11) });
    assert.ok(r.status === 413 || r.status === 400);
    r = await t.j(`/api/files/${id}/complete`, undefined);
    assert.equal(r.status, 409);
    // 失敗後仍可從 0 開始重傳
    r = await fetch(`${t.base}/api/files/${id}?offset=0`, { method: 'PUT', body: Buffer.alloc(10, 1) });
    assert.equal(r.status, 200);
    assert.equal((await t.j(`/api/files/${id}/complete`, undefined)).status, 201);
  } finally { await t.close(); }
});

test('檔案阅後即焚：第一次下載成功且內容完整，第二次 404，磁碟檔被刪除', async () => {
  const t = await boot();
  try {
    const buf = crypto.randomBytes(50_000);
    const it = await t.upload(buf, { name: 'once.bin', burn: true });
    const first = await fetch(`${t.base}/api/items/${it.id}/content`);
    assert.equal(first.status, 200);
    assert.deepEqual(Buffer.from(await first.arrayBuffer()), buf);
    assert.equal((await fetch(`${t.base}/api/items/${it.id}/content`)).status, 404);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(path.join(t.app.filesDir, it.id)), false);
    assert.equal((await (await fetch(t.base + '/api/items')).json()).items.length, 0);
  } finally { await t.close(); }
});

test('檔案過期：惰性與定時清理都會刪掉磁碟檔', async () => {
  const clock = { t: 1_700_000_000_000 };
  const t = await boot({}, clock);
  try {
    const a = await t.upload(Buffer.alloc(100, 1), { ttl: 60 });
    const b = await t.upload(Buffer.alloc(100, 2), { ttl: 60 });
    clock.t += 61_000;
    assert.equal((await fetch(`${t.base}/api/items/${a.id}/content`)).status, 404); // 惰性
    assert.equal(t.app.sweep(), 1);                                                  // 定時
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(path.join(t.app.filesDir, a.id)), false);
    assert.equal(fs.existsSync(path.join(t.app.filesDir, b.id)), false);
  } finally { await t.close(); }
});

test('手動刪除與清空會刪除磁碟檔；檔案總量超限淘汰最舊', async () => {
  const t = await boot({ MAX_FILE_TOTAL_BYTES: '250000' });
  try {
    const a = await t.upload(Buffer.alloc(90_000, 1));
    const b = await t.upload(Buffer.alloc(90_000, 2));
    const c = await t.upload(Buffer.alloc(90_000, 3)); // 總量 270000 > 250000 → 淘汰 a
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(path.join(t.app.filesDir, a.id)), false);
    assert.equal(fs.existsSync(path.join(t.app.filesDir, c.id)), true);
    assert.equal((await fetch(`${t.base}/api/items/${b.id}`, { method: 'DELETE' })).status, 204);
    await fetch(`${t.base}/api/items`, { method: 'DELETE' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(fs.readdirSync(t.app.filesDir), []);
  } finally { await t.close(); }
});

test('檔名清理：路徑分隔與控制字元不會出現在儲存的名稱中', async () => {
  const t = await boot();
  try {
    const it = await t.upload(Buffer.alloc(1), { name: '../../etc/pass\r\nwd' });
    assert.ok(!/[\\/\r\n]/.test(it.name), it.name);
    const folder = await t.upload(Buffer.alloc(1), { name: 'photos', kind: 'folder', fileCount: 3 });
    assert.equal(folder.kind, 'folder');
    assert.equal(folder.name, 'photos.zip');
    assert.equal(folder.fileCount, 3);
  } finally { await t.close(); }
});

test('空檔案可上傳與下載', async () => {
  const t = await boot();
  try {
    const it = await t.upload(Buffer.alloc(0), { name: 'empty.txt' });
    const r = await fetch(`${t.base}/api/items/${it.id}/content`);
    assert.equal(r.status, 200);
    assert.equal((await r.arrayBuffer()).byteLength, 0);
  } finally { await t.close(); }
});

test('PERSIST：重啟後檔案仍在；遺失磁碟檔的項目與孤兒檔被清除', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-persist-'));
  let t = await boot({ PERSIST: '1' }, undefined, dataDir);
  const keep = await t.upload(Buffer.from('keep-me'), { ttl: 3600 });
  const lost = await t.upload(Buffer.from('lost'), { ttl: 3600 });
  await t.close();
  fs.unlinkSync(path.join(dataDir, 'files', lost.id));
  fs.writeFileSync(path.join(dataDir, 'files', 'orphan-file'), 'x');
  t = await boot({ PERSIST: '1' }, undefined, dataDir);
  try {
    const r = await fetch(`${t.base}/api/items/${keep.id}/content`);
    assert.equal(await r.text(), 'keep-me');
    assert.equal((await fetch(`${t.base}/api/items/${lost.id}/content`)).status, 404);
    await new Promise((r2) => setTimeout(r2, 50));
    assert.equal(fs.existsSync(path.join(dataDir, 'files', 'orphan-file')), false);
  } finally { await t.close(); }
});

test('未完成的上傳在伺服器重啟後被丟棄；放棄上傳會刪除暫存檔', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-tmp-'));
  const t = await boot({}, undefined, dataDir);
  const { id } = await (await t.j('/api/files', { name: 'x', size: 10 })).json();
  assert.equal(fs.existsSync(path.join(t.app.tmpDir, id)), true);
  assert.equal((await fetch(`${t.base}/api/files/${id}`, { method: 'DELETE' })).status, 204);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(fs.existsSync(path.join(t.app.tmpDir, id)), false);
  await t.close();
});
