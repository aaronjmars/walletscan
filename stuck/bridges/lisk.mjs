// Lisk -> Ethereum withdrawals (OP Stack). Lisk shuts down on 2026-10-31 (support.lisk.com/faq/lisk-chain-closure).
// Two things differ from the built-in OP Stack bridges, so it lives here:
// - finding: Alchemy has no Lisk on our keys, the public RPC caps eth_getLogs at 100k blocks and Blockscout's keyless
//   API allows 10 calls per hour, so every Lisk withdrawal (bridge WithdrawalInitiated + direct MessagePassed) is
//   indexed once on disk from the public RPC (~390 ranges, about a minute cold), then synced incrementally;
// - status: Lisk's dispute games (permissioned, v1.3.1) predate l2SequenceNumber(), which viem's getWithdrawalStatus
//   reads, so the portal and game checks are done here: finalized, proven by someone, game valid and old enough.
// Withdrawals proven before Lisk moved to dispute games (2025-07) hold a proof the portal no longer accepts: re-prove.
import { parseAbi, parseAbiItem, decodeEventLog, getAddress, zeroAddress, createPublicClient, http } from "viem";
import * as chains from "viem/chains";
import { getWithdrawals } from "viem/op-stack";
import { readFileSync } from "node:fs";
import { MIN, now, l1, pool, blockTime, memo, cachePath, saveJson, ETH, erc20 } from "../lib.mjs";

const L = {
  rpc: "https://rpc.api.lisk.com",
  portal: "0x26dB93F8b8b4f7016240af62F7730979d353f9A7", factory: "0x0CF7D3706a27CCE2017aEB11E8a9c8b5388c282C",
  bridge: "0x4200000000000000000000000000000000000010", messenger: "0x4200000000000000000000000000000000000007", passer: "0x4200000000000000000000000000000000000016",
  closes: "2026-10-31",
};
const evWithdrawal = parseAbiItem("event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)");
const evMessagePassed = parseAbiItem("event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)");
const TOPIC = { withdrawal: "0x73d170910aba9e6d50b102db522b1dbcd796216f5128b445aa2135272886497e", passed: "0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054" };
const portalAbi = parseAbi([
  "function finalizedWithdrawals(bytes32) view returns (bool)",
  "function numProofSubmitters(bytes32) view returns (uint256)",
  "function proofSubmitters(bytes32, uint256) view returns (address)",
  "function provenWithdrawals(bytes32, address) view returns (address disputeGameProxy, uint64 timestamp)",
  "function proofMaturityDelaySeconds() view returns (uint256)",
  "function disputeGameFinalityDelaySeconds() view returns (uint256)",
  "function respectedGameType() view returns (uint32)",
  "function respectedGameTypeUpdatedAt() view returns (uint64)",
  "function disputeGameBlacklist(address) view returns (bool)",
]);
const factoryAbi = parseAbi([
  "function gameCount() view returns (uint256)",
  "function findLatestGames(uint32 gameType, uint256 start, uint256 n) view returns ((uint256 index, bytes32 metadata, uint64 timestamp, bytes32 rootClaim, bytes extraData)[])",
]);
const gameAbi = parseAbi(["function l2BlockNumber() view returns (uint256)", "function status() view returns (uint8)", "function resolvedAt() view returns (uint64)", "function createdAt() view returns (uint64)", "function gameType() view returns (uint32)"]);
const IN_PROGRESS = 0, CHALLENGER_WINS = 1, DEFENDER_WINS = 2;

let l2;
const lisk = () => (l2 ??= createPublicClient({ chain: chains.lisk, transport: http(L.rpc, { retryCount: 3, retryDelay: 400, timeout: 30_000 }) }));
const portal = (fn, args = []) => l1().readContract({ address: L.portal, abi: portalAbi, functionName: fn, args });
const game = (address, fn) => l1().readContract({ address, abi: gameAbi, functionName: fn });

// the portal's settings and the newest respected game's L2 block: they move slowly, read every 10 min
const settings = memo(async () => {
  const [maturity, finality, type, typeSince] = await Promise.all(["proofMaturityDelaySeconds", "disputeGameFinalityDelaySeconds", "respectedGameType", "respectedGameTypeUpdatedAt"].map((f) => portal(f)));
  const count = await l1().readContract({ address: L.factory, abi: factoryAbi, functionName: "gameCount" });
  const [latest] = count > 0n ? await l1().readContract({ address: L.factory, abi: factoryAbi, functionName: "findLatestGames", args: [type, count - 1n, 1n] }) : [];
  const provenTo = latest ? await game(`0x${latest.metadata.slice(26)}`, "l2BlockNumber") : 0n;
  return { maturity: Number(maturity), finality: Number(finality), type: Number(type), typeSince: Number(typeSince), provenTo };
}, 10 * 60_000);

// [block, tx, logIndex, from, to, l1Token ("" = ETH), amount hex]: every withdrawal ever started on Lisk, value > 0
const CACHE = "lisk-withdrawals.json", SPAN = 100_000n;
const sync = memo(async () => {
  let cache = { block: -1, rows: [] };
  try { cache = JSON.parse(readFileSync(cachePath(CACHE), "utf8")); } catch {}
  // after the 2026-10-31 shutdown the RPC goes away: keep answering from the frozen index
  const tip = await lisk().getBlockNumber().catch((e) => { if (cache.rows.length) return null; throw e; });
  if (tip == null) return cache.rows;
  const head = tip - 30n; // a minute behind the tip
  const from = BigInt(cache.block) + 1n;
  if (from > head) return cache.rows;
  const first = !cache.rows.length;
  if (first) console.error("lisk: first run, indexing every Lisk withdrawal since 2024 (about a minute, cached after)...");
  const parts = [];
  for (let a = from; a <= head; a += SPAN) parts.push([a, a + SPAN - 1n > head ? head : a + SPAN - 1n]);
  const got = await pool(parts, 8, async ([a, z]) => (await lisk().request({ method: "eth_getLogs", params: [{ address: [L.bridge, L.passer], topics: [[TOPIC.withdrawal, TOPIC.passed]], fromBlock: `0x${a.toString(16)}`, toBlock: `0x${z.toString(16)}` }] })).map(row).filter(Boolean));
  cache = { block: Number(head), rows: [...cache.rows, ...got.flat()] };
  saveJson(cachePath(CACHE), cache);
  if (first) console.error(`lisk: indexed, ${cache.rows.length} withdrawals`);
  return cache.rows;
}, 5 * MIN);
function row(l) {
  const block = parseInt(l.blockNumber, 16), base = [block, l.transactionHash, parseInt(l.logIndex, 16)];
  if (l.topics[0] === TOPIC.withdrawal) {
    const a = decode(evWithdrawal, l);
    return a && a.amount > 0n ? [...base, a.from.toLowerCase(), a.to.toLowerCase(), a.l1Token === zeroAddress ? "" : a.l1Token.toLowerCase(), a.amount.toString(16)] : null;
  }
  // ETH sent straight through the L2ToL1MessagePasser (the bridge's own messages come from the messenger)
  const a = decode(evMessagePassed, l);
  return a && a.value > 0n && a.sender.toLowerCase() !== L.messenger ? [...base, a.sender.toLowerCase(), a.target.toLowerCase(), "", a.value.toString(16)] : null;
}
const decode = (event, l) => { try { return decodeEventLog({ abi: [event], data: l.data, topics: l.topics }).args; } catch { return null; } };

const liskBridge = {
  key: "lisk", name: "Lisk", scan: false,
  warm: () => sync(),
  async find(user) {
    if (!user) return []; // no chain-wide scan: per-wallet only
    return mine(await sync(), user);
  },
  async status(it) {
    const receipt = await lisk().getTransactionReceipt({ hash: it.tx });
    it.time = await blockTime(lisk(), "lisk-public", it.block);
    // the withdrawal of a bridge log is the first MessagePassed at or after it in the same receipt
    const passed = receipt.logs.filter((l) => l.address.toLowerCase() === L.passer);
    const idx = Math.max(0, passed.findIndex((l) => l.logIndex >= it.logIndex));
    const w = getWithdrawals({ logs: receipt.logs })[idx];
    if (!w) { it.status = "unknown"; it.detail = "MessagePassed not found"; return it; }
    it.withdrawalHash = w.withdrawalHash;
    const s = await settings();
    const f = { finalized: await portal("finalizedWithdrawals", [w.withdrawalHash]) };
    if (!f.finalized) {
      f.proofs = Number(await portal("numProofSubmitters", [w.withdrawalHash]));
      if (f.proofs > 0) {
        const submitter = await portal("proofSubmitters", [w.withdrawalHash, BigInt(f.proofs - 1)]);
        [f.proxy, f.provenAt] = await portal("provenWithdrawals", [w.withdrawalHash, submitter]);
        [f.status, f.resolvedAt, f.createdAt, f.type, f.blacklisted] = await Promise.all([game(f.proxy, "status"), game(f.proxy, "resolvedAt"), game(f.proxy, "createdAt"), game(f.proxy, "gameType"), portal("disputeGameBlacklist", [f.proxy])].map((x) => x.catch(() => null)));
      }
    }
    return Object.assign(it, classify(f, s, it.block, now()));
  },
};

// the portal facts of one withdrawal -> { status, detail, action, deadline } (pure, for the tests)
// f: { finalized, proofs, proxy, provenAt, status (game: 0 in progress, 1 challenger won, 2 defender won), resolvedAt,
// createdAt, type, blacklisted }; s: settings(); block: the withdrawal's L2 block; t: now in seconds
function classify(f, s, block, t) {
  const day = (x) => new Date(Number(x) * 1000).toISOString().slice(0, 10);
  const prove = `prove it on Ethereum before ${L.closes} (Lisk shuts down then and a proof needs the chain), wait 7 days, then finalize`;
  if (f.finalized) return { status: "claimed" };
  // a proof needs Lisk's own state: after the shutdown it cannot be built, hence the deadline
  if (!f.proofs) {
    const ready = s.provenTo >= BigInt(block);
    return { status: ready ? "ready-to-prove" : "waiting", deadline: L.closes, action: `bridge.lisk.com (or Superbridge): ${prove}`,
      detail: ready ? `not proven; Lisk closes ${L.closes}` : "waiting for the next Lisk state proposal on Ethereum (about an hour)" };
  }
  // a proof against a lost, blacklisted or no-longer-respected game (or the pre-2025 output oracle) has to be redone
  if (f.status == null || f.blacklisted || Number(f.status) === CHALLENGER_WINS || Number(f.type) !== s.type || Number(f.createdAt) < s.typeSince || Number(f.provenAt) <= Number(f.createdAt)) {
    return { status: "ready-to-prove", deadline: L.closes, action: `bridge.lisk.com (or Superbridge): ${prove}`, detail: `proven against a game the portal no longer accepts (${f.proxy}): prove again before ${L.closes}` };
  }
  const matureAt = Number(f.provenAt) + s.maturity, gameFinalAt = Number(f.status) === DEFENDER_WINS ? Number(f.resolvedAt) + s.finality : null;
  if (t < matureAt || Number(f.status) === IN_PROGRESS || t < gameFinalAt) {
    return { status: "waiting", action: "bridge.lisk.com (or Superbridge): finalize on Ethereum once the 7 days are over", detail: `proven ${day(f.provenAt)}; finalizes from about ${day(Math.max(matureAt, gameFinalAt ?? matureAt))}` };
  }
  return { status: "ready-to-finalize", action: "bridge.lisk.com (or Superbridge): finalize on Ethereum", detail: `proven ${day(f.provenAt)}, 7 days passed` };
}

// the wallet's rows of the index (sent by it or to it) -> stuck items
const mine = (rows, user) => {
  const me = user.toLowerCase();
  return rows.filter((r) => r[3] === me || r[4] === me).map(([block, tx, logIndex, from, to, token, amount]) => ({
    tx, block: BigInt(block), logIndex, owner: getAddress(to), from: getAddress(from), asset: token ? erc20("eth-mainnet", token) : ETH, amount: BigInt(`0x${amount}`),
  }));
};

export default liskBridge;
export { L as LISK, classify, mine, row };
