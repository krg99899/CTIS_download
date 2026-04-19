// ──────────────────────────────────────────────────────────────────────
// Persistent extraction cache.
//   key   = sha256(pdfBuffer)     content-addressed, so identical bytes → same key
//   value = { usdm, validation, toc, warnings, createdAt, hits }
//
// Storage: filesystem (CACHE_DIR env, default .cache/usdm). Railway provides
// ephemeral disk that's fine for this — duplicate uploads within the same
// container lifetime hit the cache. For persistence across deploys, mount
// a Railway volume and set CACHE_DIR to it.
// ──────────────────────────────────────────────────────────────────────

const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const CACHE_DIR = process.env.CACHE_DIR || path.join(__dirname, '..', '.cache', 'usdm');
const MAX_ENTRIES = parseInt(process.env.USDM_CACHE_MAX_ENTRIES || '500', 10);
const TTL_MS = parseInt(process.env.USDM_CACHE_TTL_MS || (30 * 24 * 60 * 60 * 1000), 10); // 30d default

async function ensureDir() {
  try { await fs.mkdir(CACHE_DIR, { recursive: true }); } catch {}
}

function hashBuffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function filePath(hash) {
  return path.join(CACHE_DIR, `${hash}.json`);
}

async function get(hash) {
  try {
    const raw = await fs.readFile(filePath(hash), 'utf8');
    const entry = JSON.parse(raw);
    if (TTL_MS > 0 && entry.createdAt && Date.now() - entry.createdAt > TTL_MS) {
      await remove(hash);
      return null;
    }
    entry.hits = (entry.hits || 0) + 1;
    fs.writeFile(filePath(hash), JSON.stringify(entry), 'utf8').catch(() => {});
    return entry;
  } catch { return null; }
}

async function put(hash, value) {
  await ensureDir();
  const entry = { ...value, createdAt: Date.now(), hits: 0 };
  try {
    await fs.writeFile(filePath(hash), JSON.stringify(entry), 'utf8');
  } catch (err) {
    console.warn('[usdm-cache] write failed:', err.message);
  }
  evictIfNeeded().catch(() => {});
  return entry;
}

async function remove(hash) {
  try { await fs.unlink(filePath(hash)); } catch {}
}

async function evictIfNeeded() {
  try {
    const files = await fs.readdir(CACHE_DIR);
    if (files.length <= MAX_ENTRIES) return;
    const stats = await Promise.all(files.map(async f => {
      try { const s = await fs.stat(path.join(CACHE_DIR, f)); return { f, mtimeMs: s.mtimeMs }; }
      catch { return null; }
    }));
    const valid = stats.filter(Boolean).sort((a, b) => a.mtimeMs - b.mtimeMs);
    const excess = valid.length - MAX_ENTRIES;
    for (let i = 0; i < excess; i++) {
      await fs.unlink(path.join(CACHE_DIR, valid[i].f)).catch(() => {});
    }
  } catch {}
}

async function status() {
  try {
    await ensureDir();
    const files = await fs.readdir(CACHE_DIR);
    const sizes = await Promise.all(files.map(async f => {
      try { const s = await fs.stat(path.join(CACHE_DIR, f)); return s.size; }
      catch { return 0; }
    }));
    return {
      dir: CACHE_DIR,
      entries: files.length,
      totalBytes: sizes.reduce((a, b) => a + b, 0),
      maxEntries: MAX_ENTRIES,
      ttlMs: TTL_MS
    };
  } catch (err) {
    return { dir: CACHE_DIR, entries: 0, totalBytes: 0, error: err.message };
  }
}

module.exports = { hashBuffer, get, put, remove, status };
