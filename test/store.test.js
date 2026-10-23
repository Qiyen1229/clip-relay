'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');

function mk(opts = {}) {
  const clock = { t: 1_000_000 };
  const s = new Store({ ...opts, now: () => clock.t });
  return { s, clock };
}
const add = (s, o = {}) => s.add({ text: 'c'.repeat(80), size: 60, ttlSec: 600, burn: false, ...o });

test('過期：讀取時惰性刪除', () => {
  const { s, clock } = mk();
  const it = add(s, { ttlSec: 60 });
  assert.ok(s.get(it.id));
  clock.t += 61_000;
  assert.equal(s.get(it.id), null);
  assert.equal(s.items.size, 0);
});

test('過期：list 不回傳過期項目', () => {
  const { s, clock } = mk();
  add(s, { ttlSec: 10 });
  const keep = add(s, { ttlSec: 600 });
  clock.t += 11_000;
  assert.deepEqual(s.list().map((i) => i.id), [keep.id]);
});

test('過期：sweep 主動刪除', () => {
  const { s, clock } = mk();
  add(s, { ttlSec: 10 });
  add(s, { ttlSec: 10 });
  add(s, { ttlSec: 600 });
  clock.t += 11_000;
  assert.equal(s.items.size, 3); // 尚未有人讀取
  assert.equal(s.sweep(), 2);
  assert.equal(s.items.size, 1);
});

test('阅後即焚：第一次讀取後即刪除', () => {
  const { s } = mk();
  const it = add(s, { burn: true });
  assert.ok(s.get(it.id));
  assert.equal(s.get(it.id), null);
});

test('非阅後即焚可重複讀取', () => {
  const { s } = mk();
  const it = add(s);
  assert.ok(s.get(it.id));
  assert.ok(s.get(it.id));
});

test('順序以接收順序為準，新到舊，seq 遞增', () => {
  const { s } = mk();
  const a = add(s); const b = add(s); const c = add(s);
  assert.deepEqual(s.list().map((i) => i.id), [c.id, b.id, a.id]);
  assert.ok(a.seq < b.seq && b.seq < c.seq);
});

test('超過 maxItems 淘汰最舊', () => {
  const { s } = mk({ maxItems: 3 });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(add(s).id);
  assert.deepEqual(s.list().map((i) => i.id), [ids[4], ids[3], ids[2]]);
});

test('超過總容量淘汰最舊', () => {
  const { s } = mk({ maxTotalBytes: 150 });
  const a = add(s); add(s); const c = add(s);
  assert.equal(s.get(a.id), null);
  assert.ok(s.get(c.id));
  assert.ok(s.totalBytes <= 150);
});

test('snapshot / restore 會略過已過期項目', () => {
  const { s, clock } = mk();
  add(s, { ttlSec: 10 });
  const keep = add(s, { ttlSec: 600 });
  const snap = JSON.parse(JSON.stringify(s.snapshot()));
  clock.t += 11_000;
  const r = new Store({ now: () => clock.t });
  r.restore(snap);
  assert.deepEqual(r.list().map((i) => i.id), [keep.id]);
});
