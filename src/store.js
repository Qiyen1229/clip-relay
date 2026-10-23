'use strict';
// 記憶體中的項目索引。每筆欄位：
//   id / seq / kind('text'|'file'|'folder') / size / createdAt / expiresAt / burn
//   text 項目：text（純文字，留在記憶體）
//   file/folder 項目：file（磁碟檔名，= id）/ name / mime / fileCount（folder 為 zip 內檔案數）
// 沒有加密：文字以明文存於記憶體，檔案以原樣存於資料卷。
const crypto = require('node:crypto');

class Store {
  constructor({
    maxItems = 50, maxTotalBytes = 64 * 1024 * 1024, maxFileTotalBytes = 5 * 1024 ** 3,
    now = Date.now, onRemove = () => {},
  } = {}) {
    this.maxItems = maxItems;
    this.maxTotalBytes = maxTotalBytes;         // 文字總量
    this.maxFileTotalBytes = maxFileTotalBytes; // 檔案總量
    this.now = now;
    this.onRemove = onRemove;                   // 項目被移除時呼叫（用來刪磁碟檔）
    this.items = new Map();                     // 插入順序 = 伺服器接收順序
    this.totalBytes = 0;
    this.fileBytes = 0;
    this.seq = 0;
    this.rev = 0;                               // 任何變動都 +1，用於 ETag
  }

  /**
   * 新增。順序以「伺服器接收」為準：Node 為單執行緒事件迴圈，
   * 每次 add 原子地取得下一個 seq，多設備同時送出時不會有競態。
   */
  add({ id, kind = 'text', text = null, name = null, mime = null, file = null, fileCount = null,
    size, ttlSec, burn }) {
    const t = this.now();
    const item = {
      id: id || crypto.randomBytes(16).toString('base64url'),
      seq: ++this.seq,
      kind, text, name, mime, file, fileCount,
      size,
      createdAt: t,
      expiresAt: t + ttlSec * 1000,
      burn: !!burn,
    };
    this.items.set(item.id, item);
    this._account(item, +1);
    this.rev++;
    this._evict();
    return item;
  }

  _account(it, sign) {
    if (it.kind === 'text') this.totalBytes += sign * it.size;
    else this.fileBytes += sign * it.size;
  }

  _remove(id) {
    const it = this.items.get(id);
    if (!it) return false;
    this.items.delete(id);
    this._account(it, -1);
    this.rev++;
    try { this.onRemove(it); } catch { /* 刪檔失敗不影響索引 */ }
    return true;
  }

  _evict() {
    while (this.items.size > this.maxItems || this.totalBytes > this.maxTotalBytes
      || this.fileBytes > this.maxFileTotalBytes) {
      const oldest = this.items.keys().next().value;
      if (oldest === undefined) break;
      this._remove(oldest);
    }
  }

  _expired(it) {
    return it.expiresAt <= this.now();
  }

  /** 惰性刪除：每次讀取前先清掉已過期項目 */
  _purgeExpired() {
    let n = 0;
    for (const [id, it] of this.items) {
      if (this._expired(it) && this._remove(id)) n++;
    }
    return n;
  }

  /** 主動刪除：由定時任務呼叫 */
  sweep() {
    return this._purgeExpired();
  }

  /** 新到舊 */
  list() {
    this._purgeExpired();
    return [...this.items.values()].reverse();
  }

  /** 不改變狀態地查看（過期者會被清掉並回傳 null） */
  peek(id) {
    const it = this.items.get(id);
    if (!it) return null;
    if (this._expired(it)) { this._remove(id); return null; }
    return it;
  }

  /** 取單筆；阅後即焚者讀取後立即刪除（同步，原子） */
  get(id) {
    const it = this.peek(id);
    if (!it) return null;
    if (it.burn) this._remove(id);
    return it;
  }

  delete(id) {
    return this._remove(id);
  }

  clear() {
    const n = this.items.size;
    for (const id of [...this.items.keys()]) this._remove(id);
    return n;
  }

  snapshot() {
    return { seq: this.seq, items: [...this.items.values()] };
  }

  /** keep(item) 回傳 false 的項目會被略過（例如磁碟檔已不存在） */
  restore(data, keep = () => true) {
    if (!data || !Array.isArray(data.items)) return 0;
    for (const it of data.items) {
      if (!it || typeof it.id !== 'string' || typeof it.size !== 'number') continue;
      it.kind = it.kind || 'text';
      if (it.kind === 'text' && typeof it.text !== 'string') continue;
      if (it.expiresAt <= this.now() || !keep(it)) continue;
      this.items.set(it.id, it);
      this._account(it, +1);
    }
    this.seq = Math.max(this.seq, data.seq || 0);
    this._evict();
    this.rev++;
    return this.items.size;
  }
}

module.exports = { Store };
