// keyless.mjs - stand-ins for the keyed upstreams when their key is unset (registry.mjs `keyless`), and the notes a
// scan lists in skipped_for_keys. With the key set none of this runs: the keyed path is the same as before.
//
// Alchemy JSON-RPC without ALCHEMY_API_KEY (keylessRpc): plain eth_* methods go to the network's public RPC
// (publicnode), receipts it pruned to an archive RPC; eth_getLogs over the full history, alchemy_getAssetTransfers
// (erc20 + external) go to Routescan's keyless Etherscan-style API, token balances to Blockscout's v2 API. A network
// with no such source throws needKey: the part is skipped and noted, never faked.
// Measured 2026-10-22: Routescan serves Ethereum, Avalanche, Mantle and Blast only; Blockscout's Etherscan-style /api
// (and its eth-rpc) allows about 10 keyless calls per half hour per IP across all its instances, too few for a scan
// (its v2 API allows 180 a minute); base, arbitrum and polygon Blockscout sit behind a bot check; publicnode refuses
// full-range getLogs ("Archive requests require a personal token") and drpc, 1rpc, mainnet.base.org cap the range.
// So every other network still needs the key for history.
import { AsyncLocalStorage } from "node:async_hooks";

export const SOLANA_PUBLIC = "https://api.mainnet-beta.solana.com";
const PN = (h) => `https://${h}-rpc.publicnode.com`;
// Alchemy network -> keyless public RPC
export const PUBLIC_RPC = {
  "eth-mainnet": PN("ethereum"), "base-mainnet": PN("base"), "arb-mainnet": PN("arbitrum-one"), "opt-mainnet": PN("optimism"),
  "polygon-mainnet": PN("polygon-bor"), "matic-mainnet": PN("polygon-bor"), "bnb-mainnet": PN("bsc"), "linea-mainnet": PN("linea"), "scroll-mainnet": PN("scroll"),
  "celo-mainnet": PN("celo"), "gnosis-mainnet": PN("gnosis"), "berachain-mainnet": PN("berachain"), "unichain-mainnet": PN("unichain"),
  "mantle-mainnet": PN("mantle"), "avax-mainnet": PN("avalanche-c-chain"), "sonic-mainnet": PN("sonic"), "taiko-mainnet": PN("taiko"),
  "blast-mainnet": PN("blast"), "ink-mainnet": PN("ink"), "cronos-mainnet": PN("cronos-evm"), "sei-mainnet": PN("sei-evm"),
  "soneium-mainnet": PN("soneium"), "opbnb-mainnet": PN("opbnb"), "frax-mainnet": PN("fraxtal"), "zksync-mainnet": "https://mainnet.era.zksync.io",
  "zora-mainnet": "https://rpc.zora.energy", "mode-mainnet": "https://mainnet.mode.network", "monad-mainnet": "https://rpc.monad.xyz",
  "ronin-mainnet": "https://api.roninchain.com/rpc", "solana-mainnet": SOLANA_PUBLIC,
};
// receipts of old txs (publicnode answers null for them)
const ARCHIVE_RPC = { "eth-mainnet": ["https://eth.drpc.org", "https://rpc.mevblocker.io"] };
// Etherscan-style APIs (logs, txlist) that answer keyless, tried in order; 1000 rows a page
const ROUTESCAN = (id) => `https://api.routescan.io/v2/network/mainnet/evm/${id}/etherscan/api`;
export const EXPLORERS = { "eth-mainnet": [ROUTESCAN(1)], "avax-mainnet": [ROUTESCAN(43114)], "mantle-mainnet": [ROUTESCAN(5000)], "blast-mainnet": [ROUTESCAN(81457)] };
// Blockscout v2 hosts for token balances
const BLOCKSCOUT = { "eth-mainnet": "eth.blockscout.com", "opt-mainnet": "explorer.optimism.io", "unichain-mainnet": "unichain.blockscout.com", "celo-mainnet": "celo.blockscout.com" };
// DefiLlama chain key per network, and the native coin
export const LLAMA = {
  "eth-mainnet": "ethereum", "base-mainnet": "base", "arb-mainnet": "arbitrum", "opt-mainnet": "optimism", "polygon-mainnet": "polygon", "matic-mainnet": "polygon",
  "bnb-mainnet": "bsc", "linea-mainnet": "linea", "scroll-mainnet": "scroll", "celo-mainnet": "celo", "gnosis-mainnet": "xdai", "unichain-mainnet": "unichain",
  "mantle-mainnet": "mantle", "avax-mainnet": "avax", "blast-mainnet": "blast", "sonic-mainnet": "sonic", "zksync-mainnet": "era", "berachain-mainnet": "berachain",
};
const NATIVE = { "polygon-mainnet": "coingecko:polygon-ecosystem-token", "matic-mainnet": "coingecko:polygon-ecosystem-token", "bnb-mainnet": "coingecko:binancecoin", "celo-mainnet": "coingecko:celo", "gnosis-mainnet": "coingecko:xdai", "mantle-mainnet": "coingecko:mantle", "avax-mainnet": "coingecko:avalanche-2", "sonic-mainnet": "coingecko:sonic-3", "berachain-mainnet": "coingecko:berachain-bera" };
export const nativeCoin = (net) => NATIVE[net] || "coingecko:ethereum";

// ---- skipped_for_keys notes ----------------------------------------------------------------------------------
// A scan runs each source inside KEY_NOTES.run({ id, list }); a part skipped for a missing key lands in that list,
// however deep in the source it happened (stuck bridges, a library's own RPC calls)
export const KEY_NOTES = new AsyncLocalStorage();
export function noteKey(key, why) {
  const s = KEY_NOTES.getStore();
  if (s && !s.list.some((n) => n.id === s.id && n.key === key && n.why === why)) s.list.push({ id: s.id, key, why });
}
// the error a skipped part throws (and notes): { needs_key, why, error }
export function needKey(why, key = "ALCHEMY_API_KEY") {
  noteKey(key, why);
  return Object.assign(new Error(`${why}: no keyless source, needs ${key}`), { needs_key: key, why, error: `${why}: no keyless source, needs ${key}` });
}

// An Alchemy app answers 403 "ETH_MAINNET is not enabled for this app" for each network turned off in it: with a key
// set, such a network takes the keyless path above for the rest of the process, as if there were no key.
const ALCHEMY_OFF = new Set();
export const alchemyOff = (net) => ALCHEMY_OFF.has(net);
export const notEnabled = (text) => /is not enabled for this app/i.test(String(text ?? ""));
export function markAlchemyOff(net) {
  if (ALCHEMY_OFF.has(net)) return;
  ALCHEMY_OFF.add(net);
  // one line per process, not one per network (an app can have twenty off)
  if (ALCHEMY_OFF.size === 1) console.error(`alchemy: some networks are off in this Alchemy app (first: ${net}), so they go through the keyless path: turn on every network in the Alchemy dashboard`);
}
// The Alchemy Free plan answers eth_getLogs over 10 blocks at most (400 "Under the Free tier plan, you can make
// eth_getLogs requests with up to a 10 block range", 2026-10-27), so every full-history log read failed and
// stuck/lib.mjs split the range down to 10 blocks until the bridge check timed out. With such a key, the wide
// eth_getLogs of the rest of the process take the keyless path above; every other Alchemy method stays on the key.
export const ALCHEMY_PAID = "a paid Alchemy plan";
const LOGS = { capped: false };
export const logsCapped = () => LOGS.capped;
export const freeLogsCap = (text) => /free tier plan.{0,80}eth_getLogs.{0,60}block range/i.test(String(text ?? ""));
export function markLogsCapped() {
  if (LOGS.capped) return;
  LOGS.capped = true;
  console.error("alchemy: Free plan key, some history checks are skipped (listed at the end of the report)");
}
// one 16-block eth_getLogs on Ethereum before a scan: a Free plan key is known before any source runs, so an index
// that only full-history logs can build (Ronin, Starknet) is skipped up front instead of starting over on every run
export async function probeLogsCap(key = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY) {
  if (!key || LOGS.capped) return LOGS.capped;
  try {
    const r = await fetch(`https://eth-mainnet.g.alchemy.com/v2/${key}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x1", toBlock: "0x10", address: "0x0000000000000000000000000000000000000000" }] }), signal: AbortSignal.timeout(5000) });
    if (freeLogsCap(await r.text())) markLogsCapped();
  } catch {} // no answer: the first wide read finds out instead
  return LOGS.capped;
}
// an eth_getLogs filter over more than the Free plan's 10 blocks ("latest" or no end counts as wide)
export function wideLogs(filter = {}) {
  if (filter.blockHash) return false;
  const b = (v) => (v == null || v === "latest" || v === "pending" || v === "safe" || v === "finalized" ? null : BigInt(v));
  const from = b(filter.fromBlock ?? "0x0"), to = b(filter.toBlock);
  return from == null || to == null || to - from >= 10n;
}
// a JSON-RPC body (one call or a batch) with a wide eth_getLogs in it
export const wideLogsBody = (body) => [body].flat().some((b) => b?.method === "eth_getLogs" && wideLogs(b.params?.[0]));
// a thrown viem / fetch error -> all its text, causes included
export const errText = (e) => { const out = []; for (let x = e, i = 0; x && i < 6; x = x.cause, i++) out.push(x.message, x.details, x.shortMessage); return out.filter(Boolean).join(" "); };

// ---- http ----------------------------------------------------------------------------------------------------
// publicnode also serves the keyless evm.rpc route: unpaced, a keyless scan's bridge and airdrop reads made it drop
// connections ("fetch failed") for every other Ethereum read of the scan (2026-10-22)
const RPS = { "api.routescan.io": 2, "blockscout.com": 2, "explorer.optimism.io": 2, "coins.llama.fi": 5, "publicnode.com": 15 };
const nextSlot = new Map();
async function pace(url) {
  const host = new URL(url).host, k = Object.keys(RPS).find((h) => host === h || host.endsWith(`.${h}`));
  if (!k) return;
  const now = Date.now(), at = Math.max(now, nextSlot.get(k) || 0);
  nextSlot.set(k, at + 1000 / RPS[k]);
  if (at > now) await new Promise((ok) => setTimeout(ok, at - now));
}
async function http(url, init = {}, ms = 30000) {
  for (let i = 0; ; i++) {
    await pace(url);
    const r = await fetch(url, { ...init, signal: AbortSignal.timeout(ms) }).catch((e) => { if (i < 2 && e?.name !== "TimeoutError") return null; throw e; });
    if (!r) { await new Promise((ok) => setTimeout(ok, 800 * 2 ** i)); continue; } // dropped connection: once more
    if ((r.status === 429 || r.status >= 500) && i < 2) { await new Promise((ok) => setTimeout(ok, 800 * 2 ** i)); continue; }
    const text = await r.text();
    try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: null, text: text.slice(0, 120) }; }
  }
}
export async function rpcAt(url, method, params = []) {
  const r = await http(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }, 20000);
  if (!r.body) throw new Error(`${method}: HTTP ${r.status} ${r.text || ""}`.trim());
  if (r.body.error) throw new Error(`${method}: ${r.body.error.message || JSON.stringify(r.body.error)}`);
  return r.body.result;
}
const publicRpc = (net) => PUBLIC_RPC[net] || null;

// one Etherscan-style query on the first explorer of net that answers: -> result[] ([] for "no records")
async function explorer(net, q, what) {
  const bases = EXPLORERS[net];
  if (!bases) throw needKey(`${what} on ${net}`);
  let last;
  for (const base of bases) {
    try {
      let r = await http(`${base}?${new URLSearchParams(q)}`);
      // a rate limit answered as HTTP 200 + NOTOK (Etherscan style): wait and ask again
      for (let i = 0; i < 3 && /rate limit|too many/i.test(`${r.body?.message} ${r.body?.result}`); i++) {
        await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i));
        r = await http(`${base}?${new URLSearchParams(q)}`);
      }
      const b = r.body;
      if (b && Array.isArray(b.result)) return b.result;
      if (b && /no (records|logs|transactions|token)/i.test(`${b.message} ${b.result}`)) return [];
      last = new Error(`${new URL(base).host}: ${b ? `${b.message || ""} ${typeof b.result === "string" ? b.result : ""}`.trim() : `HTTP ${r.status}`}`);
    } catch (e) { last = e; }
  }
  throw last;
}

// ---- eth_getLogs over any range ------------------------------------------------------------------------------
const hex = (v) => (v == null || v === "" ? "0x0" : String(v).startsWith("0x") ? String(v).toLowerCase() : `0x${BigInt(v).toString(16)}`);
const num = (v) => (v == null || v === "latest" ? null : Number(BigInt(v)));
const toLog = (l) => ({ address: String(l.address).toLowerCase(), topics: (l.topics || []).filter(Boolean), data: l.data || "0x", blockNumber: hex(l.blockNumber), blockHash: l.blockHash ?? null, transactionHash: l.transactionHash, transactionIndex: hex(l.transactionIndex), logIndex: hex(l.logIndex), removed: false, timeStamp: l.timeStamp != null ? Number(BigInt(l.timeStamp)) : null });
// MAX_LOGS: past it a query needs the key, never split and crawled again (an index build like dYdX's ~110k
// registrations took 6 min of pages and still failed, 2026-10-22)
const PAGE = 1000, MAX_LOGS = 20_000;
// a topic position: null (any), one value, or an OR list -> every single-value combination (Etherscan-style APIs
// take one value per topic)
function combos(topics = []) {
  let out = [[]];
  for (const t of topics) {
    const opts = t == null ? [null] : [t].flat();
    out = out.flatMap((c) => opts.map((o) => [...c, o]));
  }
  return out;
}
export async function logs(net, filter = {}) {
  const what = `full-history event logs`;
  // a Free plan key reaches here too (markLogsCapped): what the part needs then is the paid plan, not a key
  const key = LOGS.capped ? ALCHEMY_PAID : undefined;
  const skip = (why) => needKey(why, key);
  if (!EXPLORERS[net]) throw skip(`${what} on ${net}`);
  const addrs = filter.address == null ? [null] : [filter.address].flat();
  const sets = combos(filter.topics);
  // Etherscan-style APIs take one value per topic: past 64 single-value queries a scan would crawl, so it needs the key
  if (addrs.length * sets.length > 64) throw skip(`${what} on ${net} (${addrs.length * sets.length} topic / address combinations)`);
  const from0 = num(filter.fromBlock) ?? 0, to = num(filter.toBlock);
  const seen = new Map();
  // the queries run side by side (http() paces each host); each walks its pages from the last block
  await Promise.all(addrs.flatMap((address) => sets.map(async (set) => {
    const used = set.map((t, i) => [t, i]).filter(([t]) => t != null);
    if (!address && !used.length) throw new Error("eth_getLogs: no address or topic to narrow it down");
    for (let from = from0; ;) {
      const q = { module: "logs", action: "getLogs", fromBlock: String(from), toBlock: to == null ? "latest" : String(to), page: "1", offset: String(PAGE) };
      if (address) q.address = address;
      for (const [t, i] of used) q[`topic${i}`] = t;
      for (let x = 0; x < used.length; x++) for (let y = x + 1; y < used.length; y++) q[`topic${used[x][1]}_${used[y][1]}_opr`] = "and";
      // Routescan gives up on a sparse topic over the whole history ("Timeout reached, please use a narrower block
      // range", LlamaPay's StreamCreated on Ethereum): no keyless source can answer that, so it is a skip, not a failure
      const page = await explorer(net, q, what).catch((e) => { throw /narrower block range/i.test(errText(e)) ? skip(`${what} on ${net} (too much history for the keyless explorer)`) : e; });
      for (const l of page) seen.set(`${l.transactionHash}:${hex(l.logIndex)}`, toLog(l));
      if (seen.size > MAX_LOGS) throw skip(`${what} on ${net} (more than ${MAX_LOGS} logs)`);
      if (page.length < PAGE) break;
      const last = num(page.at(-1).blockNumber);
      if (last <= from) throw new Error(`eth_getLogs: over ${PAGE} logs in block ${from}, not read`);
      from = last; // the last block again: logs past the page cut come back, duplicates drop
    }
  })));
  return [...seen.values()].sort((a, b) => num(a.blockNumber) - num(b.blockNumber) || num(a.logIndex) - num(b.logIndex));
}

// ---- alchemy_* methods ---------------------------------------------------------------------------------------
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad = (a) => `0x${String(a).toLowerCase().slice(2).padStart(64, "0")}`;
const iso = (s) => (s ? new Date(s * 1000).toISOString() : null);
const TX_PAGE = 1000, TX_MAX = 10_000; // Etherscan-style tx lists stop at page x offset = 10,000
// alchemy_getAssetTransfers for the erc20 and external categories (what the scans ask): erc20 from Transfer logs,
// external from the explorer's tx list; other categories need the key
async function assetTransfers(net, p = {}) {
  const cats = [p.category || ["external", "erc20"]].flat();
  const other = cats.filter((c) => !["erc20", "external"].includes(c));
  if (other.length) throw needKey(`${other.join(", ")} transfers on ${net}`);
  const from = p.fromAddress?.toLowerCase(), to = p.toAddress?.toLowerCase(), out = [];
  if (cats.includes("erc20")) {
    const got = await logs(net, { fromBlock: p.fromBlock, toBlock: p.toBlock, address: p.contractAddresses?.length ? p.contractAddresses : undefined, topics: [TRANSFER, from ? pad(from) : null, to ? pad(to) : null] });
    for (const l of got) if (l.topics.length === 3) out.push({ blockNum: l.blockNumber, hash: l.transactionHash, from: `0x${l.topics[1].slice(26)}`, to: `0x${l.topics[2].slice(26)}`, value: null, asset: null, category: "erc20", rawContract: { address: l.address, value: l.data, decimal: null }, metadata: { blockTimestamp: iso(l.timeStamp) }, uniqueId: `${l.transactionHash}:log:${num(l.logIndex)}` });
  }
  if (cats.includes("external")) {
    if (!from && !to) throw new Error("alchemy_getAssetTransfers: external transfers need fromAddress or toAddress");
    // the first 10,000 txs in pages of 1,000: one 10,000-row page of a long history (vitalik.eth) answers 502 after 30 s
    // on Routescan, while 1,000-row pages take ~5 s each and run side by side
    const page = (n) => explorer(net, { module: "account", action: "txlist", address: from || to, startblock: String(num(p.fromBlock) ?? 0), endblock: "99999999", sort: "asc", page: String(n), offset: String(TX_PAGE) }, "transaction history");
    const first = await page(1);
    const txs = first.length < TX_PAGE ? first : [first, ...await Promise.all(Array.from({ length: TX_MAX / TX_PAGE - 1 }, (_, i) => page(i + 2)))].flat();
    for (const t of txs) {
      if ((from && t.from?.toLowerCase() !== from) || (to && t.to?.toLowerCase() !== to) || String(t.isError) === "1") continue;
      if (p.excludeZeroValue !== false && BigInt(t.value || 0) === 0n) continue;
      out.push({ blockNum: hex(t.blockNumber), hash: t.hash, from: t.from?.toLowerCase(), to: t.to?.toLowerCase() || null, value: Number(BigInt(t.value || 0)) / 1e18, asset: "ETH", category: "external", rawContract: { address: null, value: hex(t.value || 0), decimal: "0x12" }, metadata: { blockTimestamp: iso(Number(t.timeStamp)) }, uniqueId: `${t.hash}:external` });
    }
  }
  out.sort((a, b) => num(a.blockNum) - num(b.blockNum));
  if (p.order === "desc") out.reverse();
  return { transfers: out.slice(0, p.maxCount ? Number(BigInt(p.maxCount)) : 1000) };
}
// ERC-20 balances of one address from Blockscout v2: [{ contractAddress, tokenBalance (hex), decimals, symbol, name }]
async function tokenList(net, address) {
  if (!BLOCKSCOUT[net]) throw needKey(`ERC-20 balances on ${net}`);
  const r = await http(`https://${BLOCKSCOUT[net]}/api/v2/addresses/${address}/token-balances`);
  if (!Array.isArray(r.body)) throw new Error(`${BLOCKSCOUT[net]}: token balances HTTP ${r.status} ${r.body?.message || r.text || ""}`.trim());
  return r.body.filter((t) => t.token?.type === "ERC-20" && BigInt(t.value || 0) > 0n)
    .map(({ token: t, value }) => ({ contractAddress: t.address_hash.toLowerCase(), tokenBalance: hex(value), decimals: t.decimals == null ? null : Number(t.decimals), symbol: t.symbol || null, name: t.name || null }));
}
const word = (r, i = 0) => BigInt(`0x${(r || "0x").slice(2 + 64 * i, 66 + 64 * i) || "0"}`);
function text(r) { // an ABI string (or a bytes32 one, old tokens)
  try {
    const h = (r || "0x").slice(2);
    if (h.length === 64) return Buffer.from(h, "hex").toString("utf8").replace(/\0+$/, "") || null;
    const len = Number(word(r, 1));
    return Buffer.from(h.slice(128, 128 + len * 2), "hex").toString("utf8") || null;
  } catch { return null; }
}

// Alchemy JSON-RPC on net without a key -> result (throws like a JSON-RPC error)
export async function keylessRpc(net, method, params = []) {
  if (method === "eth_getLogs") return logs(net, params[0]);
  if (method === "alchemy_getAssetTransfers") return assetTransfers(net, params[0]);
  if (method === "alchemy_getTokenBalances") {
    if (params[1] && params[1] !== "erc20" && params[1] !== "DEFAULT_TOKENS") throw needKey(`alchemy_getTokenBalances for a contract list on ${net}`);
    return { address: params[0], tokenBalances: (await tokenList(net, params[0])).map(({ contractAddress, tokenBalance }) => ({ contractAddress, tokenBalance })) };
  }
  const url = publicRpc(net);
  if (method === "alchemy_getTokenMetadata") {
    if (!url) throw needKey(`token metadata on ${net}`);
    const [d, s, n] = await Promise.all(["0x313ce567", "0x95d89b41", "0x06fdde03"].map((data) => rpcAt(url, "eth_call", [{ to: params[0], data }, "latest"]).catch(() => null)));
    return { decimals: d ? Number(word(d)) : null, symbol: text(s), name: text(n), logo: null };
  }
  if (method.startsWith("alchemy_")) throw needKey(`${method} on ${net}`);
  if (!url) throw needKey(`RPC on ${net}`);
  const res = await rpcAt(url, method, params);
  if (res == null && method === "eth_getTransactionReceipt") { // pruned on the public node: ask an archive one
    for (const a of ARCHIVE_RPC[net] || []) {
      const r = await rpcAt(a, method, params).catch(() => null);
      if (r) return r;
    }
  }
  return res;
}

// getNFTsForOwner (Alchemy NFT API) for a few contracts: ERC721Enumerable reads on the public RPC, else the
// owner's Transfer logs + ownerOf -> { ownedNfts[] {contractAddress, tokenId}, totalCount }
const NFT_MAX = 100;
export async function keylessNfts(net, owner, contracts) {
  const url = publicRpc(net);
  if (!url) throw needKey(`NFTs on ${net}`);
  const call = (to, data) => rpcAt(url, "eth_call", [{ to, data }, "latest"]);
  const out = [];
  for (const c of contracts.filter(Boolean).map((x) => x.toLowerCase())) {
    const n = Number(word(await call(c, `0x70a08231${pad(owner).slice(2)}`)));
    if (!n) continue;
    const ids = await Promise.all(Array.from({ length: Math.min(n, NFT_MAX) }, (_, i) => call(c, `0x2f745c59${pad(owner).slice(2)}${i.toString(16).padStart(64, "0")}`).then((r) => word(r)).catch(() => null)));
    if (ids.every((x) => x != null)) { for (const id of ids) out.push({ contractAddress: c, tokenId: id.toString() }); continue; }
    // not enumerable (Uniswap v4 positions): what came in, then is still here; a network with no keyless logs keeps
    // the enumerable contracts' answer (this one is noted)
    const got = await logs(net, { address: c, topics: [TRANSFER, null, pad(owner)] }).catch((e) => { if (e.needs_key) return null; throw e; });
    if (!got) continue;
    const seen = [...new Set(got.filter((l) => l.topics.length === 4).map((l) => BigInt(l.topics[3])))].slice(-NFT_MAX * 2);
    const still = await Promise.all(seen.map((id) => call(c, `0x6352211e${id.toString(16).padStart(64, "0")}`).then((r) => `0x${r.slice(26)}`.toLowerCase() === owner.toLowerCase()).catch(() => false)));
    seen.forEach((id, i) => still[i] && out.push({ contractAddress: c, tokenId: id.toString() }));
  }
  return { ownedNfts: out, totalCount: out.length, pageKey: null };
}

// Alchemy Portfolio tokens/by-address for one address: native balance on the public RPC, ERC-20s from the explorer's
// token list (a network with none: native only, noted), DefiLlama prices (a thin market is no price)
export async function keylessTokens(net, address) {
  const url = publicRpc(net);
  if (!url) throw needKey(`token balances on ${net}`);
  const tokens = [{ network: net, address, tokenAddress: null, tokenBalance: hex(await rpcAt(url, "eth_getBalance", [address, "latest"])), tokenMetadata: {}, tokenPrices: [] }];
  const erc20 = BLOCKSCOUT[net] ? await tokenList(net, address) : (needKey(`ERC-20 balances on ${net}`), []);
  for (const t of erc20) tokens.push({ network: net, address, tokenAddress: t.contractAddress, tokenBalance: t.tokenBalance, tokenMetadata: { decimals: t.decimals, symbol: t.symbol, name: t.name }, tokenPrices: [] });
  const key = (t) => (t.tokenAddress ? `${LLAMA[net]}:${t.tokenAddress}` : nativeCoin(net));
  const px = await llamaPrices(tokens.filter((t) => t.tokenAddress == null || LLAMA[net]).map(key));
  for (const t of tokens) { const p = px.get(key(t).toLowerCase()); if (p) t.tokenPrices = [{ currency: "usd", value: String(p.price) }]; }
  return { data: { tokens } };
}
// DefiLlama current prices -> Map(lowercased key -> {price, decimals, symbol}); confidence under 0.9 = no price
export async function llamaPrices(keys) {
  const out = new Map(), uniq = [...new Set(keys.filter(Boolean))];
  for (let i = 0; i < uniq.length; i += 60) {
    const r = await http(`https://coins.llama.fi/prices/current/${uniq.slice(i, i + 60).join(",")}`).catch(() => null);
    for (const [k, v] of Object.entries(r?.body?.coins || {})) if (v.confidence == null || v.confidence >= 0.9) out.set(k.toLowerCase(), v);
  }
  return out;
}

// ---- compose routes (evm.keyless_*: the routes registry.mjs `keyless` sends an Alchemy call to) -------------------
const envelope = async (id, run) => {
  try { return { jsonrpc: "2.0", id, result: await run() }; } catch (e) { return { jsonrpc: "2.0", id, error: { code: -32000, message: String(e?.error || e?.message || e).slice(0, 300), ...(e?.needs_key && { data: { needs_key: e.needs_key } }) } }; }
};
const needNet = (p) => { if (!p.network) throw { status: 400, error: "missing required param(s)", detail: ["network"] }; return p.network; };
export const COMPOSE = {
  async keylessRpc(p, ctx) {
    const net = needNet(p), body = ctx.body ?? { jsonrpc: "2.0", id: 1, method: p.method, params: p.params ? String(p.params).split(",") : [] };
    if (!body?.method && !Array.isArray(body)) throw { status: 400, error: "missing required param(s)", detail: ["method"] };
    const one = (b) => envelope(b.id ?? 1, () => keylessRpc(net, b.method, b.params || []));
    return Array.isArray(body) ? Promise.all(body.map(one)) : one(body);
  },
  async keylessNfts(p) {
    const net = needNet(p);
    try { return await keylessNfts(net, p.owner, [p.v3, p.v4]); } catch (e) { throw { status: e.needs_key ? 424 : 502, error: e.error || e.message }; }
  },
  async keylessTokens(p) {
    const nets = String(p.networks || "eth-mainnet").split(",").map((s) => s.trim()).filter(Boolean);
    const out = await Promise.all(nets.map((n) => keylessTokens(n, p.address).catch((e) => { throw { status: e.needs_key ? 424 : 502, error: e.error || e.message }; })));
    return { data: { tokens: out.flatMap((o) => o.data.tokens) } };
  },
};
