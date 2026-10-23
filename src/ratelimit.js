'use strict';
// 固定視窗計數器（以 key 計，例如客戶端 IP）。記憶體內、無依賴。

class RateLimiter {
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
    this.buckets = new Map(); // key -> { start, count }
  }

  _bucket(key) {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b || t - b.start >= this.windowMs) {
      b = { start: t, count: 0 };
      this.buckets.set(key, b);
    }
    return b;
  }

  /** 計一次；回傳 { ok, retryAfterSec } */
  hit(key) {
    const b = this._bucket(key);
    b.count += 1;
    const ok = b.count <= this.limit;
    const retryAfterSec = Math.max(1, Math.ceil((b.start + this.windowMs - this.now()) / 1000));
    return { ok, retryAfterSec };
  }

  /** 只查詢目前是否已超限（不計數） */
  blocked(key) {
    const b = this.buckets.get(key);
    if (!b || this.now() - b.start >= this.windowMs) return { blocked: false, retryAfterSec: 0 };
    return {
      blocked: b.count >= this.limit,
      retryAfterSec: Math.max(1, Math.ceil((b.start + this.windowMs - this.now()) / 1000)),
    };
  }

  /** 清掉過期桶，避免 Map 無限成長 */
  prune() {
    const t = this.now();
    for (const [k, b] of this.buckets) if (t - b.start >= this.windowMs) this.buckets.delete(k);
  }
}

module.exports = { RateLimiter };
