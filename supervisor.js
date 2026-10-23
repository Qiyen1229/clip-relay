'use strict';
/*
 * 熱更新監督器（容器的 PID 1）。
 *
 * 目的：NAS 上只需「覆蓋上傳新檔案」，不必刪資料夾、不必重建 Docker 專案。
 *   - 監看 src/、public/、package.json 的內容指紋（輪詢；NAS 的掛載目錄常不支援 inotify）
 *   - 檔案穩定 SETTLE_MS 後（避免上傳到一半）自動重啟伺服器行程
 *   - supervisor.js 自己被更新時，結束行程，由 Docker 的 restart: unless-stopped 重新拉起
 *   - 伺服器崩潰（例如上傳了壞檔）以退避方式重試，修正檔案後立即恢復
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const POLL_MS = Number(process.env.WATCH_POLL_MS) || 3000;
const SETTLE_MS = Number(process.env.WATCH_SETTLE_MS) || 2500;
const WATCH = ['src', 'public', 'package.json'];

const log = (...a) => console.log('[supervisor]', ...a);

function walk(p, out) {
  let st;
  try { st = fs.statSync(p); } catch { return; }
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(p).sort()) {
      if (n.startsWith('.')) continue; // .DS_Store、._* 等雜檔
      walk(path.join(p, n), out);
    }
  } else {
    out.push(`${path.relative(ROOT, p)}:${st.size}:${Math.floor(st.mtimeMs)}`);
  }
}

function fingerprint(list) {
  const out = [];
  for (const w of list) walk(path.join(ROOT, w), out);
  return crypto.createHash('sha1').update(out.join('\n')).digest('hex');
}

let child = null;
let runningFp = null;
let backoff = 1000;
let startedAt = 0;
let restarting = false;
let shuttingDown = false;

function start() {
  runningFp = fingerprint(WATCH);
  startedAt = Date.now();
  log(`啟動伺服器（指紋 ${runningFp.slice(0, 8)}）`);
  child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { stdio: 'inherit', env: process.env });
  child.on('exit', (code, sig) => {
    child = null;
    if (shuttingDown) return;
    if (restarting) return; // 由 restart() 處理
    const ranFor = Date.now() - startedAt;
    if (ranFor > 30_000) backoff = 1000;
    log(`伺服器結束（code=${code} signal=${sig}），${backoff}ms 後重試`);
    setTimeout(() => { if (!child && !shuttingDown) start(); }, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  });
}

function stopChild() {
  return new Promise((resolve) => {
    if (!child) return resolve();
    const c = child;
    const t = setTimeout(() => c.kill('SIGKILL'), 5000);
    c.once('exit', () => { clearTimeout(t); resolve(); });
    c.kill('SIGTERM');
  });
}

async function restart() {
  restarting = true;
  log('偵測到新版本，重新啟動伺服器…');
  await stopChild();
  restarting = false;
  backoff = 1000;
  start();
}

let lastSeen = fingerprint(WATCH);
let lastChangeAt = 0;
const selfFp0 = fingerprint(['supervisor.js']);

setInterval(() => {
  if (shuttingDown || restarting) return;
  if (fingerprint(['supervisor.js']) !== selfFp0) {
    // 自己被更新：等穩定後離開，交給 Docker 重新拉起
    setTimeout(() => {
      if (fingerprint(['supervisor.js']) !== selfFp0) {
        log('supervisor.js 已更新，結束行程以便容器重啟');
        shuttingDown = true;
        stopChild().then(() => process.exit(0));
      }
    }, SETTLE_MS);
    return;
  }
  const fp = fingerprint(WATCH);
  if (fp !== lastSeen) { lastSeen = fp; lastChangeAt = Date.now(); return; }
  if (fp !== runningFp && Date.now() - lastChangeAt >= SETTLE_MS) restart();
}, POLL_MS);

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  stopChild().then(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

start();
