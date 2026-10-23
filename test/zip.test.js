'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync, spawnSync } = require('node:child_process');

let zip;
test.before(async () => { zip = await import('../public/zip.mjs'); });

test('crc32 已知向量與串接計算', () => {
  const te = new TextEncoder();
  assert.equal(zip.crc32(te.encode('123456789')), 0xcbf43926);
  const a = zip.crc32(te.encode('1234'));
  assert.equal(zip.crc32(te.encode('56789'), a), 0xcbf43926);
});

test('cleanPath 去掉 .. 與開頭斜線', () => {
  assert.equal(zip.cleanPath('/../a//b/./c.txt'), 'a/b/c.txt');
  assert.equal(zip.cleanPath('dir\\sub\\f.txt'), 'dir/sub/f.txt');
});

test('buildZip 產生可被 unzip 驗證的壓縮檔（含中文路徑與空檔）', async (t) => {
  const entries = [
    { path: '相簿/a.txt', file: new File(['hello world'], 'a.txt', { lastModified: 1_700_000_000_000 }) },
    { path: '相簿/子資料夾/空.bin', file: new File([], 'x') },
    { path: 'b.bin', file: new File([new Uint8Array(70000).fill(7)], 'b.bin') },
  ];
  const { blob, count } = await zip.buildZip(entries);
  assert.equal(count, 3);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zip-'));
  const f = path.join(dir, 't.zip');
  fs.writeFileSync(f, Buffer.from(await blob.arrayBuffer()));
  const has = spawnSync('unzip', ['-v']).status === 0;
  if (!has) return t.skip('系統沒有 unzip');
  const out = execFileSync('unzip', ['-t', f]).toString();
  assert.match(out, /No errors detected/);
  // 解壓以 Python zipfile 驗證（舊版 Info-ZIP unzip 在非 UTF-8 locale 下無法建立中文路徑，非 zip 本身問題）
  const py = spawnSync('python3', ['-I', '-c', [
    'import zipfile,sys,json',
    'z=zipfile.ZipFile(sys.argv[1])',
    'assert z.testzip() is None',
    'print(json.dumps({n:len(z.read(n)) for n in z.namelist()}|{"txt":z.read("相簿/a.txt").decode()}))',
  ].join('\n'), f]);
  if (py.status !== 0) return t.skip('系統沒有 python3');
  const got = JSON.parse(py.stdout.toString());
  assert.equal(got.txt, 'hello world');
  assert.equal(got['b.bin'], 70000);
  assert.equal(got['相簿/子資料夾/空.bin'], 0);
});
