'use strict';
// 設定載入：全部來自環境變數，皆有安全的預設值。
const path = require('node:path');

function intEnv(env, name, def, min, max) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`環境變數 ${name} 必須是 ${min}~${max} 之間的整數，目前為 "${raw}"`);
  }
  return n;
}

function boolEnv(env, name, def) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function loadConfig(env = process.env) {
  const maxItemBytes = intEnv(env, 'MAX_ITEM_BYTES', 1024 * 1024, 1024, 16 * 1024 * 1024);
  const maxTotalBytes = intEnv(env, 'MAX_TOTAL_BYTES', 64 * 1024 * 1024, 1024, 1024 * 1024 * 1024);
  if (maxTotalBytes < maxItemBytes) throw new Error('MAX_TOTAL_BYTES 不可小於 MAX_ITEM_BYTES');
  const maxFileBytes = intEnv(env, 'MAX_FILE_BYTES', 1024 ** 3, 1024, 4 * 1024 ** 3 - 1);
  const maxFileTotalBytes = intEnv(env, 'MAX_FILE_TOTAL_BYTES', 5 * 1024 ** 3, 1024, 1024 ** 4);
  if (maxFileTotalBytes < maxFileBytes) throw new Error('MAX_FILE_TOTAL_BYTES 不可小於 MAX_FILE_BYTES');
  return {
    maxFileBytes,
    maxFileTotalBytes,
    chunkBytes: intEnv(env, 'CHUNK_BYTES', 4 * 1024 * 1024, 64 * 1024, 32 * 1024 * 1024),
    minFreeDiskBytes: intEnv(env, 'MIN_FREE_DISK_BYTES', 256 * 1024 * 1024, 0, 1024 ** 4),
    port: intEnv(env, 'PORT', 9144, 0, 65535),
    host: env.HOST || '0.0.0.0',
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    maxItems: intEnv(env, 'MAX_ITEMS', 50, 1, 1000),
    maxItemBytes,
    maxTotalBytes,
    defaultTtl: intEnv(env, 'DEFAULT_TTL', 600, 10, 7 * 86400),
    minTtl: 10,
    maxTtl: intEnv(env, 'MAX_TTL', 86400, 10, 7 * 86400),
    sweepIntervalMs: intEnv(env, 'SWEEP_INTERVAL_MS', 30000, 100, 3600000),
    postRatePerMin: intEnv(env, 'POST_RATE_PER_MIN', 30, 1, 100000),
    readRatePerMin: intEnv(env, 'READ_RATE_PER_MIN', 600, 1, 1000000),
    inlineTextBytes: intEnv(env, 'INLINE_TEXT_BYTES', 16384, 0, 1024 * 1024),
    trustProxy: boolEnv(env, 'TRUST_PROXY', false),
    persist: boolEnv(env, 'PERSIST', false),
  };
}

module.exports = { loadConfig };
