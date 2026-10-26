// cache.mjs - short-lived in-memory response cache for billed or rate-limited routes a scan repeats.
//
// A route opts in with `cache: <seconds>` in apis.mjs (default off). callRoute (engine.mjs) keys an entry on
// the route id + the fully built upstream request (URL, headers, body: defaults filled, secrets hashed away),
// keeps only successful answers, and serves a hit without an upstream call, a pacing slot or a bill. Bounded
// by entries and by bytes (UTF-8 size of the stored JSON), least recently used out first. A call with
// opts.fresh skips it. Env: CACHE=off, CACHE_MAX_MB (64), CACHE_MAX_ENTRIES (5000),
// CACHE_ENTRY_MAX_KB (1024: bigger answers are not kept; a route may raise it with `cacheMaxKb`).
import { createHash } from "node:crypto";

export function makeCache({ maxEntries = 5000, maxBytes = 64 << 20, maxEntryBytes = 1 << 20, now = Date.now } = {}) {
  const map = new Map(); // key -> { s, at, exp, bytes }; Map order = least recently used first
  let bytes = 0;
  const st = { hits: 0, misses: 0, stored: 0, evicted: 0, tooBig: 0 };
  const drop = (k) => { const e = map.get(k); if (e) { bytes -= e.bytes; map.delete(k); } };
  return {
    // the stored value parsed fresh (callers may mutate it) + its age, or null
    get(key) {
      const e = map.get(key);
      if (!e) { st.misses++; return null; }
      if (now() >= e.exp) { drop(key); st.misses++; return null; }
      map.delete(key); map.set(key, e); // most recently used
      st.hits++;
      return { value: JSON.parse(e.s), ageS: Math.round((now() - e.at) / 1000) };
    },
    set(key, value, ttlS, { maxBytes: entryMax = maxEntryBytes } = {}) {
      const s = JSON.stringify(value);
      const b = Buffer.byteLength(s);
      if (b > entryMax) { st.tooBig++; return false; }
      drop(key);
      while (map.size && (map.size >= maxEntries || bytes + b > maxBytes)) { drop(map.keys().next().value); st.evicted++; }
      const t = now();
      map.set(key, { s, at: t, exp: t + ttlS * 1000, bytes: b });
      bytes += b; st.stored++;
      return true;
    },
    clear() { map.clear(); bytes = 0; },
    stats: () => ({ entries: map.size, bytes, maxEntries, maxBytes, maxEntryBytes, ...st }),
  };
}

// key for one built request: never holds a secret in clear (the URL / headers carry the upstream key)
export const cacheKey = (id, rq) => createHash("sha256").update(JSON.stringify([id, rq.method, rq.url, rq.headers, rq.body ?? null])).digest("base64url");

const env = (k, d) => (process.env[k] && Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
export const CACHE_ON = (process.env.CACHE || "").toLowerCase() !== "off";
export const CACHE = makeCache({ maxEntries: env("CACHE_MAX_ENTRIES", 5000), maxBytes: env("CACHE_MAX_MB", 64) * 1048576, maxEntryBytes: env("CACHE_ENTRY_MAX_KB", 1024) * 1024 });
