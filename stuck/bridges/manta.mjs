// Manta Pacific -> Ethereum withdrawals (OP Stack by Caldera, OptimismPortal on an L2OutputOracle, 3-day window).
// Alchemy has no Manta and its public RPC caps eth_getLogs at 100k blocks (~100 ranges for the whole chain), so like
// Lisk every withdrawal (bridge WithdrawalInitiated + direct MessagePassed) is indexed once on disk, then synced
// incrementally; the portal is read with the shared L2OutputOracle reader (lib.mjs classifyL2oo).
// L1 contracts: l2beat/l2beat packages/config/src/projects/mantapacific/discovered.json, verified on Etherscan.
import { parseAbiItem, decodeEventLog, getAddress, zeroAddress } from "viem";
import * as chains from "viem/chains";
import { getWithdrawals } from "viem/op-stack";
import { readFileSync } from "node:fs";
import { MIN, now, rpcClient, pool, blockTime, memo, cachePath, saveJson, l2ooSettings, l2ooFacts, classifyL2oo, ETH, erc20 } from "../lib.mjs";

const M = {
  rpc: "https://pacific-rpc.manta.network/http",
  portal: "0x9168765EE952de7C6f8fC6FaD5Ec209B960b7622", oracle: "0x30c789674ad3B458886BBC9abf42EEe19EA05C1D",
  bridge: "0x4200000000000000000000000000000000000010", messenger: "0x4200000000000000000000000000000000000007", passer: "0x4200000000000000000000000000000000000016",
};
const evWithdrawal = parseAbiItem("event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)");
const evMessagePassed = parseAbiItem("event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)");
const TOPIC = { withdrawal: "0x73d170910aba9e6d50b102db522b1dbcd796216f5128b445aa2135272886497e", passed: "0x02a52367d10742d8032712c1bb8e0144ff1ec5ffda1ed7d70bb05a2744955054" };
const manta = () => rpcClient(chains.manta, M.rpc);

// [block, tx, logIndex, from, to, l1Token ("" = ETH), amount hex]: every withdrawal ever started on Manta Pacific, value > 0
const CACHE = "manta-withdrawals.json", SPAN = 100_000n;
const sync = memo(async () => {
  let cache = { block: -1, rows: [] };
  try { cache = JSON.parse(readFileSync(cachePath(CACHE), "utf8")); } catch {}
  const tip = await manta().getBlockNumber().catch((e) => { if (cache.rows.length) return null; throw e; });
  if (tip == null) return cache.rows;
  const head = tip - 30n;
  const from = BigInt(cache.block) + 1n;
  if (from > head) return cache.rows;
  const first = !cache.rows.length;
  if (first) console.error("manta: first run, indexing every Manta Pacific withdrawal since 2023 (cached after)...");
  const parts = [];
  for (let a = from; a <= head; a += SPAN) parts.push([a, a + SPAN - 1n > head ? head : a + SPAN - 1n]);
  const got = await pool(parts, 8, async ([a, z]) => (await manta().request({ method: "eth_getLogs", params: [{ address: [M.bridge, M.passer], topics: [[TOPIC.withdrawal, TOPIC.passed]], fromBlock: `0x${a.toString(16)}`, toBlock: `0x${z.toString(16)}` }] })).map(row).filter(Boolean));
  cache = { block: Number(head), rows: [...cache.rows, ...got.flat()] };
  saveJson(cachePath(CACHE), cache);
  if (first) console.error(`manta: indexed, ${cache.rows.length} withdrawals`);
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
  return a && a.value > 0n && a.sender.toLowerCase() !== M.messenger ? [...base, a.sender.toLowerCase(), a.target.toLowerCase(), "", a.value.toString(16)] : null;
}
const decode = (event, l) => { try { return decodeEventLog({ abi: [event], data: l.data, topics: l.topics }).args; } catch { return null; } };

const mantaBridge = {
  key: "manta", name: "Manta Pacific", scan: false,
  warm: () => sync(),
  async find(user) {
    if (!user) return []; // no chain-wide scan: per-wallet only
    return mine(await sync(), user);
  },
  async status(it) {
    const receipt = await manta().getTransactionReceipt({ hash: it.tx });
    it.time = await blockTime(manta(), "manta-public", it.block);
    // the withdrawal of a bridge log is the first MessagePassed at or after it in the same receipt
    const passed = receipt.logs.filter((l) => l.address.toLowerCase() === M.passer);
    const idx = Math.max(0, passed.findIndex((l) => l.logIndex >= it.logIndex));
    const w = getWithdrawals({ logs: receipt.logs })[idx];
    if (!w) { it.status = "unknown"; it.detail = "MessagePassed not found"; return it; }
    it.withdrawalHash = w.withdrawalHash;
    const [f, s] = await Promise.all([l2ooFacts(M.portal, M.oracle, w.withdrawalHash), l2ooSettings(M.portal, M.oracle)]);
    Object.assign(it, classifyL2oo(f, s, it.block, now()));
    it.action = `pacific-bridge.manta.network: ${it.status === "ready-to-prove" ? "prove on Ethereum, wait 3 days, then finalize" : "finalize on Ethereum"}`;
    return it;
  },
};

// the wallet's rows of the index (sent by it or to it) -> stuck items
const mine = (rows, user) => {
  const me = user.toLowerCase();
  return rows.filter((r) => r[3] === me || r[4] === me).map(([block, tx, logIndex, from, to, token, amount]) => ({
    tx, block: BigInt(block), logIndex, owner: getAddress(to), from: getAddress(from), asset: token ? erc20("eth-mainnet", token) : ETH, amount: BigInt(`0x${amount}`),
  }));
};

export default mantaBridge;
export { M as MANTA, mine, row };
