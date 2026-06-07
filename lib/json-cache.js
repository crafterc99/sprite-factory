'use strict';

/**
 * json-cache — stat-based read cache for hot JSON files.
 *
 * loadCharacters() and friends were re-reading + JSON.parsing whole files on
 * every API request (20+ call sites). This caches the parsed object in memory
 * and only re-reads when the file's mtime/size changes — so it stays correct
 * even when the file is written directly (e.g. startup restore) while
 * eliminating the parse cost on the hot path.
 */

const fs = require('fs');

const _cache = new Map(); // path -> { mtimeMs, size, value }

const _clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

/**
 * Read + parse a JSON file with mtime-validated caching.
 * Returns an independent clone so callers can mutate freely (drop-in for a
 * fresh JSON.parse) while skipping the disk read + string parse on cache hits.
 * @param {string} filePath
 * @param {*} fallback  value returned when the file is missing/unreadable
 */
function readJsonCached(filePath, fallback = {}) {
  let stat;
  try { stat = fs.statSync(filePath); }
  catch { return fallback; }

  const hit = _cache.get(filePath);
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
    return _clone(hit.value);
  }

  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    _cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
    return _clone(value);
  } catch {
    return fallback;
  }
}

/**
 * Write JSON to disk and prime the cache with the written value, so the next
 * read is a cache hit with no disk round-trip.
 */
function writeJsonCached(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  try {
    const stat = fs.statSync(filePath);
    // Store a snapshot so later external mutation of `value` can't corrupt the cache.
    _cache.set(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, value: _clone(value) });
  } catch {}
}

/** Drop a cache entry (or the whole cache) — used after external writes. */
function invalidate(filePath) {
  if (filePath) _cache.delete(filePath);
  else _cache.clear();
}

module.exports = { readJsonCached, writeJsonCached, invalidate };
