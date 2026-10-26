// Shared helpers for core.mjs and bridges/*.mjs.
import { createPublicClient, http, custom, decodeEventLog, getAddress, parseAbi } from "viem";
import * as chains from "viem/chains";
import { publicActionsL1 } from "viem/op-stack";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";
import { keylessRpc, PUBLIC_RPC, alchemyOff, markAlchemyOff, notEnabled, errText } from "../keyless.mjs";

// Env is read at call time, so a server can set it after importing.
const alchemyKey = () => process.env.ALCHEMY_KEY || process.env.ALCHEMY_API_KEY;
const DAY = 86400;
const MIN = 60_000; // ms, for memo ttls
const now = () => Math.floor(Date.now() / 1000);

// ---------- rpc ----------

// No key: the network's public RPC, and Alchemy's methods through ../keyless.mjs (full-history logs and transfers
// from a keyless explorer where one answers; elsewhere the bridge throws a needs_key error and is listed as skipped)
const rpcUrl = (net) => (alchemyKey() ? `https://${net}.g.alchemy.com/v2/${alchemyKey()}` : PUBLIC_RPC[net] || `https://${net}.g.alchemy.com/v2/`);
const clients = new Map();
function client(chain, net) {
  const k = alchemyKey() ? net : `keyless:${net}`;
  if (!clients.has(k)) {
    clients.set(k, createPublicClient({ chain, transport: alchemyKey() ? offAware(net, http(rpcUrl(net), { retryCount: 5, retryDelay: 400, timeout: 60_000 })) : custom({ request: ({ method, params }) => keylessRpc(net, method, params) }, { retryCount: 0 }) }));
  }
  return clients.get(k);
}
// a network turned off in the Alchemy app (403 "... is not enabled for this app") goes keyless, like no key
function offAware(net, keyed) {
  return (args) => {
    const t = keyed(args);
    return { ...t, request: async (rq) => {
      if (alchemyOff(net)) return keylessRpc(net, rq.method, rq.params);
      try { return await t.request(rq); } catch (e) {
        if (!notEnabled(errText(e))) throw e;
        markAlchemyOff(net);
        return keylessRpc(net, rq.method, rq.params);
      }
    } };
  };
}
// the needs_key of an error (or of one it wraps: viem keeps the transport's error as cause)
const needsKeyOf = (e) => { for (let x = e, i = 0; x && i < 8; x = x.cause, i++) if (x.needs_key) return x; return null; };
const l1 = () => client(chains.mainnet, "eth-mainnet").extend(publicActionsL1());
// Chains Alchemy lacks, or caps at 10k-block log ranges with no Transfers API: their public RPC, one client per url.
function rpcClient(chain, url) {
  if (!clients.has(url)) clients.set(url, createPublicClient({ chain, transport: http(url, { retryCount: 3, retryDelay: 400, timeout: 30_000 }) }));
  return clients.get(url);
}

// Alchemy serves any block range when the result is <= 10k logs; split the range when it is not.
class RangeCapError extends Error {}
async function getLogsAll(c, params, from, to, { chunk = true } = {}) {
  try {
    return await c.getLogs({ ...params, fromBlock: from, toBlock: to });
  } catch (e) {
    const msg = `${e.details ?? ""} ${e.message ?? ""}`;
    // Some chains (Linea, zkSync, smaller OP Stack chains) cap the range at 10k blocks whatever the
    // result size: walk it in chunks, or let a per-address caller switch to the Transfers API.
    if (/up to a 10,?000 block range\. Based on your parameters, this block range should work/i.test(msg) && to - from >= 10_000n) {
      if (!chunk) throw new RangeCapError(msg);
      const chunks = [];
      for (let b = from; b <= to; b += 10_000n) chunks.push([b, b + 9_999n > to ? to : b + 9_999n]);
      return (await pool(chunks, 8, ([a, z]) => getLogsAll(c, params, a, z))).flat();
    }
    if (to <= from || !/exceed|range|limit|too many|10,?000/i.test(msg)) throw e;
    const mid = (from + to) / 2n;
    return [...(await getLogsAll(c, params, from, mid)), ...(await getLogsAll(c, params, mid + 1n, to))];
  }
}

// Per-address lookups on chains with the hard range cap: find candidate txs with the Transfers API.
async function transferTxs(c, user, to, category) {
  const out = [];
  let pageKey;
  do {
    const r = await c.request({ method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", fromAddress: user, toAddress: to, category, withMetadata: true, maxCount: "0x3e8", ...(pageKey ? { pageKey } : {}) }] });
    out.push(...r.transfers);
    pageKey = r.pageKey;
  } while (pageKey);
  return out;
}

async function logsFromTxs(c, hashes, wanted) {
  const logs = await pool([...new Set(hashes)], 6, async (hash) => (await c.getTransactionReceipt({ hash })).logs);
  return logs.flat().flatMap((l) => {
    for (const { address, event } of wanted) {
      if (address && l.address.toLowerCase() !== address.toLowerCase()) continue;
      try { return [{ ...l, eventName: event.name, args: decodeEventLog({ abi: [event], data: l.data, topics: l.topics }).args }]; } catch {}
    }
    return [];
  });
}

// Block times never change: keep them, but retry the ones that failed.
const blockTime = memo((c, net, block) => c.getBlock({ blockNumber: block }).then((b) => Number(b.timestamp)), Infinity, (c, net, block) => `${net}:${block}`);

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const j = i++; out[j] = await fn(items[j], j); }
  }));
  return out;
}

// ---------- caches ----------

// Shared async result per key: one in-flight promise, kept for ttl ms after it settles, dropped on
// failure so the next call retries. The CLI exits long before any ttl; a long-lived server needs it
// or indexes, finalized blocks and API answers would never refresh.
function memo(fn, ttl = Infinity, keyOf = (...args) => args.join(":")) {
  const m = new Map();
  return (...args) => {
    const k = keyOf(...args), t = Date.now(), hit = m.get(k);
    if (hit && (hit.at == null || t - hit.at < ttl)) return hit.p;
    if (ttl < Infinity) for (const [x, e] of m) if (e.at != null && t - e.at >= ttl) m.delete(x);
    const e = { p: fn(...args), at: null };
    e.p.then(() => { e.at = Date.now(); }, () => { if (m.get(k) === e) m.delete(k); });
    m.set(k, e);
    return e.p;
  };
}

// On-disk indexes: STUCK_CACHE_DIR when set (e.g. a mounted volume), else .cache/ next to this file.
const cachePath = (name) => join(process.env.STUCK_CACHE_DIR || fileURLToPath(new URL("./.cache/", import.meta.url)), name);
function saveJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.${process.pid}.tmp`, JSON.stringify(obj));
  renameSync(`${path}.${process.pid}.tmp`, path);
}

// Partial failures inside a bridge (one chain of many, a capped list): collected per call when
// runBridge set up a context with an errors list, else printed like the CLI always did.
const ctx = new AsyncLocalStorage();
// err: the error behind msg; one that needs a key (needsKeyOf) is listed as a skipped part, not a failure, and is not
// printed outside a call either (an index warm-up rethrows it, so the scan lists it under the key it needs)
function warn(msg, err) {
  const c = ctx.getStore(), nk = err && needsKeyOf(err);
  if (c?.errors) c.errors.push({ bridge: c.bridge, error: nk ? nk.message : msg, ...(nk && { needs_key: nk.needs_key, why: nk.why }) });
  else if (!nk) console.error(`! ${msg}`);
}

const revertText = (e) => `${e.shortMessage ?? ""} ${e.details ?? ""} ${e.message ?? ""}`;

// ---------- result model ----------
// status: claimable | ready-to-prove | ready-to-finalize | blocked | waiting | claimed | unknown
const STUCK = new Set(["claimable", "ready-to-prove", "ready-to-finalize"]);
const SHOWN = new Set([...STUCK, "blocked"]); // blocked = stuck, but only the bridge team can release it
const ETH = { kind: "native", symbol: "ETH", decimals: 18 };
const erc20 = (network, address) => ({ kind: "erc20", network, address: getAddress(address) });

async function fetchJson(url, tries = 2) {
  for (let i = 0; ; i++) {
    try { return await fetch(url, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()); }
    catch { if (i + 1 >= tries) return null; }
  }
}

// ---------- OP Stack portals on an L2OutputOracle (Mantle, Manta Pacific) ----------
// Portals from before dispute games check a proof against the oracle's output at l2OutputIndex (OptimismPortal
// finalizeWithdrawalTransaction: proven, proof not older than startingTimestamp, same output root, both the proof and
// the output past FINALIZATION_PERIOD_SECONDS). Viem reads these too, but not Mantle's (its withdrawal hash adds
// mntValue + ethValue), so both chains share this reader.
const l2ooAbi = parseAbi([
  "function finalizedWithdrawals(bytes32) view returns (bool)",
  "function provenWithdrawals(bytes32) view returns (bytes32 outputRoot, uint128 timestamp, uint128 l2OutputIndex)",
  "function paused() view returns (bool)",
  "function latestBlockNumber() view returns (uint256)",
  "function startingTimestamp() view returns (uint256)",
  "function FINALIZATION_PERIOD_SECONDS() view returns (uint256)",
  "function getL2Output(uint256) view returns ((bytes32 outputRoot, uint128 timestamp, uint128 l2BlockNumber))",
]);
// c: the L1 client, Ethereum by default (opBNB passes its BNB Chain client)
const l2ooRead = (address, functionName, args = [], c = l1()) => c.readContract({ address, abi: l2ooAbi, functionName, args });
// the oracle's newest L2 block, its start and finalization period, the portal's pause flag: read every 10 min
const l2ooSettings = memo(async (portal, oracle, c) => {
  const [latest, start, period, paused] = await Promise.all([
    l2ooRead(oracle, "latestBlockNumber", [], c), l2ooRead(oracle, "startingTimestamp", [], c), l2ooRead(oracle, "FINALIZATION_PERIOD_SECONDS", [], c), l2ooRead(portal, "paused", [], c).catch(() => false),
  ]);
  return { latest, start: Number(start), period: Number(period), paused };
}, 10 * MIN, (portal, oracle) => `${portal}:${oracle}`);
// one withdrawal's portal facts: { finalized, provenAt, provenRoot, output: { root, timestamp } | null (index gone) }
async function l2ooFacts(portal, oracle, hash, c) {
  if (await l2ooRead(portal, "finalizedWithdrawals", [hash], c)) return { finalized: true };
  const [provenRoot, provenAt, index] = await l2ooRead(portal, "provenWithdrawals", [hash], c);
  if (!provenAt) return { finalized: false, provenAt: 0 };
  const out = await l2ooRead(oracle, "getL2Output", [index], c).catch(() => null);
  return { finalized: false, provenAt: Number(provenAt), provenRoot, output: out && { root: out.outputRoot, timestamp: Number(out.timestamp) } };
}
// facts + settings -> { status, detail } (pure, for the tests); block: the withdrawal's L2 block, t: now in seconds
function classifyL2oo(f, s, block, t) {
  const day = (x) => new Date(x * 1000).toISOString().slice(0, 10);
  if (f.finalized) return { status: "claimed" };
  if (s.paused) return { status: "blocked", detail: "the bridge portal on Ethereum is paused" };
  if (!f.provenAt) return s.latest >= BigInt(block) ? { status: "ready-to-prove", detail: "not proven on Ethereum" } : { status: "waiting", detail: "waiting for the next state output on Ethereum" };
  // a proof against an output that was deleted or replaced, or from before the oracle's restart, has to be redone
  if (f.provenAt < s.start || !f.output || f.output.root !== f.provenRoot) return { status: "ready-to-prove", detail: `proven ${day(f.provenAt)} against an output the portal no longer accepts: prove again` };
  const at = Math.max(f.provenAt, f.output.timestamp) + s.period;
  return t > at ? { status: "ready-to-finalize", detail: `proven ${day(f.provenAt)}` } : { status: "waiting", detail: `proven ${day(f.provenAt)}; finalizes from about ${day(at)}` };
}

export {
  alchemyKey, needsKeyOf, DAY, MIN, now, rpcUrl, clients, client, rpcClient, l1, l2ooSettings, l2ooFacts, classifyL2oo, RangeCapError, getLogsAll, transferTxs, logsFromTxs, blockTime, pool, memo, cachePath, saveJson, ctx, warn,
  revertText, STUCK, SHOWN, ETH, erc20, fetchJson,
};
