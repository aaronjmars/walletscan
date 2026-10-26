// chains/index.mjs - balances on every EVM chain with a public RPC, for the chains a portfolio API misses (new, small,
// halted or shut down ones). Chain list = chainlist.org (ethereum-lists + its extra RPCs) merged with DefiLlama's chain
// metadata (gecko id of the native coin, coins.llama.fi chain key). Importing it runs nothing; env is read at call time.
//
//   import { warm, checkWallet, state } from "./chains/index.mjs";
//   await warm();                                    // probe every RPC, keep the best 2 per chain (disk cache, 1 day)
//   const out = await checkWallet("0x...", { chains: [34443, 2818] });   // chains optional: default every live chain
//
// Env: CHAINS_CACHE_DIR (probe results; default chains/.cache/), ETHERSCAN_API_KEY (optional token source),
// ALCHEMY_API_KEY (optional: tokens on its 34 EVM networks, chains/alchemy.mjs, and past deposits to a shut-down
// chain when no balance can be read there).
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Resolver } from "node:dns/promises";
import { lookup as dnsLookup } from "node:dns";
import { isIP } from "node:net";
import http from "node:http";
import https from "node:https";
import { alchemyTokens, ALCHEMY_IDS } from "./alchemy.mjs";
import { noteKey } from "../keyless.mjs";

const DIR = dirname(fileURLToPath(import.meta.url));
// CHAINS_CACHE_DIR, else next to the stuck indexes (STUCK_CACHE_DIR=/x/stuck -> /x/chains), else .cache/
const cacheFile = () => join(process.env.CHAINS_CACHE_DIR || (process.env.STUCK_CACHE_DIR ? join(dirname(process.env.STUCK_CACHE_DIR), "chains") : join(DIR, ".cache")), "live.json");
const SUNSET = JSON.parse(readFileSync(join(DIR, "../data/sunset-chains.json"), "utf8"));
const ZSLUG = new Map(Object.entries(JSON.parse(readFileSync(join(DIR, "zerion-chains.json"), "utf8"))).filter(([k]) => k !== "_").map(([k, v]) => [v, k]));
const LLAMA = JSON.parse(readFileSync(join(DIR, "llama-chains.json"), "utf8")); // static: the live config is 8 MB
// token API per chain outside the two all-chain indexes (chainlist explorers probed, real API hosts): see the file's "_"
const EXPLORERS = JSON.parse(readFileSync(join(DIR, "explorers.json"), "utf8"));
// natives DefiLlama has no gecko id for, by chain id
const NATIVE_GECKO = { 984122: "celestia" }; // Forma pays gas in TIA
// chains api.llama.fi/config lists without their chain id, though coins.llama.fi prices them: [chain key, native gecko id]
const LLAMA_FIX = { 999: ["hyperliquid", "hyperliquid"], 1329: ["sei", "sei-network"], 50: ["xdc", "xdce-crowd-sale"] };
const LIST_V = 2; // bump when the chain rows change shape: an older disk cache is used while a new one builds
const DAY = 86400000;
const HALTED_S = 30 * 86400; // no block for 30 days: the chain may be halted (some chains only make blocks on demand)
const TESTNET = /test|devnet|sepolia|goerli|holesky|hoodi|fuji|amoy|chiado|mumbai|ropsten|rinkeby|kovan|staging|localhost/i;
const SOURCES = {
  chainlist: "https://chainlist.org/rpcs.json", chainid: "https://chainid.network/chains.json",
  blockscout: "https://chains.blockscout.com/api/chains", cluster: "https://multichain-aggregator.services.blockscout.com/api/v1/clusters/multichain",
};
const ALCHEMY_NET = { ethereum: "eth-mainnet", base: "base-mainnet", arbitrum: "arb-mainnet", optimism: "opt-mainnet", polygon: "polygon-mainnet", bsc: "bnb-mainnet" };
const NATIVE = "native";

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const rpc = (id, method, params = []) => ({ jsonrpc: "2.0", id, method, params });
const hexNum = (h) => (typeof h === "string" && /^0x[0-9a-f]*$/i.test(h) ? BigInt(h === "0x" ? 0 : h) : null);
const units = (raw, d) => Number(raw) / 10 ** Number(d ?? 18);
async function getJson(url, ms, init) {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`http ${r.status} from ${new URL(url).host}`);
  return r.json();
}

// RPC calls go through node:http(s) with addresses from c-ares (dns/promises): fetch resolves with getaddrinfo on
// libuv's 4 threads, so a few thousand hosts (or a few hundred dead ones) queue there and probes time out falsely
const IPS = new Map(), DNS_TTL = 600000, resolver = new Resolver({ timeout: 2500, tries: 1 });
async function resolveHosts(hosts) {
  const todo = [...new Set(hosts)].filter((h) => !isIP(h) && !(IPS.get(h)?.at > Date.now() - DNS_TTL));
  const run = limiter(128, 128);
  await Promise.all(todo.map((h) => run(`http://${h}`, async () => {
    const a4 = await resolver.resolve4(h).catch(() => []);
    const a6 = a4.length ? [] : await resolver.resolve6(h).catch(() => []);
    const v4 = a4.find((a) => !PRIVATE.test(a)), v6 = a6.find((a) => !PRIVATE.test(a));
    IPS.set(h, v4 ? { address: v4, family: 4, at: Date.now() } : v6 ? { address: v6, family: 6, at: Date.now() } : { address: null, at: Date.now() });
  })));
}
// chain lists carry RPCs on private or local addresses; never connect there (an fd.. address once crashed a run)
const PRIVATE = /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|::$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i;
const resolves = (h) => !!((isIP(h) && !PRIVATE.test(h)) || IPS.get(h)?.address);
// the answer must come back on a later tick: a synchronous one lets a connect error fire on the socket before
// http.request has hooked its error handler, an uncaught 'error' that killed the process
function lookup(host, opts, cb) {
  const ip = IPS.get(host);
  if (!ip?.address) return dnsLookup(host, opts, cb);
  process.nextTick(() => (opts?.all ? cb(null, [{ address: ip.address, family: ip.family }]) : cb(null, ip.address, ip.family)));
}
// no keep-alive: one scan touches ~700 hosts, and idle TLS sockets to all of them held ~100 MB of RSS
const AGENTS = { "https:": new https.Agent({ keepAlive: false }), "http:": new http.Agent({ keepAlive: false }) };
function post(url, body, ms) {
  return new Promise((ok, no) => {
    const u = new URL(url), data = JSON.stringify(body);
    const req = (u.protocol === "https:" ? https : http).request(u, { method: "POST", agent: AGENTS[u.protocol], lookup, signal: AbortSignal.timeout(ms), headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data), "user-agent": "walletscan" } }, (res) => {
      let s = "";
      res.setEncoding("utf8");
      res.on("data", (d) => { s += d; if (s.length > 4e6) req.destroy(new Error("answer too big")); });
      res.on("end", () => {
        if (res.statusCode >= 400) return no(Object.assign(new Error(`http ${res.statusCode}`), { http: res.statusCode }));
        try { ok(JSON.parse(s)); } catch { no(Object.assign(new Error("not json"), { http: res.statusCode })); }
      });
      res.on("error", no);
    });
    req.on("error", no);
    req.end(data);
  });
}

// bounded concurrency, overall and per host (one RPC provider serves hundreds of chains)
function limiter(total, perHost) {
  let n = 0;
  const hosts = new Map(), wait = [];
  const free = (h) => n < total && (hosts.get(h) || 0) < perHost;
  const take = (h) => { n++; hosts.set(h, (hosts.get(h) || 0) + 1); };
  const next = () => { for (let i = 0; i < wait.length && n < total; i++) if (free(wait[i].h)) { const w = wait.splice(i--, 1)[0]; take(w.h); w.go(); } };
  return async (url, fn) => {
    const h = new URL(url).host;
    if (free(h)) take(h); else await new Promise((go) => wait.push({ h, go }));
    try { return await fn(); } finally { n--; hosts.set(h, hosts.get(h) - 1); next(); }
  };
}

// ---- the chain list ------------------------------------------------------------------------------------------
// every mainnet with an http RPC, keyed by chain id, with what pricing and token lookups need
async function sourceList() {
  const [cl, bs, cluster] = await Promise.all([
    getJson(SOURCES.chainlist, 30000).catch(() => getJson(SOURCES.chainid, 30000)),
    getJson(SOURCES.blockscout, 20000).catch(() => ({})),
    getJson(`${SOURCES.cluster}/chains`, 20000).catch(() => ({ items: [] })),
  ]);
  const scout = new Map(Object.entries(bs || {}).filter(([, c]) => !c.isTestnet && c.explorers?.[0]?.url).map(([id, c]) => [Number(id), c.explorers[0].url.replace(/\/+$/, "")]));
  const out = [];
  for (const c of cl) {
    // isTestnet is chainlist.org's flag (not slip44: Morph mainnet has slip44 1); chainid.network only has faucets
    if (c.isTestnet || (c.isTestnet == null && c.faucets?.length) || TESTNET.test(c.name) || !Number.isSafeInteger(c.chainId)) continue;
    const rpcs = [...new Set((c.rpc || []).map((r) => (typeof r === "string" ? r : r?.url)).filter((u) => /^https?:\/\//.test(u || "") && !/\$\{|API_KEY|YOUR|<|>/i.test(u)))].slice(0, 8);
    if (!rpcs.length) continue;
    const sym = c.nativeCurrency?.symbol || "?";
    // DefiLlama by chain id, else by name when the native symbol matches (it lists some chains without an id)
    const named = Object.entries(LLAMA.names).find(([n, v]) => v[2] === sym && (c.name === n || c.name.startsWith(`${n} `)))?.[1];
    const [key, gas] = LLAMA.ids[c.chainId] || LLAMA_FIX[c.chainId] || named || [];
    out.push({
      id: c.chainId, name: c.name, slug: ZSLUG.get(c.chainId) || c.chainSlug || key || String(c.shortName || c.chainId).toLowerCase(),
      native: { symbol: sym, decimals: c.nativeCurrency?.decimals ?? 18 }, gecko: gas || NATIVE_GECKO[c.chainId] || (sym === "ETH" && (key || c.parent) ? "ethereum" : null),
      llama: key || null, parent: c.parent?.chain || null, rpcs,
      // the probed API host first: chains.blockscout.com links the website, which answers 404 on some (Linea, Morph)
      blockscout: EXPLORERS[c.chainId]?.kind === "blockscout" ? EXPLORERS[c.chainId].api.replace(/\/api\/v2$/, "") : scout.get(c.chainId) || null,
      etherscan: EXPLORERS[c.chainId]?.kind === "etherscan" ? EXPLORERS[c.chainId].api : null,
    });
  }
  return { chains: out, cluster: (cluster.items || []).map((c) => Number(c.id)) };
}

// one RPC: eth_chainId must match; a batch with the latest block tells batch support and how old the head is
async function probeRpc(url, id) {
  const t0 = Date.now();
  let dead = false;
  const r = await post(url, [rpc(1, "eth_chainId"), rpc(2, "eth_getBlockByNumber", ["latest", false])], 5000).catch((e) => { dead = !e.http; return null; });
  if (dead) return null; // no HTTP answer at all (timeout, refused, TLS): not worth a second try without batch
  if (Array.isArray(r) && r.find((x) => x?.id === 1)?.result) {
    if (Number(hexNum(r.find((x) => x.id === 1).result)) !== id) return null;
    const ts = Number(hexNum(r.find((x) => x?.id === 2)?.result?.timestamp) ?? 0n) || null;
    return { url, ms: Date.now() - t0, batch: true, head: ts };
  }
  const one = await post(url, rpc(1, "eth_chainId"), 4000);
  if (Number(hexNum(one?.result)) !== id) return null;
  const b = await post(url, rpc(2, "eth_getBlockByNumber", ["latest", false]), 4000).catch(() => null);
  return { url, ms: Date.now() - t0, batch: false, head: Number(hexNum(b?.result?.timestamp) ?? 0n) || null };
}

async function build() {
  const t0 = Date.now();
  const { chains, cluster } = await sourceList();
  const hosts = [...new Set(chains.flatMap((c) => c.rpcs.map((u) => new URL(u).hostname)))];
  await resolveHosts(hosts); // a host with no DNS record is dropped before any probe
  for (const c of chains) c.rpcs = c.rpcs.filter((u) => resolves(new URL(u).hostname));
  const run = limiter(64, 12);
  // gateways listed for hundreds of chains (thirdweb, routeme) are only tried where the chain's own RPCs all failed
  const hostKey = (u) => new URL(u).host.replace(/^\d+\./, ""), seen = new Map();
  for (const c of chains) for (const u of c.rpcs) seen.set(hostKey(u), (seen.get(hostKey(u)) || 0) + 1);
  const shared = (u) => seen.get(hostKey(u)) > 50;
  let probed = 0;
  const probeAll = async (c, urls) => (await Promise.all(urls.map((u) => run(u, () => probeRpc(u, c.id).catch(() => null)).finally(() => probed++)))).filter(Boolean);
  const live = (await Promise.all(chains.map(async (c) => {
    let good = await probeAll(c, c.rpcs.filter((u) => !shared(u)));
    if (!good.length) good = await probeAll(c, c.rpcs.filter(shared));
    if (!good.length) return null;
    good.sort((a, b) => a.ms + (a.batch ? 0 : 1000) - (b.ms + (b.batch ? 0 : 1000)));
    const head = Math.max(...good.map((g) => g.head || 0)) || null;
    return { ...c, rpcs: good.slice(0, 2).map(({ url, batch, ms }) => ({ url, batch, ms })), head };
  }))).filter(Boolean);
  const list = { v: LIST_V, at: Date.now(), build_ms: Date.now() - t0, listed: chains.length, hosts: hosts.length, hosts_resolved: hosts.filter(resolves).length, rpcs_probed: probed, cluster, chains: live };
  try {
    const f = cacheFile();
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(`${f}.${process.pid}.tmp`, JSON.stringify(list));
    renameSync(`${f}.${process.pid}.tmp`, f);
  } catch (e) { STATE.cache_error = String(e.message || e).slice(0, 160); }
  return list;
}

let LIST = null, BUILDING = null, TIMER = null;
const STATE = { state: "cold" };
const summary = () => ({ ...STATE, listed: LIST?.listed ?? null, live: LIST?.chains.length ?? null, rpcs_probed: LIST?.rpcs_probed ?? null, built: LIST ? new Date(LIST.at).toISOString() : null, build_ms: LIST?.build_ms ?? null });
export const state = summary;

function rebuild() {
  STATE.state = LIST ? "refreshing" : "building";
  BUILDING ||= build().then((l) => { LIST = l; STATE.state = "ready"; delete STATE.error; return l; }, (e) => { STATE.state = LIST ? "ready" : "failed"; STATE.error = String(e?.message || e).slice(0, 200); throw e; }).finally(() => { BUILDING = null; });
  return BUILDING;
}

// load the disk cache (a stale one is used while a fresh one builds), else build; then refresh once a day
export async function warm({ force = false } = {}) {
  if (!LIST) try { LIST = JSON.parse(readFileSync(cacheFile(), "utf8")); STATE.state = "ready"; } catch {}
  TIMER ||= setInterval(() => rebuild().catch(() => {}), DAY).unref();
  if (force || !LIST) await rebuild();
  else if (Date.now() - LIST.at > DAY || LIST.v !== LIST_V) rebuild().catch(() => {});
  return summary();
}

// ---- one wallet ----------------------------------------------------------------------------------------------
// native balance + nonce (nonce > 0 = the wallet sent from there: worth a token lookup) on the first RPC that answers
async function readNative(c, address, run, until) {
  for (const r of c.rpcs) {
    const ms = Math.min(4000, until - Date.now());
    if (ms < 300) break;
    try {
      if (r.batch) {
        const a = await run(r.url, () => post(r.url, [rpc(1, "eth_getBalance", [address, "latest"]), rpc(2, "eth_getTransactionCount", [address, "latest"])], ms));
        const wei = hexNum(a?.find?.((x) => x?.id === 1)?.result);
        if (wei != null) return { wei, nonce: Number(hexNum(a.find((x) => x?.id === 2)?.result) ?? -1n) };
      } else {
        const a = await run(r.url, () => post(r.url, rpc(1, "eth_getBalance", [address, "latest"]), ms));
        const wei = hexNum(a?.result);
        if (wei != null) return { wei, nonce: -1 };
      }
    } catch {}
  }
  throw new Error("no rpc answered");
}

// tokens per chain id: Map(id -> Map(token address -> { symbol, decimals, raw, price?, source }))
function addToken(tokens, id, t) {
  const m = tokens.get(id) || tokens.set(id, new Map()).get(id);
  const k = t.token.toLowerCase();
  if (!m.has(k) && BigInt(t.raw) > 0n) m.set(k, t);
}
// Blockscout's multichain index (~40 chains): one paged walk per chain, in parallel. A single walk over every chain
// stopped at 8 pages while one wallet had 1,283 rows (26 pages): a $36 token on Lightlink sat on page 18
async function blockscoutCluster(address, tokens, ids, until) {
  const failed = [];
  await Promise.all(ids.map(async (id) => {
    let url = `${SOURCES.cluster}/addresses/${address}/tokens?type=ERC-20&page_size=100&chain_id=${id}`;
    for (let page = 0; url && page < 6; page++) {
      const ms = Math.min(8000, until - Date.now() - 1500);
      if (ms < 800) return;
      const r = await getJson(url, ms).catch(() => null);
      if (!r) { failed.push(id); return; }
      for (const i of r.items || []) {
        if (/^0x0+$/.test(i.token?.address_hash || "")) continue; // natives come from RPC
        for (const [cid, raw] of Object.entries(i.chain_values || {})) addToken(tokens, Number(cid), { token: i.token.address_hash, symbol: i.token.symbol, decimals: i.token.decimals, raw, explorer_price: Number(i.token.exchange_rate) || null, source: "blockscout" });
      }
      url = r.next_page_params ? `${SOURCES.cluster}/addresses/${address}/tokens?type=ERC-20&chain_id=${id}&${new URLSearchParams(r.next_page_params)}` : null; // next params carry page_size
    }
  }));
  if (failed.length === ids.length && ids.length) throw new Error("multichain index did not answer");
  return failed;
}
// Routescan: every chain it indexes in one paged call
async function routescan(address, tokens) {
  let url = `https://api.routescan.io/v2/network/mainnet/evm/all/address/${address}/erc20-holdings?limit=100`;
  for (let page = 0; url && page < 8; page++) {
    const r = await getJson(url, 8000);
    for (const i of r.items || []) addToken(tokens, Number(i.chainId), { token: i.tokenAddress, symbol: i.tokenSymbol, decimals: i.tokenDecimals, raw: i.tokenQuantity, explorer_price: Number(i.tokenPrice) || null, source: "routescan" });
    url = r.link?.next ? `https://api.routescan.io${r.link.next}` : null;
  }
}
// one Blockscout instance (chains outside the multichain index)
async function blockscoutOne(base, id, address, tokens, ms) {
  const r = await getJson(`${base}/api/v2/addresses/${address}/tokens?type=ERC-20`, ms);
  for (const i of r.items || []) addToken(tokens, id, { token: i.token?.address_hash || i.token?.address, symbol: i.token?.symbol, decimals: i.token?.decimals, raw: i.value, explorer_price: Number(i.token?.exchange_rate) || null, source: "blockscout" });
}
// Etherscan v2 (key set): token contracts from the transfer list, balances read on the chain's RPC
// Etherscan v2 mainnets (api.etherscan.io/v2/chainlist, 2026-10-15); the free plan answers 3 calls a second, so
// calls go one at a time, 350 ms apart (shared by every scan)
const ETHERSCAN = new Set([1, 10, 50, 56, 100, 130, 137, 143, 146, 199, 204, 252, 480, 988, 999, 1329, 2741, 4326, 4352, 4663, 5000, 5042, 8453, 9745, 33139, 42161, 42220, 43114, 59144, 80094, 81457, 167000, 737373, 747474]);
let esNext = Promise.resolve();
const esGate = (fn) => { const p = esNext.then(fn); esNext = p.catch(() => {}).then(() => sleep(350)); return p; };
// base set = a keyless Etherscan-style explorer of that chain (chains/explorers.json), else Etherscan v2 with the key
async function etherscanOne(c, address, tokens, run, ms, base) {
  if (ms < 500) return;
  const q = `module=account&action=tokentx&address=${address}&page=1&offset=200&sort=desc`;
  const r = await getJson(base ? `${base}?${q}` : `https://api.etherscan.io/v2/api?chainid=${c.id}&${q}&apikey=${process.env.ETHERSCAN_API_KEY}`, ms);
  if (!Array.isArray(r.result)) return;
  const seen = new Map();
  for (const t of r.result) if (!seen.has(t.contractAddress)) seen.set(t.contractAddress, t);
  const list = [...seen.values()].slice(0, 40), url = c.rpcs[0]?.url;
  if (!url || !list.length) return;
  const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  const call = (t, i) => rpc(i, "eth_call", [{ to: t.contractAddress, data }, "latest"]);
  const ans = c.rpcs[0].batch ? await run(url, () => post(url, list.map(call), ms)) : await Promise.all(list.map((t, i) => run(url, () => post(url, call(t, i), ms)).catch(() => null)));
  for (const a of Array.isArray(ans) ? ans : []) {
    const t = list[a?.id], raw = hexNum(a?.result?.slice?.(0, 66));
    if (t && raw) addToken(tokens, c.id, { token: t.contractAddress, symbol: t.tokenSymbol, decimals: t.tokenDecimal, raw: raw.toString(), explorer_price: null, source: "etherscan" });
  }
}

// DefiLlama prices for coingecko ids and chain:address keys, 60 per call
async function prices(keys) {
  const out = {}, list = [...new Set(keys)];
  await Promise.all(Array.from({ length: Math.ceil(list.length / 60) }, (_, i) => getJson(`https://coins.llama.fi/prices/current/${list.slice(i * 60, i * 60 + 60).join(",")}?searchWidth=6h`, 8000).then((r) => Object.assign(out, r.coins || {}), () => {})));
  const low = {};
  for (const [k, v] of Object.entries(out)) low[k.toLowerCase()] = v;
  return low;
}

// past deposits from this wallet into a shut-down chain's bridge on its parent chain (Alchemy transfers, one paged
// call per parent): the hint when no balance can be read on the dead chain itself. Contracts several chains share
// (Agglayer bridge, ZK stack BridgeHub) cannot say which chain a deposit went to, so they are left out
const SHARED = (() => { const n = new Map(); for (const s of SUNSET) for (const b of s.l1_bridges || []) n.set(b.address.toLowerCase(), (n.get(b.address.toLowerCase()) || 0) + 1); return new Set([...n].filter(([, k]) => k > 1).map(([a]) => a)); })();
async function deposits(address, rows) {
  const key = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  const byParent = new Map();
  for (const s of rows) for (const b of s.l1_bridges || []) {
    const p = s.parent || "ethereum", a = b.address.toLowerCase();
    if (ALCHEMY_NET[p] && !SHARED.has(a)) (byParent.get(p) || byParent.set(p, new Map()).get(p)).set(a, s.id);
  }
  const hits = new Map();
  if (!key || !byParent.size) return hits;
  await Promise.all([...byParent].map(async ([parent, bridges]) => {
    let pageKey;
    for (let p = 0; p < 4; p++) {
      const r = await post(`https://${ALCHEMY_NET[parent]}.g.alchemy.com/v2/${key}`, rpc(1, "alchemy_getAssetTransfers", [{ fromAddress: address, category: ["external", "erc20"], withMetadata: true, excludeZeroValue: false, maxCount: "0x3e8", ...(pageKey && { pageKey }) }]), 10000).catch(() => null);
      for (const t of r?.result?.transfers || []) {
        const id = bridges.get(String(t.to || "").toLowerCase());
        if (id) (hits.get(id) || hits.set(id, []).get(id)).push({ tx: t.hash, date: t.metadata?.blockTimestamp?.slice(0, 10) || null, asset: t.asset, value: t.value });
      }
      pageKey = r?.result?.pageKey;
      if (!pageKey) break;
    }
  }));
  for (const d of hits.values()) d.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return hits;
}

// Every live chain (or opts.chains) for one wallet, in about budgetMs. Retains unpriced ERC-20 balances with known
// decimals for the scan's market fallback, plus used chains and one row per shut-down chain with something found.
export async function checkWallet(address, { chains, budgetMs = 18000 } = {}) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(address))) throw { status: 400, error: "address must be an EVM 0x address" };
  const t0 = Date.now(), until = t0 + budgetMs;
  if (!(process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY)) noteKey("ALCHEMY_API_KEY", "ERC-20 tokens on Alchemy's 34 networks and past deposits to shut-down chains");
  if (!LIST) {
    const w = warm();
    await Promise.race([w.catch(() => {}), sleep(budgetMs / 2)]);
    if (!LIST) throw { status: 503, error: `chain list not ready (${STATE.state}${STATE.error ? `: ${STATE.error}` : ""}): the first run probes every public RPC, about 40 s` };
  }
  const want = chains?.length ? new Set(chains.map(Number)) : null;
  const sunsetById = new Map(SUNSET.map((s) => [Number(s.chain_id), s]));
  const live = LIST.chains.filter((c) => !want || want.has(c.id));
  const byId = new Map(LIST.chains.map((c) => [c.id, c]));
  const run = limiter(Number(process.env.CHAINS_CONCURRENCY) || 48, 8), tokens = new Map(), errors = {};
  const sunsetRows = SUNSET.filter((s) => !want || want.has(Number(s.chain_id)));
  const note = (k) => (e) => { errors[k] = String(e?.message || e).slice(0, 120); };
  await Promise.race([resolveHosts([...live, ...sunsetRows].flatMap((c) => (c.rpcs || []).map((r) => new URL(r.url || r).hostname))), sleep(3000)]);

  // natives on every chain + the three all-chain token indexes + L1 deposit hints, in parallel
  const nat = new Map(), failed = [];
  const covered = new Set([...(LIST.cluster || [])]);
  const [, [, , al], dep] = await Promise.all([
    Promise.all(live.map((c) => readNative(c, address, run, until).then((v) => nat.set(c.id, v), () => failed.push(c.id)))),
    Promise.all([blockscoutCluster(address, tokens, (LIST.cluster || []).filter((id) => !want || want.has(id)), until).catch(note("blockscout_cluster")), routescan(address, tokens).catch(note("routescan")),
      alchemyTokens(address, tokens, until, { addToken }).catch((e) => { note("alchemy")(e); return null; })]),
    deposits(address, sunsetRows).catch((e) => { note("deposits")(e); return new Map(); }),
  ]);
  for (const id of tokens.keys()) covered.add(id);
  if (al?.calls && !al.failed.length) for (const id of ALCHEMY_IDS) covered.add(id);
  else if (al?.failed?.length) errors.alchemy = al.failed.slice(0, 5).join("; ");

  // per-instance lookups only where the wallet did something and no index covered the chain
  const used = (id) => { const n = nat.get(id); return !!n && (n.wei > 0n || n.nonce > 0); };
  const left = () => Math.max(0, until - Date.now() - 1500);
  const extra = live.filter((c) => used(c.id) && !covered.has(c.id));
  await Promise.all(extra.map(async (c) => {
    const ms = Math.min(6000, left());
    if (ms < 500) return;
    try {
      if (c.blockscout) await run(c.blockscout, () => blockscoutOne(c.blockscout, c.id, address, tokens, ms));
      else if (c.etherscan && c.rpcs[0]) await run(c.etherscan, () => etherscanOne(c, address, tokens, run, ms, c.etherscan));
      else if (process.env.ETHERSCAN_API_KEY && ETHERSCAN.has(c.id) && c.rpcs[0]) await esGate(() => etherscanOne(c, address, tokens, run, Math.min(6000, left())));
    } catch (e) { note(`tokens:${c.id}`)(e); }
  }));
  // shut-down chains with no live RPC in the list: their own RPCs or explorer, if one still answers
  await Promise.all(sunsetRows.filter((s) => !nat.has(Number(s.chain_id)) && (s.rpcs?.length || s.explorer)).map(async (s) => {
    const id = Number(s.chain_id), c = { id, rpcs: (s.rpcs || []).map((url) => ({ url, batch: false })) };
    await readNative(c, address, run, Math.min(until, Date.now() + 5000)).then((v) => nat.set(id, v), () => {});
    if (s.explorer && s.explorer_kind === "blockscout" && !tokens.has(id) && left() > 500) await blockscoutOne(s.explorer.replace(/\/+$/, ""), id, address, tokens, Math.min(5000, left())).catch(note(`tokens:${id}`));
  }));

  // price everything in one pass
  const meta = (id) => byId.get(id) || { id, slug: ZSLUG.get(id) || sunsetById.get(id)?.id || String(id), native: { symbol: sunsetById.get(id)?.native || "ETH", decimals: 18 }, gecko: sunsetById.get(id)?.native === "ETH" ? "ethereum" : null, llama: null };
  const keys = [];
  for (const [id, n] of nat) if (n.wei > 0n && meta(id).gecko) keys.push(`coingecko:${meta(id).gecko}`);
  for (const [id, m] of tokens) if (meta(id).llama) for (const k of m.keys()) keys.push(`${meta(id).llama}:${k}`);
  const px = keys.length ? await prices(keys) : {};

  const balances = [];
  let unpriced = 0;
  const now = Date.now() / 1000;
  const push = (c, b) => {
    const halted = !!(c.head && now - c.head > HALTED_S);
    balances.push({ chain_id: c.id, chain: c.slug, ...b, ...(halted && { halted: new Date(c.head * 1000).toISOString().slice(0, 10) }), ...(sunsetById.has(c.id) && { sunset: sunsetById.get(c.id).id }) });
  };
  for (const [id, n] of nat) {
    if (n.wei === 0n) continue;
    const c = meta(id), p = c.gecko ? px[`coingecko:${c.gecko}`] : null;
    const amount = units(n.wei, c.native.decimals);
    if (!p?.price) { unpriced++; continue; }
    push(c, { asset: p.symbol || c.native.symbol, token: NATIVE, amount, usd: amount * p.price, verified: true, source: "rpc" });
  }
  const priced = [];
  for (const [id, m] of tokens) {
    const c = meta(id);
    for (const [k, t] of m) {
      const p = c.llama ? px[`${c.llama}:${k}`] : null;
      const decimals = t.decimals ?? p?.decimals, price = p?.price ?? t.explorer_price ?? t.alchemy_price;
      if (!price || !Number.isFinite(units(t.raw, decimals))) {
        unpriced++;
        // Keep a known token balance for the scan's public market-price fallback. Never count it as verified.
        if (decimals != null && Number.isInteger(Number(decimals)) && Number(decimals) >= 0 && Number(decimals) <= 36 && t.raw > 0n) {
          push(c, { asset: t.symbol || k, token: k, amount: units(t.raw, decimals), usd: null, verified: false, price_from: "none", amount_from: t.source, source: t.source });
        }
        continue;
      }
      priced.push({ c, k, t, p, decimals, price });
    }
  }
  // indexes lag (Blockscout's multichain index was a month stale on a test wallet): re-read every token worth $0.50+
  // with balanceOf on the chain's own RPC, one batch per chain; a token the RPC says is gone is dropped
  const fresh = new Map(), byChain = new Map();
  for (const x of priced) if (units(x.t.raw, x.decimals) * x.price >= 0.5 && x.c.rpcs?.[0]) (byChain.get(x.c.id) || byChain.set(x.c.id, []).get(x.c.id)).push(x);
  const data = "0x70a08231" + address.slice(2).toLowerCase().padStart(64, "0");
  await Promise.all([...byChain.values()].flatMap((xs) => {
    const chunks = []; // public RPCs cap batch size (1rpc.io: a few calls), so 10 per batch, next RPC on failure
    for (let i = 0; i < Math.min(xs.length, 100); i += 10) chunks.push(xs.slice(i, i + 10));
    return chunks.map(async (part) => {
      const calls = part.map((x, i) => rpc(i, "eth_call", [{ to: x.k, data }, "latest"]));
      for (const r of xs[0].c.rpcs) {
        const ms = Math.max(1500, Math.min(4000, until - Date.now()));
        const ans = r.batch ? await run(r.url, () => post(r.url, calls, ms)).catch(() => null) : await Promise.all(calls.map((q) => run(r.url, () => post(r.url, q, ms)).catch(() => null)));
        const got = (Array.isArray(ans) ? ans : []).filter((a) => hexNum(a?.result?.slice?.(0, 66)) != null && part[a.id]);
        for (const a of got) fresh.set(part[a.id], hexNum(a.result.slice(0, 66)));
        if (got.length === part.length) break;
      }
    });
  }));
  // a vault share (ERC-4626) whose maxWithdraw is 0 cannot be redeemed now (Katana's kpdUSDC: $5k on one wallet that
  // other trackers leave out): kept, marked locked. Tokens that are not vaults revert and stay as they are
  const locked = new Set(), mw = "0xce96cb77" + address.slice(2).toLowerCase().padStart(64, "0");
  await Promise.all(priced.filter((x) => units(fresh.get(x) ?? x.t.raw, x.decimals) * x.price >= 10 && x.c.rpcs?.[0]).slice(0, 40).map(async (x) => {
    const r = x.c.rpcs[0], ms = Math.max(1000, Math.min(3000, until - Date.now()));
    const a = await run(r.url, () => post(r.url, rpc(1, "eth_call", [{ to: x.k, data: mw }, "latest"]), ms)).catch(() => null);
    if (typeof a?.result === "string" && a.result.length === 66 && hexNum(a.result) === 0n) locked.add(x);
  }));
  for (const x of priced) {
    const raw = fresh.has(x) ? fresh.get(x) : x.t.raw, amount = units(raw, x.decimals);
    if (!(amount > 0)) continue;
    if (BigInt(raw) === nat.get(x.c.id)?.wei) continue; // the native coin's own ERC-20 face (CELO, Metis 0xdead...0000): same balance, counted once
    // DefiLlama with a deep market = verified; a thin market or an explorer-only price stays unverified
    push(x.c, { asset: x.t.symbol || x.p?.symbol || x.k, token: x.k, amount, usd: amount * x.price, verified: !!(x.p?.price && (x.p.confidence ?? 1) >= 0.9), price_from: x.p?.price ? "defillama" : x.t.explorer_price ? "explorer" : "alchemy", amount_from: fresh.has(x) ? "rpc" : x.t.source, source: x.t.source, ...(locked.has(x) && { locked: true }) });
  }
  balances.sort((a, b) => b.usd - a.usd);

  const sunset = [];
  for (const s of sunsetRows) {
    const id = Number(s.chain_id), bal = balances.filter((b) => b.chain_id === id), d = dep.get(s.id) || [];
    if (!bal.length && !d.length) continue;
    const read = nat.has(id) ? "rpc" : tokens.has(id) ? "explorer" : "none";
    sunset.push({ id: s.id, name: s.name, when: whenText(s), chain_id: id, chain: id ? meta(id).slug : s.id, status: s.status, shutdown: s.shutdown, closes: s.closes, exit: s.exit, link: s.link || s.source, source: s.source, read, balances: bal, deposits: d.slice(0, 10), deposits_count: d.length });
  }
  const active = [...nat].filter(([id]) => used(id)).map(([id, n]) => ({ chain_id: id, chain: meta(id).slug, nonce: n.nonce >= 0 ? n.nonce : null }));
  return {
    address, chains_listed: LIST.listed, chains_live: LIST.chains.length, chains_checked: nat.size, chains_failed: failed.length, ms: Date.now() - t0,
    balances: balances.filter((b) => !b.sunset), sunset, active, unpriced,
    token_sources: { blockscout_cluster: !errors.blockscout_cluster, routescan: !errors.routescan, alchemy: !!al?.calls, per_chain: extra.length, etherscan: !!process.env.ETHERSCAN_API_KEY },
    failed: failed.slice(0, 50), errors, list_built: new Date(LIST.at).toISOString(),
  };
}

export const whenText = (s) => `${s.name} ${s.status === "closing" ? "is closing" : "shut down"}${s.shutdown ? ` (${s.status === "closing" ? "stops " : ""}${s.shutdown})` : ""}`;
// shut-down chains Zerion has a slug for, as deadline rows (match.chain) so a Zerion balance there is an exit finding
// too, never a spendable holding; a closed exit window stays in with expired: true. Rows already in data/deadlines.json
// (same id or chain) are left out
export const sunsetDeadlines = (have = [], { now = Date.now() } = {}) => SUNSET.flatMap((s) => {
  const slug = ZSLUG.get(Number(s.chain_id)), past = !!s.closes && s.closes < new Date(now).toISOString().slice(0, 10);
  if (!slug || have.some((d) => d.id === s.id || d.match?.chain === slug)) return [];
  return [{ id: s.id, name: s.name, chains: [slug], closes: s.closes, what: whenText(s), how_to_check: s.exit, link: s.link || s.source, source: s.source, category: "bridge_stuck", match: { chain: slug }, ...(past && { expired: true }) }];
});

export { SUNSET };
