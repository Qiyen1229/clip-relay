'use strict';
/*
 * Clip Relay 伺服器（零依賴）。
 *
 * 為了「方便」，本服務沒有存取令牌也沒有加密：任何能連到它的人都能讀寫。
 * 資料流：文字（明文，存記憶體）、檔案（原樣，存 DATA_DIR/files）、TTL、burn 旗標、
 *         id / 時間戳 / 大小、客戶端 IP（僅用於限流）。伺服器日誌不記錄任何內容。
 * 請只部署在可信任的內網，或在前面加上 Cloudflare Access 等閘道。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { Store } = require('./store');
const { RateLimiter } = require('./ratelimit');

const ROOT = path.resolve(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/manifest+json; charset=utf-8', // 僅有 manifest.json 放在 public/
  '.png': 'image/png',
};
const ID_RE = /^[A-Za-z0-9_-]{22}$/;
// 只有這些類型允許以 inline 方式回傳（供預覽）；其餘一律強制下載，避免同源 XSS（html/svg 等）
const INLINE_OK = /^(image\/(png|jpe?g|gif|webp|avif|bmp|heic|heif)|video\/(mp4|quicktime|webm|x-m4v)|audio\/(mpeg|mp4|x-m4a|aac|wav|x-wav|webm|ogg))$/i;
const MAX_PENDING_UPLOADS = 20;
const PENDING_TTL_MS = 60 * 60 * 1000;

function listFiles(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => path.join(dir, e.name))
      .sort();
  } catch { return []; }
}

/** 內容雜湊 = 「建置版本」。前端以此偵測伺服器是否已更新。 */
function computeBuild(root) {
  const h = crypto.createHash('sha256');
  const files = [
    path.join(root, 'package.json'),
    ...listFiles(path.join(root, 'src')),
    ...listFiles(path.join(root, 'public')),
  ];
  for (const f of files) {
    try { h.update(path.relative(root, f)).update(fs.readFileSync(f)); } catch { /* ignore */ }
  }
  return h.digest('hex').slice(0, 12);
}

function loadStatic(publicDir) {
  const map = new Map();
  for (const f of listFiles(publicDir)) {
    const buf = fs.readFileSync(f);
    const name = path.basename(f);
    map.set('/' + name, {
      buf,
      type: MIME[path.extname(name)] || 'application/octet-stream',
      etag: '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16) + '"',
    });
  }
  if (map.has('/index.html')) map.set('/', map.get('/index.html'));
  return map;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const h = req.headers;
    const v = h['cf-connecting-ip'] || h['x-real-ip'] || (h['x-forwarded-for'] || '').split(',')[0];
    if (v && v.trim()) return v.trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** 清理檔名：去掉路徑分隔、控制字元，限制長度；保留 Unicode */
function sanitizeName(name, fallback) {
  let n = String(name || '').normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]+/g, '_')
    .replace(/^[.\s]+|[\s]+$/g, '');
  if (n.length > 200) {
    const ext = path.extname(n).slice(0, 20);
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n || fallback;
}

function contentDisposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

function parseRange(h, size) {
  if (!h) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h);
  if (!m) return null; // 無法解析：忽略 Range，回傳完整內容
  const [, a, b] = m;
  if (a === '' && b === '') return 'bad';
  let start; let end;
  if (a === '') {
    const n = Number(b);
    if (n === 0) return 'bad';
    start = Math.max(0, size - n); end = size - 1;
  } else {
    start = Number(a);
    end = b === '' ? size - 1 : Math.min(Number(b), size - 1);
  }
  if (start >= size || start > end) return 'bad';
  return { start, end };
}

function createApp(config, { now = Date.now, store, root = ROOT } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const version = pkg.version;
  const build = computeBuild(root);
  const statics = loadStatic(path.join(root, 'public'));

  const filesDir = path.join(config.dataDir, 'files');
  const tmpDir = path.join(config.dataDir, 'tmp');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  const unlinkQuiet = (p) => fs.unlink(p, () => {});
  const fileOf = (id) => path.join(filesDir, id);
  const partOf = (id) => path.join(tmpDir, id);

  store = store || new Store({
    maxItems: config.maxItems,
    maxTotalBytes: config.maxTotalBytes,
    maxFileTotalBytes: config.maxFileTotalBytes,
    now,
    onRemove: (it) => { if (it.file && ID_RE.test(it.file)) unlinkQuiet(fileOf(it.file)); },
  });

  const pending = new Map(); // 上傳中的檔案：id -> { ... }

  const postLimiter = new RateLimiter({ limit: config.postRatePerMin, windowMs: 60_000, now });
  const readLimiter = new RateLimiter({ limit: config.readRatePerMin, windowMs: 60_000, now });
  const chunkLimiter = new RateLimiter({ limit: 3000, windowMs: 60_000, now });

  const publicConfig = () => ({
    maxItems: config.maxItems,
    maxItemBytes: config.maxItemBytes,
    maxFileBytes: config.maxFileBytes,
    chunkBytes: config.chunkBytes,
    ttlOptions: [60, 600, 3600, 86400].filter((t) => t >= config.minTtl && t <= config.maxTtl),
    defaultTtl: config.defaultTtl,
    minTtl: config.minTtl,
    maxTtl: config.maxTtl,
    serverTime: now(),
  });

  function send(res, status, body, extra = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extra,
    });
    res.end(payload);
  }
  const fail = (res, status, code, message, extra) =>
    send(res, status, { error: { code, message } }, extra);

  function meta(it) {
    return {
      id: it.id, seq: it.seq, kind: it.kind, size: it.size, createdAt: it.createdAt,
      expiresAt: it.expiresAt, burn: it.burn, name: it.name, mime: it.mime, fileCount: it.fileCount,
    };
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared) && declared > limit) return reject({ status: 413 });
      const chunks = [];
      let len = 0;
      req.on('data', (c) => {
        len += c.length;
        if (len > limit) {
          req.removeAllListeners('data');
          req.resume();
          return reject({ status: 413 });
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', () => reject({ status: 400 }));
    });
  }

  async function readJson(req, res, limit) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
      fail(res, 415, 'unsupported_media_type', 'Content-Type 必須為 application/json');
      return undefined;
    }
    let raw;
    try { raw = await readBody(req, limit); } catch (e) {
      if (e.status === 413) fail(res, 413, 'too_large', '請求內容過大', { Connection: 'close' });
      else fail(res, 400, 'bad_request', '無法讀取請求內容');
      return undefined;
    }
    let body;
    try { body = JSON.parse(raw); } catch { fail(res, 400, 'bad_json', 'JSON 格式錯誤'); return undefined; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      fail(res, 400, 'bad_request', '請求內容必須是 JSON 物件');
      return undefined;
    }
    return body;
  }

  function validTtl(ttl) {
    const ttlSec = ttl === undefined ? config.defaultTtl : ttl;
    return Number.isInteger(ttlSec) && ttlSec >= config.minTtl && ttlSec <= config.maxTtl ? ttlSec : null;
  }

  async function handleApi(req, res, url) {
    const p = url.pathname;
    res.setHeader('X-App-Build', build);
    const ip = clientIp(req, config.trustProxy);

    if (p === '/api/health') {
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', '不支援的方法');
      return send(res, 200, { ok: true, version, build, items: store.items.size });
    }

    const rl = readLimiter.hit(ip);
    if (!rl.ok) {
      return fail(res, 429, 'rate_limited', '請求過於頻繁', { 'Retry-After': String(rl.retryAfterSec) });
    }

    if (p === '/api/config') {
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', '不支援的方法');
      return send(res, 200, publicConfig());
    }

    if (p === '/api/items') {
      if (req.method === 'GET') return listItems(req, res);
      if (req.method === 'POST') return createText(req, res, ip);
      if (req.method === 'DELETE') {
        const n = store.clear();
        onMutate();
        return send(res, 200, { deleted: n });
      }
      return fail(res, 405, 'method_not_allowed', '不支援的方法');
    }

    // ---- 檔案分塊上傳 ----
    if (p === '/api/files') {
      if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', '不支援的方法');
      return createUpload(req, res, ip);
    }
    const fm = /^\/api\/files\/([^/]+)(\/complete)?$/.exec(p);
    if (fm) {
      const id = fm[1];
      if (!ID_RE.test(id)) return fail(res, 404, 'not_found', '找不到上傳工作');
      if (fm[2]) {
        if (req.method !== 'POST') return fail(res, 405, 'method_not_allowed', '不支援的方法');
        return completeUpload(res, id);
      }
      if (req.method === 'PUT') return putChunk(req, res, id, url, ip);
      if (req.method === 'DELETE') {
        if (!dropPending(id)) return fail(res, 404, 'not_found', '找不到上傳工作');
        return send(res, 204);
      }
      return fail(res, 405, 'method_not_allowed', '不支援的方法');
    }

    const cm = /^\/api\/items\/([^/]+)\/content$/.exec(p);
    if (cm) {
      if (req.method !== 'GET') return fail(res, 405, 'method_not_allowed', '不支援的方法');
      if (!ID_RE.test(cm[1])) return fail(res, 404, 'not_found', '找不到項目');
      return download(req, res, cm[1], url.searchParams.get('inline') === '1');
    }

    const im = /^\/api\/items\/([^/]+)$/.exec(p);
    if (im) {
      const id = im[1];
      if (!ID_RE.test(id)) return fail(res, 404, 'not_found', '找不到項目');
      if (req.method === 'GET') {
        const it = store.peek(id);
        if (!it) return fail(res, 404, 'not_found', '項目不存在、已過期或已被讀取');
        if (it.kind !== 'text') return send(res, 200, meta(it)); // 檔案：僅中繼資料；內容走 /content
        store.get(id); // 阅後即焚：取出即刪除（同步、原子）
        if (it.burn) onMutate();
        return send(res, 200, { ...meta(it), text: it.text });
      }
      if (req.method === 'DELETE') {
        if (!store.delete(id)) return fail(res, 404, 'not_found', '項目不存在或已過期');
        onMutate();
        return send(res, 204);
      }
      return fail(res, 405, 'method_not_allowed', '不支援的方法');
    }

    return fail(res, 404, 'not_found', '未知的 API 路徑');
  }

  function listItems(req, res) {
    const items = store.list(); // 先惰性清除過期，再算 ETag
    const etag = `"${build}-${store.rev}"`;
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'Cache-Control': 'no-store', ETag: etag, 'X-App-Build': build });
      return res.end();
    }
    const out = items.map((it) => {
      const o = meta(it);
      // 阅後即焚：列表絕不回傳內容；大文字也不內嵌，避免每次輪詢都搬大量資料
      o.text = it.kind === 'text' && !it.burn && it.size <= config.inlineTextBytes ? it.text : null;
      return o;
    });
    send(res, 200, { items: out, serverTime: now() }, { ETag: etag });
  }

  async function createText(req, res, ip) {
    const rl = postLimiter.hit(ip);
    if (!rl.ok) {
      return fail(res, 429, 'rate_limited', '發送過於頻繁，請稍後再試', { 'Retry-After': String(rl.retryAfterSec) });
    }
    // JSON 外殼與跳脫字元會讓 body 比文字本身大；先給 2 倍餘裕，之後再以 UTF-8 長度精確檢查
    const body = await readJson(req, res, config.maxItemBytes * 2 + 1024);
    if (!body) return undefined;
    const { text, ttl, burn } = body;
    if (typeof text !== 'string' || text.length === 0) {
      return fail(res, 400, 'bad_text', 'text 必須是非空字串');
    }
    const ttlSec = validTtl(ttl);
    if (ttlSec === null) {
      return fail(res, 400, 'bad_ttl', `ttl 必須是 ${config.minTtl}~${config.maxTtl} 之間的整數（秒）`);
    }
    if (burn !== undefined && typeof burn !== 'boolean') {
      return fail(res, 400, 'bad_burn', 'burn 必須是布林值');
    }
    const size = Buffer.byteLength(text, 'utf8');
    if (size > config.maxItemBytes) {
      return fail(res, 413, 'too_large', `內容超過上限 ${config.maxItemBytes} bytes`);
    }
    const it = store.add({ kind: 'text', text, size, ttlSec, burn });
    onMutate();
    return send(res, 201, meta(it));
  }

  // ---- 檔案：建立上傳 → 分塊 PUT → 完成 ----
  function dropPending(id) {
    const u = pending.get(id);
    if (!u) return false;
    pending.delete(id);
    unlinkQuiet(partOf(id));
    return true;
  }

  async function createUpload(req, res, ip) {
    const rl = postLimiter.hit(ip);
    if (!rl.ok) {
      return fail(res, 429, 'rate_limited', '發送過於頻繁，請稍後再試', { 'Retry-After': String(rl.retryAfterSec) });
    }
    const body = await readJson(req, res, 8 * 1024);
    if (!body) return undefined;
    const { name, size, mime, ttl, burn, kind, fileCount } = body;
    if (!Number.isInteger(size) || size < 0) return fail(res, 400, 'bad_size', 'size 必須是非負整數');
    if (size > config.maxFileBytes) {
      return fail(res, 413, 'too_large', `檔案超過上限 ${config.maxFileBytes} bytes`);
    }
    if (size > config.maxFileTotalBytes) {
      return fail(res, 413, 'too_large', '檔案超過伺服器檔案總容量');
    }
    const ttlSec = validTtl(ttl);
    if (ttlSec === null) return fail(res, 400, 'bad_ttl', 'ttl 不合法');
    if (burn !== undefined && typeof burn !== 'boolean') return fail(res, 400, 'bad_burn', 'burn 必須是布林值');
    if (kind !== undefined && kind !== 'file' && kind !== 'folder') return fail(res, 400, 'bad_kind', 'kind 不合法');
    if (fileCount !== undefined && (!Number.isInteger(fileCount) || fileCount < 0 || fileCount > 1e6)) {
      return fail(res, 400, 'bad_file_count', 'fileCount 不合法');
    }
    if (mime !== undefined && (typeof mime !== 'string' || mime.length > 120)) {
      return fail(res, 400, 'bad_mime', 'mime 不合法');
    }
    if (pending.size >= MAX_PENDING_UPLOADS) {
      return fail(res, 429, 'too_many_uploads', '同時上傳的檔案過多，請稍後再試');
    }
    try {
      const st = fs.statfsSync(tmpDir);
      if (st.bavail * st.bsize < size + config.minFreeDiskBytes) {
        return fail(res, 507, 'insufficient_storage', '伺服器磁碟空間不足');
      }
    } catch { /* 無法取得磁碟資訊就略過 */ }

    const id = crypto.randomBytes(16).toString('base64url');
    const k = kind || 'file';
    const fallback = k === 'folder' ? 'folder.zip' : 'file';
    let safeName = sanitizeName(name, fallback);
    if (k === 'folder' && !/\.zip$/i.test(safeName)) safeName += '.zip';
    fs.writeFileSync(partOf(id), '');
    pending.set(id, {
      id, name: safeName, size, kind: k, fileCount: k === 'folder' ? (fileCount ?? null) : null,
      mime: (typeof mime === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(mime)) ? mime.toLowerCase() : 'application/octet-stream',
      ttlSec, burn: burn === true, received: 0, busy: false, createdAt: now(),
    });
    return send(res, 201, { id, chunkBytes: config.chunkBytes });
  }

  async function putChunk(req, res, id, url, ip) {
    const rl = chunkLimiter.hit(ip);
    if (!rl.ok) {
      return fail(res, 429, 'rate_limited', '上傳過於頻繁', { 'Retry-After': String(rl.retryAfterSec) });
    }
    const u = pending.get(id);
    if (!u) return fail(res, 404, 'not_found', '上傳工作不存在或已逾時');
    if (u.busy) return fail(res, 409, 'busy', '此上傳工作正在寫入');
    const offset = Number(url.searchParams.get('offset'));
    if (!Number.isInteger(offset) || offset !== u.received) {
      return fail(res, 409, 'bad_offset', `offset 不符，伺服器已接收 ${u.received} bytes`);
    }
    const declared = Number(req.headers['content-length']);
    const maxChunk = Math.min(config.chunkBytes * 2, u.size - u.received);
    if (Number.isFinite(declared) && declared > maxChunk) {
      return fail(res, 413, 'too_large', '分塊過大或超出宣告大小', { Connection: 'close' });
    }
    u.busy = true;
    const part = partOf(id);
    try {
      fs.truncateSync(part, u.received); // 先前失敗的半塊資料一律丟棄，讓重試安全
      let n = 0;
      const counter = new Transform({
        transform(chunk, enc, cb) {
          n += chunk.length;
          if (n > maxChunk) return cb(new Error('chunk too large'));
          return cb(null, chunk);
        },
      });
      await pipeline(req, counter, fs.createWriteStream(part, { flags: 'a' }));
      u.received += n;
      u.busy = false;
      u.touched = now();
      return send(res, 200, { received: u.received });
    } catch (e) {
      u.busy = false;
      try { fs.truncateSync(part, u.received); } catch { /* ignore */ }
      if (!res.headersSent && !res.destroyed) fail(res, 400, 'upload_failed', '分塊寫入失敗', { Connection: 'close' });
      return undefined;
    }
  }

  function completeUpload(res, id) {
    const u = pending.get(id);
    if (!u) return fail(res, 404, 'not_found', '上傳工作不存在或已逾時');
    if (u.busy) return fail(res, 409, 'busy', '此上傳工作正在寫入');
    if (u.received !== u.size) {
      return fail(res, 409, 'incomplete', `尚未收完：${u.received}/${u.size} bytes`);
    }
    try {
      fs.renameSync(partOf(id), fileOf(id));
    } catch {
      pending.delete(id);
      return fail(res, 500, 'internal', '無法儲存檔案');
    }
    pending.delete(id);
    const it = store.add({
      id, kind: u.kind, name: u.name, mime: u.mime, file: id, fileCount: u.fileCount,
      size: u.size, ttlSec: u.ttlSec, burn: u.burn,
    });
    onMutate();
    return send(res, 201, meta(it));
  }

  function download(req, res, id, inline) {
    const it = store.peek(id);
    if (!it || it.kind === 'text') return fail(res, 404, 'not_found', '項目不存在、已過期或已被讀取');
    let fd;
    try { fd = fs.openSync(fileOf(it.file), 'r'); } catch {
      store.delete(id);
      onMutate();
      return fail(res, 404, 'not_found', '檔案已不存在');
    }
    // 先開啟檔案，再 claim（阅後即焚會在此刻刪索引與磁碟檔；已開啟的 fd 仍可讀完）
    const burn = it.burn;
    if (burn) { store.get(id); onMutate(); }

    const canInline = inline && it.kind === 'file' && !burn && INLINE_OK.test(it.mime || '');
    const headers = {
      'Content-Type': canInline ? it.mime : 'application/octet-stream',
      'Content-Disposition': contentDisposition(canInline ? 'inline' : 'attachment', it.name || 'file'),
      'Cache-Control': 'private, no-store',
      'Accept-Ranges': burn ? 'none' : 'bytes',
      // 即使被當成頁面開啟也不得執行任何腳本
      'Content-Security-Policy': "default-src 'none'; sandbox",
    };
    const range = burn ? null : parseRange(req.headers.range, it.size);
    let status = 200; let start = 0; let end = it.size - 1;
    if (range === 'bad') {
      fs.closeSync(fd);
      return res.writeHead(416, { 'Content-Range': `bytes */${it.size}`, ...headers }) && res.end();
    }
    if (range) {
      status = 206; start = range.start; end = range.end;
      headers['Content-Range'] = `bytes ${start}-${end}/${it.size}`;
    }
    const length = it.size === 0 ? 0 : end - start + 1;
    headers['Content-Length'] = length;
    res.writeHead(status, headers);
    if (length === 0) { fs.closeSync(fd); return res.end(); }
    const rs = fs.createReadStream(null, { fd, start, end, autoClose: true });
    rs.on('error', () => res.destroy());
    res.on('close', () => rs.destroy());
    rs.pipe(res);
    return undefined;
  }

  function serveStatic(req, res, p) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }
    // 只服務啟動時載入的白名單檔案，天然免疫路徑穿越
    const f = statics.get(p);
    if (!f) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Not Found');
    }
    const headers = {
      'Content-Type': f.type,
      'Cache-Control': 'no-cache', // 每次向伺服器驗證 ETag，更新後立即生效
      ETag: f.etag,
    };
    if (req.headers['if-none-match'] === f.etag) {
      res.writeHead(304, headers);
      return res.end();
    }
    res.writeHead(200, { ...headers, 'Content-Length': f.buf.length });
    return res.end(req.method === 'HEAD' ? undefined : f.buf);
  }

  // ---- 持久化（可選）。文字為明文，0600 權限；檔案本身就在資料卷 ----
  const snapFile = path.join(config.dataDir, 'items.json');
  let persistTimer = null;
  function onMutate() {
    if (!config.persist || persistTimer) return;
    persistTimer = setTimeout(() => { persistTimer = null; flush(); }, 500);
    persistTimer.unref();
  }
  function flush() {
    if (!config.persist) return;
    try {
      const tmp = snapFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(store.snapshot()), { mode: 0o600 });
      fs.renameSync(tmp, snapFile);
    } catch (e) { console.warn('[persist] 寫入失敗：' + e.message); }
  }

  // ---- 啟動時的清理與還原 ----
  for (const f of fs.readdirSync(tmpDir)) unlinkQuiet(path.join(tmpDir, f)); // 中斷的上傳一律丟棄
  if (config.persist) {
    try {
      store.restore(JSON.parse(fs.readFileSync(snapFile, 'utf8')),
        (it) => it.kind === 'text' || (ID_RE.test(it.file || '') && fs.existsSync(fileOf(it.file))));
    } catch { /* 無快照 */ }
  }
  for (const f of fs.readdirSync(filesDir)) { // 沒有索引對應的孤兒檔
    const it = store.items.get(f);
    if (!it || !it.file) unlinkQuiet(path.join(filesDir, f));
  }

  const server = http.createServer((req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
      "img-src 'self' data:; media-src 'self'; manifest-src 'self'; base-uri 'none'; " +
      "form-action 'none'; frame-ancestors 'none'");
    let url;
    try { url = new URL(req.url, 'http://local'); } catch {
      res.writeHead(400); return res.end();
    }
    const run = url.pathname.startsWith('/api/')
      ? handleApi(req, res, url)
      : Promise.resolve(serveStatic(req, res, url.pathname));
    run.catch((e) => {
      console.error('[error]', e && e.message);
      if (!res.headersSent) fail(res, 500, 'internal', '伺服器內部錯誤');
      else res.end();
    });
  });
  // 單一分塊最多 chunkBytes*2；行動網路上傳可能很慢，放寬逾時
  server.requestTimeout = 5 * 60_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  // ---- 定時清理（主動刪除）。與讀取時的惰性刪除互補 ----
  const sweepTimer = setInterval(() => {
    const n = store.sweep();
    if (n) onMutate();
    for (const [id, u] of pending) {
      if (!u.busy && now() - (u.touched || u.createdAt) > PENDING_TTL_MS) dropPending(id);
    }
    postLimiter.prune(); readLimiter.prune(); chunkLimiter.prune();
  }, config.sweepIntervalMs);
  sweepTimer.unref();

  function close() {
    clearInterval(sweepTimer);
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    flush();
    return new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
  }

  return { server, store, close, sweep: () => store.sweep(), version, build, pending, filesDir, tmpDir };
}

module.exports = { createApp };

if (require.main === module) {
  const { loadConfig } = require('./config');
  const config = loadConfig();
  const app = createApp(config);
  app.server.listen(config.port, config.host, () => {
    console.log(`[clip-relay] v${app.version} build ${app.build} 監聽 http://${config.host}:${config.port}`);
    console.log(`[clip-relay] 文字 ${config.maxItemBytes} bytes / 檔案單檔 ${config.maxFileBytes} bytes、總量 ${config.maxFileTotalBytes} bytes / 預設 TTL ${config.defaultTtl}s / 持久化 ${config.persist ? '開' : '關'}`);
    console.log('[clip-relay] 無存取令牌、無加密：請只部署在可信任的內網，或在前面加上 Cloudflare Access。');
  });
  const stop = async () => { await app.close(); process.exit(0); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
