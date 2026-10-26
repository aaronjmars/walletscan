// index.mjs - airdrop eligibility index as a library: which open-source airdrop lists (rotki/data,
// lissstern/airdrop-db) a wallet is on, whether each hit is claimed, unclaimed or expired (read onchain), plus
// airdropped tokens that vested in a contract the wallet owns and were never withdrawn.
//
//   import { checkWallet, warm, lookup } from "./airdrops/index.mjs";
//   await warm();                                   // download + index the lists; cheap when they did not change
//   const { items, errors } = await checkWallet("0x...");
//
// Env: ALCHEMY_API_KEY or ALCHEMY_KEY (checkWallet; without it public RPCs + keyless explorers, ../keyless.mjs),
// AIRDROP_CACHE_DIR (index dir; default: "airdrops" next to STUCK_CACHE_DIR, else airdrops/.cache/). Thrown errors are plain { status, error, detail }, like stuck/.
// Index files (format in build.mjs) are read with one pread per list per lookup: only their bucket tables
// (16 KB a list) stay in memory.

import { openSync, readSync, closeSync, mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { META, ROTKI, LISS, LISS_LISTS, EXTRA_LISTS, VESTING, NETS, SABLIER } from "./lists.mjs";
import { FORMAT, REC, NB, HEAD, pre } from "./build.mjs";
import { keylessRpc, alchemyOff, markAlchemyOff, notEnabled } from "../keyless.mjs";

const HEX = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const DAY_MS = 86_400_000;
const alchemyKey = () => process.env.ALCHEMY_KEY || process.env.ALCHEMY_API_KEY;
const iso = (t) => (t ? new Date(t * 1000).toISOString().slice(0, 10) : null);
const msg = (e) => String(e?.shortMessage || e?.message || e).split("\n")[0].slice(0, 200);
const pad = (a) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
const word = (hex, i) => BigInt("0x" + (String(hex || "0x").slice(2 + i * 64, 2 + (i + 1) * 64) || "0"));

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); }
  }));
  return out;
}

// "airdrops" next to the stuck indexes (STUCK_CACHE_DIR), else airdrops/.cache/
export function cacheDir() {
  if (process.env.AIRDROP_CACHE_DIR) return process.env.AIRDROP_CACHE_DIR;
  if (process.env.STUCK_CACHE_DIR) { const s = resolve(process.env.STUCK_CACHE_DIR), up = dirname(s); return up === s || up === "/" ? join(s, "airdrops") : join(up, "airdrops"); }
  return fileURLToPath(new URL("./.cache/", import.meta.url));
}

// ---- list specs -------------------------------------------------------------------------------------------------
// { id, source, name, url, hash, chainId, chain, token, symbol, raw, amountCol, format, share, from, until, closed, open, vesting, cumulative, funds, campaign, link, note }
//   cumulative  amounts are cumulative: claimed = getClaimed(wallet) on this contract, the claim pays the rest
//   funds       the contract the claim pays out of (balance checked), when it is not from[0]
//   campaign    Sablier campaign id: claimed = a Claim action in Sablier's indexer
const pick = ({ symbol, raw, share, from, until, closed, open, vesting, note, amountCol, format, cumulative, funds, campaign }) => ({ symbol, raw, share, from, until, closed, open, vesting, note, amountCol, format, cumulative, funds, campaign });
const spec = (id, source, l, url, link) => ({ id, source, name: l.name, url, hash: l.hash, chainId: l.chainId, chain: NETS[l.chainId]?.name ?? null, token: l.token, link, ...pick(l) });
const staticLists = () => [
  ...Object.entries(LISS_LISTS).map(([id, l]) => spec(id, "lissstern", l, LISS + l.file, l.url)),
  ...Object.entries(EXTRA_LISTS).map(([id, l]) => spec(id, l.source || l.link.replace("https://github.com/", ""), l, l.url, l.link)),
];
async function sablierQuery(query, variables) {
  const r = await fetch(SABLIER.indexer, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`Sablier indexer HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(`Sablier indexer: ${j.errors[0]?.message}`);
  return j.data;
}
// open Sablier campaigns with real claims, on a chain we can price
async function sablierLists() {
  const d = await sablierQuery(`query($now: numeric!, $min: numeric!) { Campaign(where: {clawbackAction_id: {_is_null: true}, claimedCount: {_gt: $min}, ipfsCID: {_is_null: false}, _or: [{expires: {_eq: false}}, {expiration: {_gt: $now}}]}, limit: 1000) { id chainId name nickname category ipfsCID expiration expires asset { address symbol decimals } } }`, { now: String(Math.floor(Date.now() / 1000)), min: String(SABLIER.minClaims) });
  return (d.Campaign || []).filter((c) => c.ipfsCID && NETS[Number(c.chainId)] && !SABLIER.testnets.includes(Number(c.chainId)) && !/\btest/i.test(`${c.name} ${c.nickname}`)).map((c) => {
    const chainId = Number(c.chainId), lockup = /^Lockup/.test(c.category || "");
    return {
      id: `sablier_${chainId}_${c.id.split("-")[0].toLowerCase()}`, source: "sablier", name: `${(c.name || "").trim() || c.asset?.symbol} (Sablier campaign)`, url: SABLIER.ipfs + c.ipfsCID, hash: c.ipfsCID,
      chainId, chain: NETS[chainId].name, token: c.asset?.address?.toLowerCase() ?? null, symbol: c.asset?.symbol ?? null, raw: Number(c.asset?.decimals ?? 18), format: "tree",
      until: c.expires && Number(c.expiration) > 0 ? Number(c.expiration) : null, campaign: c.id, link: SABLIER.app(c.id),
      note: lockup ? "claiming starts a Sablier stream that vests over time" : "claim on the Sablier app",
    };
  });
}
async function rotkiLists() {
  const lists = [];
  const r = await fetch(ROTKI + "airdrops/index_v4.json", { signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  for (const [id, a] of Object.entries((await r.json()).airdrops || {})) {
    const m = META[id] || {}, [, cid, token] = /^eip155:(\d+)\/erc20:(0x[0-9a-fA-F]{40})$/.exec(a.asset_identifier || "") || [];
    if (m.skip) continue;
    const chainId = cid ? Number(cid) : null;
    lists.push({
      id, source: "rotki", name: a.name || id, url: ROTKI + a.file_path, hash: a.file_hash, chainId, chain: m.chain || NETS[chainId]?.name || null, token: token?.toLowerCase() ?? null,
      link: a.url || null, ...pick(m), until: m.open ? null : m.until ?? a.cutoff_time ?? null, symbol: m.symbol || null,
    });
  }
  return lists;
}

// ---- build: in a child process, so the scan process never keeps the build's memory -----------------------------
function buildInChild(jobs) {
  return new Promise((ok, no) => {
    const p = spawn(process.execPath, [fileURLToPath(new URL("./build.mjs", import.meta.url)), JSON.stringify(jobs)], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", no);
    p.on("close", (code) => {
      try { ok(JSON.parse(out)); } catch { no(new Error(`build exited ${code}: ${err.trim().split("\n").pop() || "no output"}`.slice(0, 200))); }
    });
  });
}

// ---- the index in this process ----------------------------------------------------------------------------------
// INDEX: { dir, lists: Map(id -> spec), at (ms), built (ISO) }; readers: id -> { fd, table }
let INDEX = null, warming = null;
const readers = new Map();
const fileOf = (dir, id) => join(dir, `${id}.idx`);
function dropReader(id) { const r = readers.get(id); if (r) { try { closeSync(r.fd); } catch {} readers.delete(id); } }
function reader(dir, id) {
  let r = readers.get(id);
  if (r) return r;
  const fd = openSync(fileOf(dir, id), "r"), head = Buffer.alloc(HEAD);
  readSync(fd, head, 0, HEAD, 0);
  if (head.toString("latin1", 0, 4) !== "ADX1" || head.readUInt32LE(8) !== NB) { closeSync(fd); throw new Error(`${id}: not an index file`); }
  r = { fd, table: new Uint32Array(head.buffer.slice(head.byteOffset + 16, head.byteOffset + HEAD)) };
  readers.set(id, r);
  return r;
}
// one bucket read, then a binary search in it
function find(r, key) {
  const p = pre(key, 0), s = r.table[p], e = r.table[p + 1];
  if (e === s) return null;
  const b = Buffer.allocUnsafe((e - s) * REC);
  readSync(r.fd, b, 0, b.length, HEAD + s * REC);
  for (let lo = 0, hi = e - s - 1; lo <= hi;) {
    const mid = (lo + hi) >> 1, c = b.compare(key, 0, 20, mid * REC, mid * REC + 20);
    if (c === 0) { const v = b.readDoubleLE(mid * REC + 20); return { amount: Number.isNaN(v) ? null : v }; }
    if (c < 0) lo = mid + 1; else hi = mid - 1;
  }
  return null;
}

const readManifest = (dir) => { try { return JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")); } catch { return {}; } };

// Download and index every list that changed (rotki gives a sha256 per file; lissstern is pinned). Up to date:
// one small request. Failures land in errors and the last good file stays in use. opts.lists replaces the
// sources (tests); opts.dir the cache dir.
// -> { lists, built[], kept, records, disk_mb, errors[], ms {id: build ms}, total_ms }
export async function warm(opts = {}) {
  if (!warming) warming = doWarm(opts).finally(() => { warming = null; });
  return warming;
}
async function doWarm({ dir = cacheDir(), lists } = {}) {
  const t0 = Date.now(), errors = [], ms = {}, built = [];
  mkdirSync(dir, { recursive: true });
  const man = readManifest(dir);
  if (!lists) { // rotki index or Sablier indexer down: keep their lists of the last good run
    const last = (src) => (man.lists || []).filter((l) => l.source === src);
    const [rotki, sablier] = await Promise.all([
      rotkiLists().catch((e) => { errors.push({ list: "rotki index", error: msg(e) }); return last("rotki"); }),
      sablierLists().catch((e) => { errors.push({ list: "sablier index", error: msg(e) }); return last("sablier"); }),
    ]);
    lists = [...staticLists(), ...rotki, ...sablier];
  }
  const done = man.format === FORMAT ? { ...man.built } : {};
  const jobs = lists.filter((l) => !(done[l.id]?.hash === l.hash && existsSync(fileOf(dir, l.id)))).map((l) => ({ list: l, file: fileOf(dir, l.id) }));
  if (jobs.length) {
    const res = await buildInChild(jobs).catch((e) => Object.fromEntries(jobs.map((j) => [j.list.id, { error: msg(e) }])));
    for (const { list: l } of jobs) {
      const r = res[l.id] || { error: "no result" };
      ms[l.id] = r.ms;
      if (r.error) { errors.push({ list: l.id, error: r.error }); continue; }
      dropReader(l.id);
      done[l.id] = { hash: l.hash, count: r.count, bytes: r.bytes, at: new Date().toISOString() };
      built.push(l.id);
    }
  }
  const usable = lists.filter((l) => done[l.id] && existsSync(fileOf(dir, l.id)));
  writeFileSync(join(dir, `manifest.json.${process.pid}.tmp`), JSON.stringify({ format: FORMAT, built: done, lists }));
  renameSync(join(dir, `manifest.json.${process.pid}.tmp`), join(dir, "manifest.json"));
  INDEX = { dir, lists: new Map(usable.map((l) => [l.id, l])), at: Date.now(), built: new Date().toISOString() };
  const sum = (k) => usable.reduce((t, l) => t + (done[l.id][k] || 0), 0);
  return { lists: usable.length, built, kept: usable.length - built.length, records: sum("count"), disk_mb: Math.round(sum("bytes") / 1e5) / 10, errors, ms, total_ms: Date.now() - t0 };
}

// The index this process uses: warm once, then refresh in the background once a day.
async function ready(errors) {
  if (!INDEX) { const w = await warm(); errors.push(...w.errors); }
  else if (Date.now() - INDEX.at > DAY_MS && !warming) warm().catch(() => {});
  if (!INDEX?.lists.size) throw { status: 503, error: "airdrop index not built yet", detail: errors };
}

// Lists the address is on, from the files only (no network): [{ ...spec, amount }]
export function lookup(address) {
  if (!INDEX) return [];
  const key = Buffer.from(address.slice(2).toLowerCase(), "hex"), out = [];
  for (const l of INDEX.lists.values()) {
    try { const h = find(reader(INDEX.dir, l.id), key); if (h) out.push({ ...l, amount: h.amount }); } catch {}
  }
  return out;
}

// ---- onchain reads ----------------------------------------------------------------------------------------------
// no key: public RPC reads and keyless explorer logs / transfers (../keyless.mjs); a chain with no keyless log source
// leaves those hits unknown and noted in the scan's skipped_for_keys
async function alchemyRpc(chainId, method, params) {
  const net = NETS[chainId]?.net;
  if (!net) throw new Error(`no RPC for chain ${chainId}`);
  if (!alchemyKey() || alchemyOff(net)) return keylessRpc(net, method, params);
  for (let i = 0; ; i++) {
    const r = await fetch(`https://${net}.g.alchemy.com/v2/${alchemyKey()}`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000),
    });
    if ((r.status === 429 || r.status >= 500) && i < 3) { await new Promise((ok) => setTimeout(ok, 600 * 2 ** i)); continue; }
    const j = await r.json().catch(() => ({ error: { message: `HTTP ${r.status}` } }));
    if (j.error && notEnabled(j.error.message)) { markAlchemyOff(net); return keylessRpc(net, method, params); } // network off in the app
    if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
    return j.result;
  }
}
const SEL = { getClaimed: "0xeb46260e", balanceOf: "0x70a08231", decimals: "0x313ce567", calc: "0xd7faa145", vestings: "0x9fb0c41d", initialLocked: "0x50b3aad4", swappable: "0x0ca9279c" };
const TOPIC = {
  added2: "0xff2781f5af6cf115d187dd0e4ef590f5d1288b83ef3eb6739c69db99e70c8b4d", // AddedVesting(bytes32 indexed id, address indexed account)
  added1: "0xdc17a56285031761fb7a86d90a31227531205e1e9e8f85f4d0f03a54ea5fb976", // AddedVesting(bytes32 indexed id)
  redeemed: "0x7cd091e2ff3f9fb5d2af5b8ff0f594b6963db44e143fd471a132b649535f1236", // RedeemedVesting(bytes32 indexed id, address indexed user)
};
const call = (rpc, chainId, to, data) => rpc(chainId, "eth_call", [{ to, data }, "latest"]);

// first transfer of the list's token from a claim contract to the wallet = the claim
async function claimTx(rpc, h, wallet) {
  for (const from of h.from) {
    const r = await rpc(h.chainId, "alchemy_getAssetTransfers", [{ fromBlock: "0x0", toBlock: "latest", fromAddress: from, toAddress: wallet, contractAddresses: [h.token], category: ["erc20"], order: "asc", maxCount: "0x1", withMetadata: true }]);
    if (r?.transfers?.length) return r.transfers[0];
  }
  return null;
}

// the wallet's vestings in one VESTING entry: [{ contract, id, vested, claimed, left, total, end, cancelled }] (raw units)
async function vestingsOf(rpc, v, wallet) {
  const out = [];
  if (v.kind === "escrow") {
    for (const c of v.contracts) {
      const [bal, init] = await Promise.all([call(rpc, v.chainId, c, SEL.balanceOf + pad(wallet).slice(2)), call(rpc, v.chainId, c, SEL.initialLocked + pad(wallet).slice(2))]);
      const total = word(init, 0), left = word(bal, 0);
      if (total > 0n) out.push({ contract: c, id: null, vested: null, claimed: null, left, total, end: null, cancelled: false });
    }
    return out;
  }
  if (v.kind === "vcow") {
    for (const c of v.contracts) {
      const [bal, swap] = await Promise.all([call(rpc, v.chainId, c, SEL.balanceOf + pad(wallet).slice(2)), call(rpc, v.chainId, c, SEL.swappable + pad(wallet).slice(2))]);
      const total = word(bal, 0), left = word(swap, 0);
      if (total > 0n) out.push({ contract: c, id: null, vested: left, claimed: null, left, total, end: null, cancelled: false });
    }
    return out;
  }
  for (const c of v.contracts) {
    const logs = await rpc(v.chainId, "eth_getLogs", [{ address: c, fromBlock: "0x0", toBlock: "latest", topics: [v.kind === "safe" ? TOPIC.added2 : TOPIC.redeemed, null, pad(wallet)] }]);
    for (const log of logs || []) {
      const id = log.topics[1];
      let at = c;
      if (v.kind === "shutter") { // the vesting lives in the per-user pool made in the same tx
        const rc = await rpc(v.chainId, "eth_getTransactionReceipt", [log.transactionHash]);
        at = rc?.logs?.find((l) => l.topics[0] === TOPIC.added1 && l.topics[1] === id)?.address;
        if (!at) continue;
      }
      const [calc, st] = await Promise.all([call(rpc, v.chainId, at, SEL.calc + id.slice(2)), call(rpc, v.chainId, at, SEL.vestings + id.slice(2))]);
      // Vesting struct, the same in Safe and Shutter pools from word 3: durationWeeks, startDate, amount, amountClaimed, pausingDate, cancelled
      const vested = word(calc, 0), claimed = word(calc, 1), weeks = word(st, 3), start = word(st, 4);
      out.push({ contract: at, id, vested, claimed, left: vested - claimed, total: word(st, 5), end: Number(start + weeks * 604800n), cancelled: word(st, 8) !== 0n });
    }
  }
  return out;
}

async function prices(items, errors) {
  const keys = [...new Set(items.map((i) => i._price).filter(Boolean))];
  if (!keys.length) return new Map();
  try {
    const r = await fetch(`https://coins.llama.fi/prices/current/${keys.join(",")}`, { signal: AbortSignal.timeout(15_000) }).then((x) => x.json());
    return new Map(Object.entries(r.coins || {}).map(([k, v]) => [k.toLowerCase(), v]));
  } catch (e) { errors.push({ list: "prices", error: msg(e) }); return new Map(); }
}

// ---- one wallet -------------------------------------------------------------------------------------------------
// items: one per list hit { kind: "airdrop", id, source, name, chain, token, symbol, amount, status, deadline,
//   claim_url, claimed_tx, claimed_at, distributor, usd, detail } plus one per vesting found { kind: "vesting",
//   ..., contract, vesting_id, vested, claimed, total, vesting_end }
// status: unclaimed (onchain read says not claimed and the window is open) | claimed | expired | unknown
// opts (tests): rpc(chainId, method, params), sablierQuery(query, variables), fetchPrices(items) -> Map("chain:token" -> { price, confidence }), now (unix s)
export async function checkWallet(address, opts = {}) {
  if (typeof address !== "string" || !HEX.test(address)) throw { status: 400, error: "invalid address", detail: address };
  const errors = [], rpc = opts.rpc || alchemyRpc, sq = opts.sablierQuery || sablierQuery, now = opts.now ?? Date.now() / 1000, wallet = address.toLowerCase();
  await ready(errors);
  const hits = lookup(wallet);

  const vest = new Map(), vitems = [];
  await Promise.all(Object.entries(VESTING).map(async ([k, v]) => {
    try {
      const found = await vestingsOf(rpc, v, wallet);
      vest.set(k, found);
      const units = (x) => (x == null ? null : Number(x) / 10 ** v.decimals);
      for (const f of found) vitems.push({
        kind: "vesting", id: `${k}_vesting`, source: "onchain", name: v.name, action: v.kind === "vcow" ? `swap your vCOW to COW (${v.how})` : `withdraw the vested ${v.symbol} from your ${v.name.replace(/ vesting$/, "")} vesting`, chain: NETS[v.chainId].name, token: v.token, symbol: v.symbol, amount: units(f.left),
        status: f.left > 0n ? "unclaimed" : "claimed", deadline: null, claim_url: v.url, contract: f.contract, vesting_id: f.id,
        vested: units(f.vested), claimed: units(f.claimed), total: units(f.total), vesting_end: f.end ? iso(f.end) : null,
        detail: `${v.how}${f.cancelled ? "; the vesting was cancelled, only the vested part is left" : ""}`, _price: `${NETS[v.chainId].llama}:${v.price || v.token}`,
      });
    } catch (e) { errors.push({ list: `${k} vesting`, error: msg(e) }); }
  }));

  // Sablier hits: one indexer query for the wallet's claims (and a fresh clawback check) across all of them
  const sab = hits.filter((h) => h.campaign);
  let sabClaims = null, sabGone = new Set();
  if (sab.length) {
    try {
      const d = await sq(`query($w: String!, $ids: [String!]!) { Action(where: {category: {_eq: "Claim"}, claimRecipient: {_eq: $w}, campaign_id: {_in: $ids}}) { campaign_id hash timestamp } Campaign(where: {id: {_in: $ids}, clawbackAction_id: {_is_null: false}}) { id } }`, { w: wallet, ids: sab.map((h) => h.campaign) });
      sabClaims = new Map((d.Action || []).map((a) => [a.campaign_id, a]));
      sabGone = new Set((d.Campaign || []).map((c) => c.id));
    } catch (e) { errors.push({ list: "sablier claims", error: msg(e) }); }
  }

  const items = await pool(hits, 6, async (h) => {
    const it = {
      kind: "airdrop", id: h.id, source: h.source, name: h.name, chain: h.chain, token: h.token, symbol: h.symbol, amount: h.amount, status: "unknown",
      deadline: iso(h.until), claim_url: h.link, detail: h.note || null, ...(h.token && NETS[h.chainId] && { _price: `${NETS[h.chainId].llama}:${h.token}` }),
    };
    const over = !!h.closed || (h.until != null && now > h.until);
    if (h.vesting) { // the claim went into a vesting contract: claimed = we found that vesting
      const v = vest.get(h.vesting);
      if (v?.length) return { ...it, status: "claimed", detail: `claimed into a vesting contract (${v.map((x) => x.contract).join(", ")}): see the ${h.vesting}_vesting item` };
      return { ...it, status: v && over ? "expired" : "unknown" };
    }
    if (h.campaign) {
      if (!sabClaims) return { ...it, status: over ? "expired" : "unknown" };
      const c = sabClaims.get(h.campaign);
      if (c) return { ...it, status: "claimed", claimed_tx: c.hash, claimed_at: c.timestamp ? iso(Number(c.timestamp)) : null };
      if (over || sabGone.has(h.campaign)) return { ...it, status: "expired", ...(sabGone.has(h.campaign) && { detail: "the campaign was clawed back" }) };
      return { ...it, status: "unclaimed", distributor: h.campaign.split("-")[0], _needsPrice: true };
    }
    if (h.cumulative) { // amounts are cumulative: the claim pays what getClaimed says is not paid yet
      try {
        const [got, bal] = await Promise.all([call(rpc, h.chainId, h.cumulative, SEL.getClaimed + pad(wallet).slice(2)), call(rpc, h.chainId, h.token, SEL.balanceOf + pad(h.funds || h.cumulative).slice(2))]);
        const done = Number(word(got, 0)) / 10 ** (h.raw ?? 18), left = (h.amount ?? 0) - done, funded = Number(word(bal, 0)) / 10 ** (h.raw ?? 18);
        if (left <= (h.amount ?? 0) * 1e-9) return { ...it, status: "claimed", detail: [it.detail, `${done} claimed (getClaimed)`].filter(Boolean).join("; ") };
        if (funded < left) return { ...it, status: "expired", amount: left, detail: `the rewards treasury ${h.funds} no longer holds enough ${h.symbol}` };
        return { ...it, status: "unclaimed", amount: left, distributor: h.cumulative, detail: [it.detail, done > 0 && `${done} of ${h.amount} already claimed`].filter(Boolean).join("; ") };
      } catch (e) {
        errors.push({ list: h.id, error: msg(e) });
        return { ...it, status: "unknown" };
      }
    }
    if (!h.from?.length || !NETS[h.chainId]?.net || !h.token) return { ...it, status: over ? "expired" : "unknown" };
    try {
      const t = await claimTx(rpc, h, wallet);
      if (t) return { ...it, status: "claimed", claimed_tx: t.hash, claimed_at: t.metadata?.blockTimestamp ?? null, distributor: t.from };
      if (over) return { ...it, status: "expired" };
      // no end date known: a claim only works while the contract still holds enough tokens
      const d = h.from[0];
      if (d !== ZERO) {
        const [bal, dec] = await Promise.all([call(rpc, h.chainId, h.token, SEL.balanceOf + pad(d).slice(2)), call(rpc, h.chainId, h.token, SEL.decimals)]);
        const left = Number(word(bal, 0)) / 10 ** Number(word(dec, 0) || 18n);
        if (left < (h.amount ?? 1e-9)) return { ...it, status: "expired", detail: `the claim contract ${d} no longer holds enough ${h.symbol || "tokens"} (${left})` };
      }
      return { ...it, status: "unclaimed", distributor: d };
    } catch (e) {
      errors.push({ list: h.id, error: msg(e) });
      return { ...it, status: over ? "expired" : "unknown" };
    }
  });

  const all = [...items, ...vitems], open = all.filter((i) => i.status === "unclaimed" && i.amount != null);
  const px = await (opts.fetchPrices || ((xs) => prices(xs, errors)))(open);
  for (const i of all) {
    const p = i.status === "unclaimed" && i._price ? px.get(i._price.toLowerCase()) : null;
    i.usd = p?.price != null && i.amount != null ? Math.round(i.amount * p.price * 100) / 100 : null;
    if (p?.confidence != null && p.confidence < 0.9) i.detail = [i.detail, `thin market (DefiLlama price confidence ${p.confidence})`].filter(Boolean).join("; ");
    // a Sablier campaign anyone can make: no market price = likely a presale or test token, so only a hint
    if (i._needsPrice && i.usd == null) { i.status = "unknown"; i.detail = [i.detail, "no market price for this token"].filter(Boolean).join("; "); }
    delete i._price; delete i._needsPrice;
  }
  return { items: all, errors, lists_checked: INDEX.lists.size, index_built: INDEX.built };
}

// what this process holds (for health checks and the README numbers)
export const status = () => ({ ready: !!INDEX, building: !!warming, lists: INDEX?.lists.size ?? 0, built: INDEX?.built ?? null, dir: INDEX?.dir ?? cacheDir(), open_files: readers.size });

// tests: forget the in-process index (files stay)
export function reset() { for (const id of [...readers.keys()]) dropReader(id); INDEX = null; }
