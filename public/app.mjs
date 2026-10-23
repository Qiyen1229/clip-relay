// Clip Relay 前端（無登入、無加密）。
// 安全原則：所有使用者內容（文字、檔名）只用 textContent / setAttribute 寫入 DOM（絕不使用 innerHTML）。
import { buildZip, cleanPath } from '/zip.mjs';

const $ = (id) => document.getElementById(id);
const LS_TTL = 'clip.ttl';
const TTL_LABEL = { 60: '1 分鐘', 600: '10 分鐘', 3600: '1 小時', 86400: '24 小時' };
const enc = new TextEncoder();

const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* 隱私模式 */ } },
};

let cfg = { maxItemBytes: 1024 * 1024, maxFileBytes: 1024 ** 3, chunkBytes: 4 * 1024 * 1024, ttlOptions: [60, 600, 3600, 86400], defaultTtl: 600 };
let items = [];                 // 伺服器回傳的項目（新到舊）
const texts = new Map();        // id -> 完整文字（非阅後即焚）
const pending = new Set();
let etag = '';
let skew = 0;                   // 伺服器時間 - 本機時間
let polling = false;
let pollTimer = null;
let initialBuild = '';
let countdownEls = [];

// ---------- UI 基礎 ----------
let toastTimer = null;
function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('err', isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 4500 : 2200);
}

function setConn(state) {
  const c = $('conn');
  c.classList.toggle('ok', state === 'ok');
  c.classList.toggle('bad', state === 'bad');
  c.title = state === 'ok' ? '已連線' : state === 'bad' ? '連線失敗' : '連線中…';
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method, headers: h, cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const build = res.headers.get('X-App-Build');
  if (build) {
    if (!initialBuild) initialBuild = build;
    else if (build !== initialBuild) $('banner').hidden = false;
  }
  if (raw && res.status === 304) return { res, data: null };
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const e = data && data.error;
    throw new ApiError(res.status, (e && e.message) || `請求失敗（HTTP ${res.status}）`);
  }
  return raw ? { res, data } : data;
}

// ---------- 剪貼簿 ----------
function legacyCopy(text) {
  // 非安全情境（HTTP 內網）下的降級方案：隱藏 textarea + execCommand
  const prev = document.activeElement;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none;font-size:16px;';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  if (prev && prev.focus) prev.focus();
  return ok;
}

/** textP: Promise<string>。回傳 { ok, text?, error? }；失敗時保留 text 供手動複製。 */
async function copyToClipboard(textP) {
  textP.catch(() => {});
  const secure = window.isSecureContext && navigator.clipboard;
  if (secure && window.ClipboardItem && navigator.clipboard.write) {
    // 傳入 Promise，讓 Safari 在使用者手勢內保留寫入資格（阅後即焚需先非同步取回內容）
    try {
      const blobP = textP.then((t) => new Blob([t], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blobP })]);
      return { ok: true };
    } catch { /* 改走備援 */ }
  }
  let text;
  try { text = await textP; } catch (error) { return { ok: false, error }; }
  if (secure) {
    try { await navigator.clipboard.writeText(text); return { ok: true, text }; } catch { /* 繼續 */ }
  }
  if (legacyCopy(text)) return { ok: true, text };
  return { ok: false, text };
}

function showManual(text, msg) {
  $('manual-msg').textContent = msg;
  const ta = $('manual-text');
  ta.value = text;
  const d = $('manual-dialog');
  if (!d.open) d.showModal();
  ta.focus();
  ta.select();
}

// ---------- 列表 ----------
function fmtRemain(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} 時 ${Math.floor((s % 3600) / 60)} 分`;
  if (s >= 60) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${s} 秒`;
}
const nowServer = () => Date.now() + skew;
function fmtSize(n) {
  return n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
}

function render() {
  const list = $('list');
  list.textContent = '';
  countdownEls = [];
  $('count').textContent = items.length ? `(${items.length})` : '';
  $('empty').hidden = items.length > 0;
  for (const it of items) {
    const li = document.createElement('li');
    li.className = 'item';

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'item-main';
    main.addEventListener('click', () => (it.kind === 'text' ? onCopy(it) : onDownload(it)));

    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const time = document.createElement('span');
    time.textContent = new Date(it.createdAt).toLocaleTimeString();
    const remain = document.createElement('span');
    countdownEls.push([remain, it.expiresAt]);
    const size = document.createElement('span');
    size.textContent = fmtSize(it.size);
    meta.append(time, remain, size);

    let body = document.createElement('pre');
    body.className = 'item-text';
    if (it.kind !== 'text') {
      body = fileBlock(it);
      if (it.burn) {
        const b = document.createElement('span');
        b.className = 'badge-burn';
        b.textContent = '🔥 一次性';
        meta.append(b);
      }
    } else if (it.burn) {
      const b = document.createElement('span');
      b.className = 'badge-burn';
      b.textContent = '🔥 一次性';
      meta.append(b);
      body.textContent = '點擊後取出並刪除（只能讀取一次）';
    } else if (texts.has(it.id)) {
      const t = texts.get(it.id);
      body.textContent = t.length > 2000 ? t.slice(0, 2000) + '…' : t;
    } else {
      body.textContent = '載入中…';
    }
    main.append(meta, body);

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'item-del';
    del.setAttribute('aria-label', '刪除這一筆');
    del.textContent = '✕';
    del.addEventListener('click', () => onDelete(it));

    if (it.kind === 'file' && !it.burn && previewKind(it)) {
      const pv = document.createElement('button');
      pv.type = 'button';
      pv.className = 'item-preview';
      pv.setAttribute('aria-label', '預覽');
      pv.textContent = '👁';
      pv.addEventListener('click', () => openPreview(it));
      li.append(main, pv, del);
    } else {
      li.append(main, del);
    }
    list.append(li);
  }
  tick();
}

function tick() {
  const t = nowServer();
  let expired = false;
  for (const [el, exp] of countdownEls) {
    const left = exp - t;
    if (left <= 0) expired = true;
    el.textContent = '剩 ' + fmtRemain(left);
  }
  if (expired) {
    items = items.filter((it) => it.expiresAt > t);
    render();
  }
}

async function ensureText(it) {
  if (it.kind !== 'text' || it.burn || texts.has(it.id)) return;
  if (it.text !== null && it.text !== undefined) { texts.set(it.id, it.text); return; }
  if (pending.has(it.id)) return;
  pending.add(it.id);
  try {
    texts.set(it.id, (await api('/api/items/' + it.id)).text);
  } catch { /* 可能剛好過期或被刪，下一輪輪詢會修正 */ }
  finally { pending.delete(it.id); }
  render();
}


// ---------- 檔案項目顯示 ----------
const THUMB_MAX = 8 * 1024 * 1024;
const contentUrl = (it, inline) => `/api/items/${it.id}/content${inline ? '?inline=1' : ''}`;

function previewKind(it) {
  const m = (it.mime || '').toLowerCase();
  if (/^image\/(png|jpe?g|gif|webp|avif|bmp|heic|heif)$/.test(m)) return 'image';
  if (/^video\/(mp4|quicktime|webm|x-m4v)$/.test(m)) return 'video';
  if (/^audio\/(mpeg|mp4|x-m4a|aac|wav|x-wav|webm|ogg)$/.test(m)) return 'audio';
  return '';
}

function fileBlock(it) {
  const box = document.createElement('div');
  box.className = 'item-file';
  const kind = previewKind(it);
  const icon = document.createElement('span');
  icon.className = 'icon';
  icon.textContent = it.kind === 'folder' ? '📁' : kind === 'image' ? '🖼️' : kind === 'video' ? '🎬' : kind === 'audio' ? '🎵' : '📄';
  if (it.kind === 'file' && kind === 'image' && !it.burn && it.size <= THUMB_MAX) {
    const img = document.createElement('img');
    img.className = 'thumb';
    img.loading = 'lazy';
    img.alt = '';
    img.src = contentUrl(it, true);
    img.addEventListener('error', () => img.replaceWith(icon)); // 例如瀏覽器不支援 HEIC
    box.append(img);
  } else {
    box.append(icon);
  }
  const txt = document.createElement('div');
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = it.name || '(未命名)';
  const sub = document.createElement('div');
  sub.className = 'muted';
  sub.textContent = it.kind === 'folder'
    ? `資料夾（${it.fileCount ?? '?'} 個檔案，zip）`
    : (it.burn ? '點擊下載後即刪除' : (it.mime || '檔案'));
  txt.append(name, sub);
  box.append(txt);
  return box;
}

function onDownload(it) {
  const a = document.createElement('a');
  a.href = contentUrl(it, false);
  a.download = it.name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(it.burn ? '開始下載（下載後即從伺服器刪除）' : '開始下載');
  if (it.burn) setTimeout(pollNow, 1500);
}

function openPreview(it) {
  const body = $('preview-body');
  body.textContent = '';
  const kind = previewKind(it);
  const el = document.createElement(kind === 'image' ? 'img' : kind);
  if (kind !== 'image') { el.controls = true; el.playsInline = true; }
  el.src = contentUrl(it, true);
  el.addEventListener('error', () => { body.textContent = '此瀏覽器無法預覽，請改用下載。'; });
  body.append(el);
  const d = $('preview-dialog');
  d.addEventListener('close', () => { body.textContent = ''; }, { once: true });
  d.showModal();
}

// ---------- 檔案上傳 ----------
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|\._[^/]*)$/i;
const uploads = [];     // { id, label, state, progress, controller, text }
const jobQueue = [];
let running = false;
let uploadSeq = 0;

function renderUploads() {
  const ul = $('uploads');
  ul.textContent = '';
  for (const u of uploads) {
    const li = document.createElement('li');
    li.className = 'upload' + (u.state === 'error' ? ' err' : '');
    const name = document.createElement('div');
    name.className = 'u-name';
    name.textContent = u.label;
    const status = document.createElement('div');
    status.className = 'u-status muted';
    status.textContent = u.text;
    const bar = document.createElement('progress');
    bar.max = 1;
    bar.value = u.progress;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost u-cancel';
    btn.textContent = u.state === 'running' || u.state === 'queued' ? '取消' : '移除';
    btn.addEventListener('click', () => {
      if (u.state === 'running' || u.state === 'queued') {
        u.cancelled = true;
        if (u.controller) u.controller.abort();
        if (u.state === 'queued') finish(u, 'error', '已取消');
      } else {
        uploads.splice(uploads.indexOf(u), 1);
        renderUploads();
      }
    });
    li.append(name, btn, status, bar);
    if (u.state === 'done') bar.value = 1;
    ul.append(li);
  }
}

function finish(u, state, text) {
  u.state = state;
  u.text = text;
  if (state === 'done') {
    setTimeout(() => {
      const i = uploads.indexOf(u);
      if (i >= 0) { uploads.splice(i, 1); renderUploads(); }
    }, 4000);
  }
  renderUploads();
}

async function chunkPut(id, blob, offset, signal) {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    try {
      const res = await fetch(`/api/files/${id}?offset=${offset}`, {
        method: 'PUT', body: blob, signal, cache: 'no-store',
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (res.ok) return;
      let msg = `上傳失敗（HTTP ${res.status}）`;
      try { msg = (await res.json()).error.message || msg; } catch { /* ignore */ }
      if (res.status < 500 && res.status !== 400) throw new ApiError(res.status, msg); // 不重試
      lastErr = new ApiError(res.status, msg);
    } catch (e) {
      if (e.name === 'AbortError' || e instanceof ApiError) throw e;
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
  }
  throw lastErr || new Error('上傳失敗');
}

async function uploadBlob(blob, m, onProgress, signal) {
  const created = await api('/api/files', {
    method: 'POST',
    body: {
      name: m.name, size: blob.size, mime: m.mime || 'application/octet-stream',
      ttl: m.ttl, burn: m.burn, kind: m.kind, ...(m.fileCount !== undefined ? { fileCount: m.fileCount } : {}),
    },
  });
  const chunk = created.chunkBytes || cfg.chunkBytes;
  try {
    let offset = 0;
    while (offset < blob.size) {
      const end = Math.min(offset + chunk, blob.size);
      await chunkPut(created.id, blob.slice(offset, end), offset, signal);
      offset = end;
      onProgress(offset / blob.size);
    }
    await api(`/api/files/${created.id}/complete`, { method: 'POST' });
  } catch (e) {
    fetch(`/api/files/${created.id}`, { method: 'DELETE', cache: 'no-store' }).catch(() => {});
    throw e;
  }
}

async function runQueue() {
  if (running) return;
  running = true;
  while (jobQueue.length) {
    const { u, run } = jobQueue.shift();
    if (u.cancelled) continue;
    u.state = 'running';
    u.controller = new AbortController();
    u.text = '上傳中…';
    renderUploads();
    try {
      await run(u);
      finish(u, 'done', '完成');
      pollNow();
    } catch (e) {
      finish(u, 'error', u.cancelled || e.name === 'AbortError' ? '已取消' : (e.message || '上傳失敗'));
    }
  }
  running = false;
}

function enqueue(label, run) {
  const u = { id: ++uploadSeq, label, state: 'queued', progress: 0, text: '等待中', cancelled: false };
  uploads.push(u);
  jobQueue.push({ u, run });
  renderUploads();
  runQueue();
}

function opts() {
  return { ttl: Number($('ttl-select').value), burn: $('burn-check').checked };
}

function enqueueFile(file) {
  const o = opts();
  if (file.size > cfg.maxFileBytes) {
    toast(`「${file.name}」${fmtSize(file.size)} 超過上限 ${fmtSize(cfg.maxFileBytes)}`, true);
    return;
  }
  enqueue(file.name, (u) => uploadBlob(file, {
    name: file.name, mime: file.type, kind: 'file', ...o,
  }, (p) => { u.progress = p; u.text = `${Math.round(p * 100)}%`; renderUploads(); }, u.controller.signal));
}

function enqueueFolder(name, entries) {
  const o = opts();
  const files = entries.filter((e) => !JUNK.test(e.path));
  if (!files.length) { toast(`資料夾「${name}」是空的`, true); return; }
  const total = files.reduce((a, e) => a + e.file.size, 0);
  if (total > cfg.maxFileBytes) {
    toast(`資料夾「${name}」${fmtSize(total)} 超過上限 ${fmtSize(cfg.maxFileBytes)}`, true);
    return;
  }
  enqueue(`📁 ${name}（${files.length} 個檔案）`, async (u) => {
    u.text = '打包中…';
    renderUploads();
    const { blob, count } = await buildZip(files, (d, t) => { u.text = `打包中 ${d}/${t}`; renderUploads(); });
    await uploadBlob(blob, {
      name: name + '.zip', mime: 'application/zip', kind: 'folder', fileCount: count, ...o,
    }, (p) => { u.progress = p; u.text = `${Math.round(p * 100)}%`; renderUploads(); }, u.controller.signal);
  });
}

/** <input webkitdirectory> 的結果：依第一層資料夾名稱分組 */
function handleFolderInput(fileList) {
  const groups = new Map();
  const loose = [];
  for (const f of fileList) {
    const rel = f.webkitRelativePath;
    if (!rel || !rel.includes('/')) { loose.push(f); continue; }
    const top = rel.split('/')[0];
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push({ path: cleanPath(rel), file: f });
  }
  for (const [name, entries] of groups) enqueueFolder(name, entries);
  if (loose.length) {
    // iOS Safari 等不支援選資料夾的瀏覽器：退化為一般檔案選擇
    for (const f of loose) enqueueFile(f);
  }
}

const readAll = (reader) => new Promise((resolve, reject) => {
  const all = [];
  const next = () => reader.readEntries((batch) => {
    if (!batch.length) return resolve(all);
    all.push(...batch);
    return next();
  }, reject);
  next();
});
async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + entry.name, file });
  } else if (entry.isDirectory) {
    for (const c of await readAll(entry.createReader())) await walkEntry(c, prefix + entry.name + '/', out);
  }
}

async function handleDrop(dt) {
  const entries = [];
  if (dt.items) {
    for (const item of dt.items) {
      if (item.kind !== 'file') continue;
      const en = item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
      entries.push(en || item.getAsFile());
    }
  }
  if (!entries.length) { for (const f of dt.files) enqueueFile(f); return; }
  for (const en of entries) {
    if (!en) continue;
    if (en instanceof File) { enqueueFile(en); continue; }
    if (en.isFile) {
      try { enqueueFile(await new Promise((res, rej) => en.file(res, rej))); } catch { toast('無法讀取檔案', true); }
    } else if (en.isDirectory) {
      try {
        const out = [];
        await walkEntry(en, '', out);
        enqueueFolder(en.name, out);
      } catch { toast(`無法讀取資料夾「${en.name}」`, true); }
    }
  }
}

function bindUploadEvents() {
  $('pick-files').addEventListener('click', () => $('file-input').click());
  $('pick-photos').addEventListener('click', () => $('photo-input').click());
  $('pick-folder').addEventListener('click', () => $('folder-input').click());
  for (const id of ['file-input', 'photo-input']) {
    $(id).addEventListener('change', (e) => {
      for (const f of e.target.files) enqueueFile(f);
      e.target.value = '';
    });
  }
  $('folder-input').addEventListener('change', (e) => {
    handleFolderInput(e.target.files);
    e.target.value = '';
  });

  const zone = $('drop-zone');
  let depth = 0;
  document.addEventListener('dragenter', (e) => { e.preventDefault(); depth++; zone.classList.add('dragover'); });
  document.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) zone.classList.remove('dragover'); });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('dragover');
    if (e.dataTransfer) handleDrop(e.dataTransfer);
  });
  document.addEventListener('paste', (e) => {
    const files = e.clipboardData && e.clipboardData.files;
    if (files && files.length) {
      e.preventDefault();
      for (const f of files) enqueueFile(f);
    }
  });
}

// ---------- 輪詢 ----------
async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const { res, data } = await api('/api/items', { headers: etag ? { 'If-None-Match': etag } : {}, raw: true });
    setConn('ok');
    if (res.status !== 304) {
      etag = res.headers.get('ETag') || '';
      skew = data.serverTime - Date.now();
      items = data.items;
      const ids = new Set(items.map((i) => i.id));
      for (const id of texts.keys()) if (!ids.has(id)) texts.delete(id);
      for (const it of items) if (it.kind === 'text' && !it.burn && typeof it.text === 'string') texts.set(it.id, it.text);
      render();
      for (const it of items) ensureText(it);
    }
  } catch { setConn('bad'); } finally { polling = false; }
}

function schedule() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(async () => {
    await pollOnce();
    schedule();
  }, document.hidden ? 10000 : 2000);
}

function pollNow() {
  etag = '';
  return pollOnce();
}

// ---------- 動作 ----------
async function onCopy(it) {
  let memo = null;
  const getText = () => (memo ||= (async () => {
    if (!it.burn && texts.has(it.id)) return texts.get(it.id);
    const full = await api('/api/items/' + it.id); // 阅後即焚：此呼叫成功即代表伺服器已刪除
    if (it.burn) {
      items = items.filter((x) => x.id !== it.id);
      render();
    }
    return full.text;
  })());
  const r = await copyToClipboard(getText());
  if (r.ok) {
    toast(it.burn ? '已複製（這一筆已從伺服器刪除）' : '已複製到剪貼簿');
  } else if (r.text !== undefined) {
    showManual(r.text, it.burn
      ? '瀏覽器未允許自動複製，而這一筆已被刪除，請立即手動複製以下內容：'
      : '瀏覽器未允許自動複製，請手動複製：');
    toast('自動複製失敗', true);
  } else {
    toast((r.error && r.error.message) || '讀取失敗', true);
  }
  if (it.burn) pollNow();
}

async function onDelete(it) {
  try {
    await api('/api/items/' + it.id, { method: 'DELETE' });
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 404)) { toast(e.message, true); return; }
  }
  items = items.filter((x) => x.id !== it.id);
  texts.delete(it.id);
  render();
  pollNow();
}

async function onSend() {
  const input = $('text-input');
  const text = input.value;
  if (!text.trim()) { toast('請先輸入要傳送的文字', true); return; }
  const bytes = enc.encode(text).length;
  if (bytes > cfg.maxItemBytes) {
    toast(`內容 ${fmtSize(bytes)} 超過上限 ${fmtSize(cfg.maxItemBytes)}`, true);
    return;
  }
  const btn = $('send-btn');
  btn.disabled = true;
  try {
    await api('/api/items', {
      method: 'POST',
      body: { text, ttl: Number($('ttl-select').value), burn: $('burn-check').checked },
    });
    input.value = '';
    updateSizeHint();
    toast('已傳送');
    pollNow();
  } catch (e) {
    toast(e.message || '傳送失敗', true);
  } finally {
    btn.disabled = false;
  }
}

function updateSizeHint() {
  $('size-hint').textContent = `${fmtSize(enc.encode($('text-input').value).length)} / ${fmtSize(cfg.maxItemBytes)}`;
}

function fillTtl() {
  const sel = $('ttl-select');
  sel.textContent = '';
  const saved = Number(store.get(LS_TTL));
  const pick = cfg.ttlOptions.includes(saved) ? saved : cfg.defaultTtl;
  for (const t of cfg.ttlOptions) {
    const o = document.createElement('option');
    o.value = String(t);
    o.textContent = TTL_LABEL[t] || t + ' 秒';
    if (t === pick) o.selected = true;
    sel.append(o);
  }
}

function bindEvents() {
  bindUploadEvents();
  $('reload-btn').addEventListener('click', () => location.reload());
  $('send-btn').addEventListener('click', onSend);
  $('ttl-select').addEventListener('change', (e) => store.set(LS_TTL, e.target.value));
  $('text-input').addEventListener('input', updateSizeHint);
  $('text-input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); onSend(); }
  });
  if (window.isSecureContext && navigator.clipboard && navigator.clipboard.readText) {
    $('paste-btn').hidden = false;
    $('paste-btn').addEventListener('click', async () => {
      try {
        $('text-input').value = await navigator.clipboard.readText();
        updateSizeHint();
      } catch { toast('瀏覽器未允許讀取剪貼簿，請直接貼上', true); }
    });
  }
  $('clear-btn').addEventListener('click', async () => {
    if (!items.length || !confirm('確定要清除全部紀錄嗎？')) return;
    try { await api('/api/items', { method: 'DELETE' }); toast('已全部清除'); pollNow(); } catch (e) { toast(e.message, true); }
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { pollNow(); schedule(); } });
  setInterval(tick, 1000);
}

async function init() {
  bindEvents();
  setConn('');
  try { cfg = await api('/api/config'); } catch { setConn('bad'); }
  fillTtl();
  updateSizeHint();
  await pollOnce();
  schedule();
}

init();
