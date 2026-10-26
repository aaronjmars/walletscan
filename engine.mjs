// engine.mjs - route calling and index warm-up for the CLI (cli.mjs): callRoute runs one route (local dataset,
// compose, or upstream fetch with per-host pacing, retries, time limits, spare keys and the response cache).
// Importing it starts nothing; env is read at import time (CALL_TIMEOUT, RETRY_WAIT_MS, RETRY_MAX, PROXY_URL), so set
// keys before importing it.
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTRY, buildRequest, routeLive, keysFor, keySlot, markKeyEmpty, keylessOf } from "./registry.mjs";
import { alchemyOff, markAlchemyOff, notEnabled } from "./keyless.mjs";
import { COMPOSE } from "./compose.mjs";
import { CACHE, CACHE_ON, cacheKey } from "./cache.mjs";

export const REG_BY_ID = new Map(REGISTRY.map((e) => [e.id, e]));
const CALL_TIMEOUT = (Number(process.env.CALL_TIMEOUT) || 20) * 1000;
const RETRY_WAIT = Number(process.env.RETRY_WAIT_MS) || 1500;
const RETRY_MAX = Number(process.env.RETRY_MAX ?? 2);
// proxy:true routes: a fresh tunnel per request (no keep-alive), so a rotating proxy gives a new exit IP on each try;
// some exits sit in a region the upstream blocks (403), so try up to PROXY_TRIES of them
const PROXY_AGENT = process.env.PROXY_URL ? new HttpsAgent({ proxyEnv: { HTTPS_PROXY: process.env.PROXY_URL } }) : null;
const PROXY_TRIES = 3;

// an HTTP 200 that still carries an error: a JSON-RPC error with no result, or GraphQL errors with no data
function softError(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  if (d.jsonrpc && d.error && d.result == null) return true;
  return Array.isArray(d.errors) && d.errors.length > 0 && !d.data;
}
function rateLimitBody(d) {
  if (!d || typeof d !== "object" || Array.isArray(d)) return false;
  const e = d.error;
  return !!e && typeof e === "object" && ([429, -32429].includes(e.code) || /rate limit|too many requests/i.test(String(e.message || "")));
}

// ---- per-host pacing: free tiers that 429 on bursts get calls spaced out instead ------------------------------
const HOST_RPS = {
  "helius-rpc": 8, // Helius free plan: 10 RPC req/s (routes with pace: "helius-rpc")
  "helius-das": 2, // Helius free plan: DAS 2 req/s
  // public Solana RPC (the Helius routes with no HELIUS_API_KEY, registry.mjs keyless): per method and IP, 10 per 10 s
  // for getProgramAccounts and getTokenAccountsByOwner, 50 for getMultipleAccounts, ~100 in all (headers, 2026-10-22)
  "solana-gpa": 0.9,
  "solana-owner": 0.9,
  "solana-rpc": 4,
  "data-api.polymarket.com": 2,
  "api.merkl.xyz": 8, // 10 req/s default
  "api.gopluslabs.io": 1,
  "api.jup.ag": 0.5, // documented keyless quota, shared by every Jupiter reader
  "api.dexscreener.com": 4, // token API: 300 requests/minute
  "api.geckoterminal.com": 0.4, // leave headroom in the public quota
  "api.rugcheck.xyz": 1,
  "api.routescan.io": 2,
  "robinhood-rpc.publicnode.com": 3,
  "ponsfamily.com": 2,
  "api.wormholescan.io": 2,
  "scan.layerzero-api.com": 3,
  "li.quest": 2,
  "app.across.to": 2,
  "rpc.karak.network": 2, // K2 (shut down) answers 403 for minutes after a burst (2026-10-21)
  "api.zerion.io": 3, // Zerion Developer plan: 3 req/s and 2K req/day per org; DeFi (only_complex) positions get a quarter (headers, 2026-10-20)
  // non-EVM chains (nonevm/): keyless public hosts, kept gentle
  "tonapi.io": 1, // keyless tier: about 1 call a second
  "api.trongrid.io": 8, // keyless TronGrid is rate limited
  "api.omniexplorer.info": 2,
  "mempool.space": 5,
  "staking-api.babylonlabs.io": 4,
};
const nextSlot = new Map();
export const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function pace(host) {
  const now = Date.now(), rps = HOST_RPS[host];
  if (!rps) { const at = nextSlot.get(host) || 0; if (at > now) await sleep(at - now); return; }
  const at = Math.max(now, nextSlot.get(host) || 0);
  nextSlot.set(host, at + 1000 / rps);
  if (at > now) await sleep(at - now);
}
const holdHost = (host, ms) => nextSlot.set(host, Math.max(nextSlot.get(host) || 0, Date.now() + ms));

// a key whose credits are gone (Helius free plan: plain-text 429 "max usage reached"): marked until 00:00 UTC and
// the call moves to the next spare key (NAME_2 ...)
const nextUtcMidnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
const USED_UP = /quota|credit|max usage|usage limit|insufficient|exceeded|invalid.{0,20}key|api key/i;
const RATE = /per second|per minute|rate limit|too many requests|rps/i;
function keyUsedUp(entry, r, d) {
  if (!entry.auth || r.ok) return false;
  const t = typeof d === "string" ? d : JSON.stringify(d ?? "");
  return r.status === 402 || ([401, 403, 429].includes(r.status) && USED_UP.test(t) && !RATE.test(t));
}

// ---- local datasets (data/*.json, answered in-process) ---------------------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);
const LOCAL = {
  deadlines: { file: "data/deadlines.json", query: (rows, p) => (p.open === "0" ? rows : rows.filter((r) => !r.closes || r.closes >= today())) },
};
const LOCAL_DATA = {};
function localLookup(name, params) {
  const d = LOCAL[name];
  LOCAL_DATA[name] ||= JSON.parse(readFileSync(new URL(d.file, import.meta.url), "utf8"));
  return d.query(LOCAL_DATA[name], { open: "1", ...params });
}
function localRoute(entry, params) {
  return { status: 200, ok: true, data: localLookup(entry.local, params) };
}

// ---- dispatch ----------------------------------------------------------------------------------------------
async function composeRoute(entry, params, opts) {
  const ctx = {
    call: (id, p, over) => {
      const e = REG_BY_ID.get(id);
      if (!e) throw { status: 500, error: `unknown step ${id}` };
      return callRoute(e, { ...p }, { fresh: opts.fresh, ...over });
    },
    live: (id) => REG_BY_ID.has(id) && routeLive(REG_BY_ID.get(id)),
    local: localLookup,
    body: opts.body, // the JSON-RPC body a keyless stand-in answers (evm.keyless_rpc)
  };
  try {
    return { status: 200, ok: true, data: await COMPOSE[entry.compose](params, ctx) };
  } catch (e) {
    if (e && e.status === 400) throw e;
    return { status: (e && e.status) || 500, ok: false, data: { error: (e && (e.error || e.message)) || String(e), ...(e && e.detail !== undefined && { detail: e.detail }) } };
  }
}

const pending = new Map(); // cache key -> the in-flight call
// one route: { status, ok, data, cached? }; a caller error (bad or missing param) is thrown as { status: 400, error,
// detail }. opts.fresh skips the response cache
export async function callRoute(entry, params, opts = {}) {
  if (entry.local) return localRoute(entry, params);
  if (entry.compose) return composeRoute(entry, params, opts);
  // no key set: a route with a keyless stand-in route runs through it, with the body it would have sent
  const kl = keylessOf(entry);
  if (kl?.route) return callRoute(REG_BY_ID.get(kl.route), { ...params, ...kl.params }, { ...opts, body: opts.body ?? buildRequest(entry, params).body });
  // key set, but the Alchemy app has this network off (403 "... is not enabled for this app"): the keyless stand-in
  if (entry.keyless?.route === "evm.keyless_rpc" && !opts.keyedOnly) {
    const net = params.network || entry.keyless.params?.network || "eth-mainnet";
    const stand = () => callRoute(REG_BY_ID.get(entry.keyless.route), { ...params, ...entry.keyless.params }, { ...opts, body: opts.body ?? buildRequest(entry, params).body });
    if (alchemyOff(net)) return stand();
    const out = await callRoute(entry, params, { ...opts, keyedOnly: true });
    if (out.status === 403 && notEnabled(JSON.stringify(out.data))) { markAlchemyOff(net); return stand(); }
    return out;
  }
  const rq = buildRequest(entry, params, opts);
  if (!(CACHE_ON && entry.cache > 0 && !opts.fresh)) return fetchRoute(entry, rq);
  const key = cacheKey(entry.id, rq);
  if (pending.has(key)) await pending.get(key).catch(() => {});
  const hit = CACHE.get(key);
  if (hit) {
    return { ...hit.value, ok: true, cached: { ageS: hit.ageS, ttlS: entry.cache } };
  }
  const call = fetchRoute(entry, rq);
  pending.set(key, call);
  try {
    const out = await call;
    if (out.ok && out.status >= 200 && out.status < 300) CACHE.set(key, { status: out.status, data: out.data }, entry.cache, entry.cacheMaxKb ? { maxBytes: entry.cacheMaxKb * 1024 } : {});
    return out;
  } finally {
    pending.delete(key);
  }
}

// fetch() look-alike over PROXY_AGENT (fetch has no per-request proxy without undici): resolves a Response
function proxyFetch(url, { method, headers, body, signal }) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method, headers, agent: PROXY_AGENT, signal }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const empty = [101, 204, 205, 304].includes(res.statusCode);
        const hdrs = Object.entries(res.headers).flatMap(([k, v]) => [v].flat().map((x) => [k, x]));
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status: res.statusCode, headers: hdrs }));
      });
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

async function fetchRoute(entry, rq) {
  if (rq.key && keySlot(rq.key.name) === -1) return { status: 429, ok: false, data: { error: `${rq.key.name}: every key is used up until 00:00 UTC (no upstream call)`, pool_empty: true } };
  const host = new URL(rq.url).host;
  const bucket = rq.pace || entry.pace || host;
  const gate = () => pace(bucket);
  await gate();
  const ac = new AbortController();
  const limit = rq.timeout ? rq.timeout * 1000 : CALL_TIMEOUT;
  const to = setTimeout(() => ac.abort(), limit);
  const t0 = Date.now();
  let data;
  try {
    // a form route's body is already a string (registry.mjs `form`); every other body goes as JSON
    const opts = { method: rq.method, headers: rq.headers, body: rq.body ? (typeof rq.body === "string" ? rq.body : JSON.stringify(rq.body)) : undefined, signal: ac.signal };
    const parse = (text) => {
      if (rq.type === "text") return text;
      try { return JSON.parse(text); } catch { return { _raw: text.slice(0, 4000), _note: "upstream returned non-JSON" }; }
    };
    const go = async () => {
      if (!(entry.proxy && PROXY_AGENT)) return fetch(rq.url, opts);
      let r;
      for (let i = 0; i < PROXY_TRIES; i++) {
        r = await proxyFetch(rq.url, opts);
        if (r.status !== 403) break;
      }
      return r;
    };
    let r = await go();
    data = parse(await r.text());
    const rateLimited = () => r.status === 429 || (r.ok && rateLimitBody(data));
    // 429 / 503 on every route; a route's retryOn adds its own (Parcl's fly.dev claim APIs answer 502 / 504 while they cold-start)
    // retrySoft: a 200 carrying a JSON-RPC error is retried too (Helius DAS answers a database timeout that way on big wallets)
    const busy = () => rateLimited() || r.status === 503 || !!entry.retryOn?.includes(r.status) || (!!entry.retrySoft && r.ok && softError(data));
    for (let i = 0; i < (entry.retry ?? RETRY_MAX) && busy() && !keyUsedUp(entry, r, data); i++) {
      const ra = Number(r.headers.get("retry-after"));
      const wait = Math.min(ra > 0 ? ra * 1000 : RETRY_WAIT * 2 ** i, 5000);
      if (Date.now() - t0 + wait >= limit - 2000) break;
      if (rateLimited()) holdHost(bucket, wait);
      await sleep(wait);
      await gate();
      r = await go();
      data = parse(await r.text());
    }
    // a used-up key: marked until 00:00 UTC; the call goes once more on each spare key not used up yet
    for (let tries = 0; rq.key && keyUsedUp(entry, r, data) && tries < 8; tries++) {
      markKeyEmpty(rq.key.name, rq.key.slot, nextUtcMidnight());
      const next = keySlot(rq.key.name);
      if (next < 0 || next === rq.key.slot) break;
      const [from, toKey] = [keysFor(rq.key.name)[rq.key.slot], keysFor(rq.key.name)[next]];
      const swap = (v) => (v == null ? v : JSON.parse(JSON.stringify(v).split(from).join(toKey)));
      rq = { ...rq, url: rq.url.split(from).join(toKey), headers: swap(rq.headers), body: swap(rq.body), key: { ...rq.key, slot: next } };
      Object.assign(opts, { headers: rq.headers, body: rq.body ? JSON.stringify(rq.body) : undefined });
      r = await go();
      data = parse(await r.text());
    }
    return { status: r.status, ok: r.ok && !softError(data), data };
  } catch (e) {
    return { status: 502, ok: false, data: { error: e.name === "AbortError" ? `upstream timed out after ${limit / 1000}s` : e.message } };
  } finally {
    clearTimeout(to);
  }
}

// ---- on-disk indexes ---------------------------------------------------------------------------------------------
// A CLI run cannot wait for a background rebuild, so it builds an index a scan needs before the scan when it is
// missing or over a day old (what each module would otherwise rebuild in the background). route = the scan source
// that reads the index: no live route, no warm-up.
const DAY = 86_400_000;
const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };
const hasFiles = (dir) => { try { return readdirSync(dir).some((n) => n.endsWith(".json")); } catch { return false; } };
export const INDEXES = {
  stuck: {
    route: "bridge.stuck", about: "bridge withdrawal indexes (Starknet, Ronin, Sui, Lisk, Manta)", cold: "15 s to 2.5 min",
    dir: () => process.env.STUCK_CACHE_DIR || fileURLToPath(new URL("./stuck/.cache/", import.meta.url)),
    // bridges sync the new blocks themselves on each check: only a missing index needs a build first
    stale: (dir) => !hasFiles(dir),
    warm: async () => { const w = await (await import("./stuck/index.mjs")).warm(); return { errors: w.errors.map((e) => `${e.bridge}: ${e.error}`) }; },
  },
  airdrops: {
    route: "airdrop.index", about: "airdrop eligibility lists", cold: "1 to 3 min",
    dir: async () => (await import("./airdrops/index.mjs")).cacheDir(),
    // each scan checks the list hashes itself (one small request): only a missing index needs a build first
    stale: (dir) => !existsSync(join(dir, "manifest.json")),
    warm: async () => { const w = await (await import("./airdrops/index.mjs")).warm(); return { errors: w.errors.map((e) => `${e.list}: ${e.error}`) }; },
  },
  forgotteneth: {
    route: "rewards.old_contracts", about: "Forgotten ETH index (~140 MB)", cold: "about 10 s",
    dir: async () => (await import("./oldeth/index.mjs")).cacheDir(),
    stale: (dir) => !(Date.now() - (readJson(join(dir, "manifest.json"))?.checked || 0) < DAY),
    warm: async () => { const w = await (await import("./oldeth/index.mjs")).warm(); return { errors: w.errors }; },
  },
  chains: {
    route: "holdings.chains", about: "probed public EVM RPC list", cold: "about 40 s",
    dir: () => process.env.CHAINS_CACHE_DIR || (process.env.STUCK_CACHE_DIR ? join(dirname(process.env.STUCK_CACHE_DIR), "chains") : fileURLToPath(new URL("./chains/.cache/", import.meta.url))),
    stale: (dir) => !(Date.now() - (readJson(join(dir, "live.json"))?.at || 0) < DAY),
    warm: async () => { const m = await import("./chains/index.mjs"); const s = await m.warm({ force: true }); return { errors: s.error ? [s.error] : [] }; },
  },
};
// which indexes a scan of these address kinds reads, and whether each is usable with the keys set now
export function indexesFor(kinds) {
  const evm = kinds.includes("evm");
  return Object.entries(INDEXES).filter(() => evm).map(([name, ix]) => ({ name, ...ix, live: REG_BY_ID.has(ix.route) && routeLive(REG_BY_ID.get(ix.route)) }));
}
