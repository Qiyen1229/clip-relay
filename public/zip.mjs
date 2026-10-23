// 極簡 ZIP 打包器（只存放、不壓縮；UTF-8 檔名；瀏覽器與 Node 測試共用）。
// 以 Blob 片段組合，不會把整個資料夾讀進記憶體；CRC32 以串流方式逐塊計算。
// 限制：不含 ZIP64，總大小與單檔皆需 < 4 GiB，項目數 < 65535。

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** 可串接計算：crc32(b2, crc32(b1)) === crc32(b1+b2) */
export function crc32(bytes, prev = 0) {
  let c = (prev ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function fileCrc(file) {
  let crc = 0;
  if (file.stream) {
    const reader = file.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      crc = crc32(value, crc);
    }
  } else {
    crc = crc32(new Uint8Array(await file.arrayBuffer()));
  }
  return crc;
}

function dosDateTime(ms) {
  const d = new Date(ms || Date.now());
  const y = Math.max(1980, d.getFullYear());
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function cleanPath(p) {
  return String(p).replace(/\\/g, '/').split('/')
    .filter((s) => s && s !== '.' && s !== '..').join('/');
}

/**
 * entries: [{ path: 'dir/sub/a.txt', file: File|Blob }]
 * onProgress(doneEntries, totalEntries)
 * 回傳 { blob, count }
 */
export async function buildZip(entries, onProgress = () => {}) {
  const te = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  let total = 0;
  for (const e of entries) total += e.file.size;
  if (entries.length >= 0xffff) throw new Error('檔案數量過多（上限 65534）');
  if (total >= 0xffffffff) throw new Error('資料夾總大小需小於 4 GB');

  let done = 0;
  for (const e of entries) {
    const name = te.encode(cleanPath(e.path));
    if (!name.length) continue;
    const size = e.file.size;
    const crc = await fileCrc(e.file);
    const { time, date } = dosDateTime(e.file.lastModified);

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // UTF-8 檔名
    lh.setUint16(8, 0, true);      // 存放（不壓縮）
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, size, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(lh.buffer, name, e.file);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, size, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(ch.buffer, name);

    offset += 30 + name.length + size;
    done++;
    onProgress(done, entries.length);
  }

  let cdSize = 0;
  for (const c of central) cdSize += c.byteLength;
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, done, true);
  eocd.setUint16(10, done, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  parts.push(...central, eocd.buffer);
  return { blob: new Blob(parts, { type: 'application/zip' }), count: done };
}
