// Ronin Bridge. Since June 2022 every withdrawal is a receipt on the RoninGatewayV3 proxy, claimed on Ethereum
// with operator signatures. Ronin moved to Chainlink CCIP in 2025: no new requests since ~block 45.7M and
// operators ignore requestWithdrawalSignatures, but MainchainGatewayV3 still pays already-signed receipts.
// Pre-hack withdrawals (legacy gateway, ids 1..1064498) never claimed on the old, now paused, Ethereum gateway
// were migrated into the new gateway in legacy id order as ids 0..108946, so they are checked the same way.
// Both sets are indexed on disk, see cachePath (legacy once, it is frozen; V3 synced from the last indexed block).
import { parseAbi, parseSignature, getAddress, toHex } from "viem";
import * as chains from "viem/chains";
import { readFileSync } from "node:fs";
import { MIN, client, l1, transferTxs, blockTime, memo, cachePath, saveJson, revertText, pool, ETH, erc20 } from "../lib.mjs";
import { logsCapped, needKey, ALCHEMY_PAID } from "../../keyless.mjs";
// both indexes are built from 10k-block log windows: an Alchemy Free plan key (10 blocks) cannot build them
const paidOnly = () => { if (logsCapped()) throw needKey("withdrawal index (full-history logs)", ALCHEMY_PAID); };

const RONIN = { chain: chains.ronin, net: "ronin-mainnet" };
const GW = "0x0CF8fF40a508bdBc39fBe1Bb679dCBa64E65C7Df"; // RoninGatewayV3 proxy
const MGW = "0x64192819Ac13Ef72bF6b5AE239AC672B43a9AF08"; // MainchainGatewayV3 proxy
const MBM = "0x2Cf3CFb17774Ce0CFa34bB3f3761904e7fc3FaDB"; // MainchainBridgeManager (MGW.getContract(11))
const OLD_GW = "0xE35D62EbE18413d96ca2A2F7CF215BB21A406B4B"; // legacy SidechainGatewayManager (implementation now 0xdEaD)
const OLD_MGW = "0x1A2a1c938CE3eC39b6D47113c7955bAa9DD454F2"; // legacy MainchainGatewayManager (paused)
const OLD_END = 13_100_000n; // last legacy TokenWithdrew is at Ronin block 13072714 (id 1064498)
const OLD_MAX = 1_064_498;
const MIGRATED = 108_947; // RoninGatewayV3 ids 0..108946
const V3_START = 14_930_000n; // RoninGatewayV3 went live at Ronin block ~14937613
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const LEGACY_CACHE = "ronin-legacy.json";
const V3_CACHE = "ronin-v3.json";
const T_LEGACY = "0xd56c021eb1befc5273569485864a514b5d80a6192ce1181668ac7c553212558e"; // TokenWithdrew(uint256,address,address,address,uint32,uint256)
const T_REQUESTED = "0xf313c253a5be72c29d0deb2c8768a9543744ac03d6b3cafd50cc976f1c2632fc"; // WithdrawalRequested(bytes32,Receipt)

const RECEIPT = "(uint256 id, uint8 kind, (address addr, address tokenAddr, uint256 chainId) mainchain, (address addr, address tokenAddr, uint256 chainId) ronin, (uint8 erc, uint256 id, uint256 quantity) info)";
const roninAbi = parseAbi([
  `function withdrawal(uint256) view returns ${RECEIPT}`,
  "function getWithdrawalSignatures(uint256 withdrawalId, address[] operators) view returns (bytes[])",
]);
const mainAbi = parseAbi([
  `function submitWithdrawal(${RECEIPT} receipt, (uint8 v, bytes32 r, bytes32 s)[] signatures) returns (bool locked)`,
  "function withdrawalHash(uint256) view returns (bytes32)",
  "function withdrawalLocked(uint256) view returns (bool)",
  "function minimumVoteWeight() view returns (uint256)",
  "function getFullBridgeOperatorInfos() view returns (address[] governors, address[] operators, uint96[] weights)",
  "function withdrawals(uint256) view returns (address owner, address token, uint256 number)",
  "error ErrQueryForInsufficientVoteWeight()",
  "error ErrQueryForProcessedWithdrawal()",
  "error ErrReachedDailyWithdrawalLimit()",
  "error ErrQueryForApprovedWithdrawal()",
  "error ErrRestricted(bytes4, uint8)",
]);
const ronin = () => client(RONIN.chain, RONIN.net);
const multi = (c, address, abi, functionName, argsList) =>
  argsList.length ? c.multicall({ contracts: argsList.map((args) => ({ address, abi, functionName, args })), allowFailure: false, batchSize: 50_000 }) : [];

// Only the current Ethereum operator set counts, so ask Ronin for exactly their signatures, sorted
// ascending (submitWithdrawal rejects unordered signers).
const operators = memo(async () => {
  const read = (address, functionName) => l1().readContract({ address, abi: mainAbi, functionName });
  const [[, ops, weights], minWeight] = await Promise.all([read(MBM, "getFullBridgeOperatorInfos"), read(MGW, "minimumVoteWeight")]);
  const list = ops.map((a, i) => ({ a, w: weights[i] })).sort((x, y) => (BigInt(x.a) < BigInt(y.a) ? -1 : 1));
  return { list, minWeight };
}, 60 * MIN);

// ---------- index ----------

const word = (data, i) => `0x${data.slice(2 + 64 * i, 66 + 64 * i)}`;
const addr = (w) => `0x${w.slice(-40)}`;

// Raw eth_getLogs in 10k-block windows (Alchemy's Ronin cap), halving a window that returns too many logs.
// Rows are mapped per window so a million raw logs never sit in memory at once.
async function rawLogs(c, address, topic, from, to, map) {
  const wins = []; for (let b = from; b <= to; b += 10_000n) wins.push([b, b + 9_999n > to ? to : b + 9_999n]);
  const get = async ([a, z]) => {
    try { return (await c.request({ method: "eth_getLogs", params: [{ address, topics: [topic], fromBlock: toHex(a), toBlock: toHex(z) }] })).flatMap(map); }
    catch (e) {
      if (z <= a || !/exceed|range|limit|too many|10,?000|size/i.test(`${e.details ?? ""} ${e.message ?? ""}`)) throw e;
      const m = (a + z) / 2n; return [...(await get([a, m])), ...(await get([m + 1n, z]))];
    }
  };
  return (await pool(wins, 16, get)).flat();
}
const logTime = (l) => (l.blockTimestamp ? Number(l.blockTimestamp) : null);

// Legacy rows: [newId, legacyId, owner, token, erc, number, block, time, tx]. The legacy side is frozen
// (Ronin implementation 0xdEaD, Ethereum gateway paused), so this is built once and never synced.
const legacyIndex = memo(async () => {
  try { const x = JSON.parse(readFileSync(cachePath(LEGACY_CACHE), "utf8")); if (x.v === 1) return x.rows; } catch {}
  paidOnly();
  console.error("ronin: first run, indexing unclaimed pre-2022 withdrawals (a few minutes, cached after)...");
  // Unclaimed = never recorded by the old Ethereum gateway; their order gives the migrated id.
  const ids = []; for (let i = 1; i <= OLD_MAX; i++) ids.push(i);
  const parts = []; for (let i = 0; i < ids.length; i += 2500) parts.push(ids.slice(i, i + 2500));
  const open = (await pool(parts, 8, async (p) => {
    const r = await multi(l1(), OLD_MGW, mainAbi, "withdrawals", p.map((i) => [BigInt(i)]));
    return p.filter((_, i) => BigInt(r[i][0]) === 0n);
  })).flat();
  if (open.length !== MIGRATED) throw new Error(`Ronin legacy index: ${open.length} unclaimed, expected ${MIGRATED}`);
  const rank = new Map(open.map((id, i) => [id, i]));
  const rows = await rawLogs(ronin(), OLD_GW, T_LEGACY, 0n, OLD_END, (l) => {
    const id = Number(BigInt(l.topics[1]));
    if (!rank.has(id)) return [];
    const erc = Number(BigInt(word(l.data, 1))) === 721 ? 1 : 0;
    return [[rank.get(id), id, addr(l.topics[2]), addr(word(l.data, 0)), erc, BigInt(word(l.data, 2)).toString(), Number(BigInt(l.blockNumber)), logTime(l), l.transactionHash]];
  });
  const uniq = [...new Map(rows.map((r) => [r[0], r])).values()].sort((a, b) => a[0] - b[0]);
  if (uniq.length !== MIGRATED) throw new Error(`Ronin legacy index: ${uniq.length} events for ${MIGRATED} unclaimed ids`);
  saveJson(cachePath(LEGACY_CACHE), { v: 1, rows: uniq });
  console.error(`ronin: indexed ${uniq.length} unclaimed legacy withdrawals`);
  return uniq;
});

// V3 rows: [id, owner, sender, token, erc, quantity, tokenId, block, time, tx], synced from the last block.
// Synced at most every few minutes; concurrent callers share one sync.
const v3Index = memo(async () => {
  const c = ronin();
  let cache = { v: 1, block: Number(V3_START - 1n), rows: [] };
  try { const x = JSON.parse(readFileSync(cachePath(V3_CACHE), "utf8")); if (x.v === 1) cache = x; } catch {}
  const head = (await c.getBlockNumber()) - 50n; // stay behind the tip so reorged logs never reach the cache
  const from = BigInt(cache.block) + 1n;
  if (from > head) return cache.rows;
  if (!cache.rows.length) paidOnly();
  // Event data: receiptHash, then the static Receipt tuple word by word.
  const rows = await rawLogs(c, GW, T_REQUESTED, from, head, (l) => {
    const w = (i) => word(l.data, i + 1);
    return [[Number(BigInt(w(0))), addr(w(2)), addr(w(5)), addr(w(3)), Number(BigInt(w(8))), BigInt(w(10)).toString(), BigInt(w(9)).toString(), Number(BigInt(l.blockNumber)), logTime(l), l.transactionHash]];
  });
  const seen = new Set(cache.rows.map((r) => r[0]));
  cache = { v: 1, block: Number(head), rows: [...cache.rows, ...rows.filter((r) => !seen.has(r[0]))] };
  saveJson(cachePath(V3_CACHE), cache);
  return cache.rows;
}, 5 * MIN);

// ---------- items ----------

// WETH receipts are paid out as native ETH; NFTs get a fixed symbol so enrich never prices them.
const assetOf = (token, erc) => (erc === 0 ? (getAddress(token) === WETH ? ETH : erc20("eth-mainnet", token))
  : { ...erc20("eth-mainnet", token), symbol: erc === 1 ? "ERC-721" : "ERC-1155", decimals: 0 });
const fromLegacy = ([id, L, owner, token, erc, number, block, time, tx]) => ({
  tx, block: BigInt(block), time: time ?? undefined, owner: getAddress(owner), asset: assetOf(token, erc), amount: erc ? 1n : BigInt(number),
  id: BigInt(id), tokenId: erc ? BigInt(number) : null, detail: `legacy withdrawal ${L}, migrated as `, check: { owner, token, number: BigInt(number) },
});
const fromV3 = ([id, owner, sender, token, erc, quantity, tokenId, block, time, tx]) => ({
  tx, block: BigInt(block), time: time ?? undefined, owner: getAddress(owner), from: getAddress(sender), asset: assetOf(token, erc), amount: erc === 1 ? 1n : BigInt(quantity),
  id: BigInt(id), tokenId: erc ? BigInt(tokenId) : null,
});

// Bulk reads for every item at once, so status() only classifies and simulates.
async function prefetch(items) {
  const c = ronin();
  const [hashes, locks] = await Promise.all([
    multi(l1(), MGW, mainAbi, "withdrawalHash", items.map((i) => [i.id])),
    multi(l1(), MGW, mainAbi, "withdrawalLocked", items.map((i) => [i.id])),
  ]);
  items.forEach((it, i) => { it.submitted = BigInt(hashes[i]) !== 0n; it.locked = locks[i]; });
  // Never submitted: the exact receipt (it is what the operators signed) and its signatures.
  const open = items.filter((i) => !i.submitted);
  const { list } = await operators();
  const [ws, sigs] = await Promise.all([
    multi(c, GW, roninAbi, "withdrawal", open.map((i) => [i.id])),
    multi(c, GW, roninAbi, "getWithdrawalSignatures", open.map((i) => [i.id, list.map((o) => o.a)])),
  ]);
  open.forEach((it, i) => {
    const w = ws[i], r = { id: w[0], kind: w[1], mainchain: w[2], ronin: w[3], info: w[4] }, k = it.check;
    // A migrated id is derived, so only trust it when the receipt matches the legacy event.
    if (k && !(r.mainchain.addr.toLowerCase() === k.owner && r.mainchain.tokenAddr.toLowerCase() === k.token && (r.info.erc === 0 ? r.info.quantity : r.info.id) === k.number)) {
      it.status = "unknown"; it.detail += `withdrawal id ${it.id}, receipt does not match the legacy event`; return;
    }
    it.receipt = r; it.sigs = sigs[i];
  });
}

export default {
  key: "ronin", name: "Ronin", scan: true, scanChain: RONIN,
  warm: () => Promise.all([legacyIndex(), v3Index()]),
  async find(user, range) {
    const [legacy, v3] = await Promise.all([legacyIndex(), v3Index()]);
    let items;
    if (!user) {
      const [from, to] = range.map(Number);
      items = [...legacy.filter((r) => r[6] >= from && r[6] <= to).map(fromLegacy), ...v3.filter((r) => r[7] >= from && r[7] <= to).map(fromV3)];
    } else {
      // V3 rows carry both the Ronin sender and the Ethereum recipient. Legacy events only index the
      // recipient, so legacy requests sent by this address are matched by tx via its transfers to the old gateway.
      const u = user.toLowerCase();
      const sent = new Set((await transferTxs(ronin(), user, OLD_GW, ["erc20", "erc721"])).map((t) => t.hash));
      items = [...legacy.filter((r) => r[2] === u || sent.has(r[8])).map(fromLegacy), ...v3.filter((r) => r[1] === u || r[2] === u).map(fromV3)];
    }
    await prefetch(items);
    return items;
  },
  async status(it) {
    const { receipt: r, submitted, locked, sigs: raw, id, tokenId } = it;
    for (const k of ["receipt", "submitted", "locked", "sigs", "id", "tokenId", "check"]) delete it[k];
    it.time ??= await blockTime(ronin(), RONIN.net, it.block);
    if (it.status) return it; // settled in prefetch (unmatched legacy receipt)
    it.detail = `${it.detail ?? ""}withdrawal id ${id}${tokenId != null ? `, token id ${tokenId}` : ""}`;
    it.action = "Ronin bridge app (app.roninchain.com/bridge) > history > Claim on Ethereum, or MainchainGatewayV3.submitWithdrawal(receipt, RoninGatewayV3.getWithdrawalSignatures)";
    if (submitted) {
      // Paid out, unless it tripped the high-value lock and waits for unlockWithdrawal.
      it.status = locked ? "blocked" : "claimed";
      if (locked) it.detail += ", locked for high-value review (unlockWithdrawal by the Ronin team)";
      return it;
    }
    const { list, minWeight } = await operators();
    const weight = list.reduce((s, o, i) => s + (raw[i] !== "0x" ? o.w : 0n), 0n);
    const sigs = raw.filter((s) => s !== "0x").map((s) => { const p = parseSignature(s); return { v: Number(p.v ?? 27n + BigInt(p.yParity)), r: p.r, s: p.s }; });
    it.detail += `, ${sigs.length}/${list.length} operator signatures (weight ${weight}/${minWeight})`;
    try {
      // Ground truth: simulate the claim on Ethereum as the recipient.
      const { result: locks } = await l1().simulateContract({ address: MGW, abi: mainAbi, functionName: "submitWithdrawal", args: [r, sigs], account: r.mainchain.addr });
      it.status = "claimable";
      if (locks) it.detail += ", above the lock threshold: claiming locks it until the Ronin team unlocks";
    } catch (e) {
      const t = revertText(e);
      if (/InsufficientVoteWeight/.test(t)) {
        it.status = "blocked";
        it.detail += ", needs RoninGatewayV3.requestWithdrawalSignatures(id) but operators stopped signing after the CCIP migration";
      } else if (/ProcessedWithdrawal|ApprovedWithdrawal/.test(t)) it.status = "claimed";
      else if (/DailyWithdrawalLimit/.test(t)) { it.status = "waiting"; it.detail += ", Ethereum gateway daily limit reached"; }
      else if (/paused|ErrRestricted/i.test(t)) { it.status = "blocked"; it.detail += ", Ethereum gateway paused or restricted"; }
      else { it.status = "unknown"; it.detail += `, simulation reverted: ${(e.shortMessage ?? t).split("\n")[0]}`; }
    }
    return it;
  },
};
