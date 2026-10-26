// Mantle -> Ethereum withdrawals: Mantle v2 (OP Stack Bedrock fork since the 2024-03-15 Tectonic upgrade, OP Succinct
// L2OutputOracle since 2025, 12 h window) and the Mantle v1 withdrawals left from before the upgrade.
// Three things differ from the built-in OP Stack bridges:
// - finding: Alchemy caps Mantle eth_getLogs at 10k blocks (100M+ blocks) and has no Transfers API there, so a wallet's
//   bridge logs come from Routescan's keyless Etherscan-style logs API (Etherscan v2 when ETHERSCAN_API_KEY is set
//   and Routescan fails);
// - hash: Mantle's withdrawal carries mntValue + ethValue (MessagePassed and hashWithdrawal differ from OP's), so the
//   portal is read with the shared L2OutputOracle reader (lib.mjs classifyL2oo), not viem;
// - v1: the upgrade copied every unrelayed v1 message into L2ToL1MessagePasser as a "version 0" withdrawal
//   (mantle-v2 v1.0.0 op-chain-ops/crossdomain/migrate.go MigrateWithdrawal); L1CrossDomainMessenger still relays it
//   and refuses one already relayed under its v1 hash. Checked onchain: v1 tx 0xac28e958's migrated hash is in
//   sentMessages on L2 and was proven on the portal in 2026-10.
// L1 contracts: l2beat/l2beat packages/config/src/projects/mantle/discovered.json, verified on Etherscan.
import { parseAbi, parseAbiItem, decodeEventLog, decodeFunctionData, encodeFunctionData, encodeAbiParameters, keccak256, size, getAddress, zeroAddress, pad } from "viem";
import * as chains from "viem/chains";
import { now, client, l1, blockTime, l2ooSettings, l2ooFacts, classifyL2oo, ETH, erc20, fetchJson } from "../lib.mjs";

const MT = {
  chainId: 5000, net: "mantle-mainnet",
  portal: "0xc54cb22944F2bE476E02dECfCD7e3E7d3e15A8Fb", oracle: "0x31d543e7BE1dA6eFDc2206Ef7822879045B9f481", l1Messenger: "0x676A795fe6E43C17c668de16730c3F690FEB7120",
  l1Mnt: "0x3c3a81e81dc49A522A592e7622A7E711c06bf354", // MNT on Ethereum: what an L2 MNT withdrawal pays out
  bridge: "0x4200000000000000000000000000000000000010", messenger: "0x4200000000000000000000000000000000000007", passer: "0x4200000000000000000000000000000000000016",
  upgrade: "2024-03-15",
};
const evWithdrawal = parseAbiItem("event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)");
const evMessagePassed = parseAbiItem("event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 mntValue, uint256 ethValue, uint256 gasLimit, bytes data, bytes32 withdrawalHash)");
const evSentMessage = parseAbiItem("event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)");
const TOPIC = { withdrawal: "0x73d170910aba9e6d50b102db522b1dbcd796216f5128b445aa2135272886497e", passed: "0x5da382596b838a63b4248e533d8e399b3b0f13ba6c6679f670489d44716cb173" };
const legacyBridgeAbi = parseAbi(["function finalizeETHWithdrawal(address from, address to, uint256 amount, bytes data)", "function finalizeMantleWithdrawal(address from, address to, uint256 amount, bytes data)"]);
const messengerAbi = parseAbi([
  "function relayMessage(uint256 nonce, address sender, address target, uint256 mntValue, uint256 ethValue, uint256 minGasLimit, bytes message)",
  "function relayMessage(address target, address sender, bytes message, uint256 nonce)",
  "function successfulMessages(bytes32) view returns (bool)",
]);
const passerAbi = parseAbi(["function sentMessages(bytes32) view returns (bool)"]);
const mantle = () => client(chains.mantle, MT.net);

// ---------- finding ----------

// Etherscan-style logs (Routescan keyless, else Etherscan v2 with a key), 1000 per page
const LOG_APIS = [
  () => `https://api.routescan.io/v2/network/mainnet/evm/${MT.chainId}/etherscan/api?`,
  () => (process.env.ETHERSCAN_API_KEY ? `https://api.etherscan.io/v2/api?chainid=${MT.chainId}&apikey=${process.env.ETHERSCAN_API_KEY}&` : null),
];
async function explorerLogs(address, topic0, pos, user) {
  let last;
  for (const base of LOG_APIS.map((f) => f()).filter(Boolean)) {
    try {
      const out = [];
      for (let page = 1; ; page++) {
        const r = await fetchJson(`${base}module=logs&action=getLogs&address=${address}&topic0=${topic0}&topic${pos}=${pad(user).toLowerCase()}&topic0_${pos}_opr=and&fromBlock=0&toBlock=latest&page=${page}&offset=1000`);
        if (r?.status !== "1" && !/no records/i.test(r?.message ?? "")) throw new Error(`logs API: ${String(r?.result ?? r?.message ?? "no answer").slice(0, 120)}`);
        const rows = Array.isArray(r.result) ? r.result : [];
        out.push(...rows);
        if (rows.length < 1000) return out.map(fromExplorer);
      }
    } catch (e) { last = e; }
  }
  throw last;
}
// an Etherscan-style log -> the viem log fields used here
const fromExplorer = (l) => ({ address: l.address, topics: l.topics.filter(Boolean), data: l.data, blockNumber: BigInt(l.blockNumber), logIndex: Number(l.logIndex === "0x" ? 0 : l.logIndex), transactionHash: l.transactionHash });

// a wallet's bridge withdrawals (v1 and v2 emit the same event) and direct passer withdrawals -> stuck items
function items(bridgeLogs, passerLogs) {
  const out = [];
  for (const l of bridgeLogs) {
    const a = decode(evWithdrawal, l);
    if (!a || a.amount === 0n) continue;
    out.push({ tx: l.transactionHash, block: l.blockNumber, logIndex: l.logIndex, owner: a.to, from: a.from, asset: a.l1Token === zeroAddress ? ETH : erc20("eth-mainnet", a.l1Token), amount: a.amount });
  }
  const seen = new Set();
  for (const l of passerLogs) {
    const a = decode(evMessagePassed, l), k = `${l.transactionHash}:${l.logIndex}`;
    // the bridge's own messages come from the L2 messenger: those are the bridge logs above
    if (!a || seen.has(k) || a.sender.toLowerCase() === MT.messenger) continue;
    seen.add(k);
    const base = { tx: l.transactionHash, block: l.blockNumber, logIndex: l.logIndex, owner: a.target, from: a.sender, direct: true };
    if (a.mntValue > 0n) out.push({ ...base, asset: erc20("eth-mainnet", MT.l1Mnt), amount: a.mntValue });
    if (a.ethValue > 0n) out.push({ ...base, asset: ETH, amount: a.ethValue });
  }
  return out;
}
const decode = (event, l) => { try { return decodeEventLog({ abi: [event], data: l.data, topics: l.topics }).args; } catch { return null; } };

// ---------- v1: the migrated withdrawal ----------

// a v1 SentMessage -> the version-0 withdrawal the upgrade stored for it (migrate.go MigrateWithdrawal + MigrateWithdrawalGasLimit)
function migrate(m) {
  let eth = 0n, mnt = 0n;
  try {
    const d = decodeFunctionData({ abi: legacyBridgeAbi, data: m.message });
    if (getAddress(m.sender) === getAddress(MT.bridge)) [eth, mnt] = d.functionName === "finalizeETHWithdrawal" ? [d.args[2], 0n] : [0n, d.args[2]];
  } catch {}
  const data = encodeFunctionData({ abi: messengerAbi, functionName: "relayMessage", args: [m.messageNonce, m.sender, m.target, mnt, eth, 0n, m.message] });
  const overhead = 200_000n + (64n * 1_000_000n) / 63n + 40_000n + 40_000n + 5_000n;
  const gas = BigInt(size(data)) * 16n + overhead, gasLimit = gas > 25_000_000n ? 25_000_000n : gas;
  const hash = keccak256(encodeAbiParameters(
    [{ type: "uint256" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }],
    [m.messageNonce, MT.messenger, MT.l1Messenger, mnt, eth, gasLimit, data],
  ));
  // the hash v1's L1CrossDomainMessenger marked when it relayed the message before the upgrade
  const legacyHash = keccak256(encodeFunctionData({ abi: messengerAbi, functionName: "relayMessage", args: [m.target, m.sender, m.message, m.messageNonce] }));
  return { hash, legacyHash, mnt, eth, gasLimit };
}

// ---------- bridge ----------

const delayText = (s) => (s >= 86400 ? `${Math.round(s / 86400)} days` : `${Math.round(s / 3600)} hours`);
const mantleBridge = {
  key: "mantle", name: "Mantle", scan: false,
  async find(user) {
    if (!user) return []; // no chain-wide scan: per-wallet only
    const bridgeLogs = await explorerLogs(MT.bridge, TOPIC.withdrawal, 3, user);
    const passerLogs = [...(await explorerLogs(MT.passer, TOPIC.passed, 2, user)), ...(await explorerLogs(MT.passer, TOPIC.passed, 3, user))];
    return items(bridgeLogs, passerLogs);
  },
  async status(it) {
    const receipt = await mantle().getTransactionReceipt({ hash: it.tx });
    it.time = await blockTime(mantle(), MT.net, it.block);
    // v2: the withdrawal of a bridge log is the first MessagePassed at or after it in the same receipt
    const passed = receipt.logs.filter((l) => l.address.toLowerCase() === MT.passer && l.topics[0] === TOPIC.passed && l.logIndex >= it.logIndex);
    let hash = passed.length ? decode(evMessagePassed, passed[0])?.withdrawalHash : null;
    if (!hash) {
      // v1: the legacy messenger's SentMessage next to the bridge log carries the message
      let msg;
      for (const l of receipt.logs.filter((x) => x.address.toLowerCase() === MT.messenger)) {
        const a = decode(evSentMessage, l);
        if (a) msg = a;
        if (msg && l.logIndex > it.logIndex) break;
      }
      if (!msg) { it.status = "unknown"; it.detail = "neither MessagePassed nor a v1 SentMessage in the tx"; return it; }
      const w = migrate(msg);
      it.legacy = true;
      const [migrated, relayed] = await Promise.all([
        mantle().readContract({ address: MT.passer, abi: passerAbi, functionName: "sentMessages", args: [w.hash] }),
        l1().readContract({ address: MT.l1Messenger, abi: messengerAbi, functionName: "successfulMessages", args: [w.legacyHash] }),
      ]);
      if (relayed) { it.status = "claimed"; it.detail = `relayed before the ${MT.upgrade} upgrade`; return it; }
      if (!migrated) { it.status = "unknown"; it.detail = "Mantle v1 message not found in the migrated withdrawals"; return it; }
      hash = w.hash;
    }
    it.withdrawalHash = hash;
    const [f, s] = await Promise.all([l2ooFacts(MT.portal, MT.oracle, hash), l2ooSettings(MT.portal, MT.oracle)]);
    Object.assign(it, classifyL2oo(f, s, it.legacy ? 0n : it.block, now()));
    const step = it.status === "ready-to-prove" ? `prove on Ethereum, wait ${delayText(s.period)}, then finalize` : "finalize on Ethereum";
    it.action = it.legacy
      ? `Mantle v1 withdrawal from before the ${MT.upgrade} upgrade (the bridge app may not list it): rebuild the migrated withdrawal from the v1 message, ${step} on the OptimismPortal`
      : `app.mantle.xyz/bridge: ${step}`;
    if (it.legacy) it.detail = `Mantle v1 (pre-${MT.upgrade}); ${it.detail ?? ""}`.replace(/; $/, "");
    return it;
  },
};

export default mantleBridge;
export { MT as MANTLE, items, migrate, fromExplorer };
