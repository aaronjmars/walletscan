// Morph -> Ethereum withdrawals (Morph's own rollup: Scroll-style messengers, a withdrawal Merkle tree on L2, batches
// finalized on Ethereum after a 2-day challenge window). A withdrawal is claimed with
// L1CrossDomainMessenger.proveAndRelayMessage(from, to, value, nonce, message, proof, withdrawalRoot) once the batch
// holding it is finalized (Rollup.withdrawalRoots(root) = true); finalizedWithdrawals(hash) marks it claimed.
// - finding: Morph's own bridge indexer (indexer.morph.network, what bridge.morph.network lists) answers per wallet,
//   keyless. Alchemy has no Morph on our keys and the public RPC caps log ranges.
// - status: the message is rebuilt from the L2 receipt (SentMessage of the L2 messenger, nonce from the indexer), its
//   hash checked on Ethereum, the proof taken from the same indexer (getProof), its root checked finalized on the
//   Rollup, and the claim itself simulated with eth_call: claimable means proveAndRelayMessage goes through now.
// L1 contracts: l2beat/l2beat packages/config/src/projects/morph/discovered.json, verified on Etherscan.
import { parseAbi, parseAbiItem, decodeEventLog, encodeFunctionData, keccak256, getAddress, zeroAddress } from "viem";
import * as chains from "viem/chains";
import { l1, rpcClient, memo, MIN, ETH, erc20, fetchJson, revertText } from "../lib.mjs";

const MO = {
  rpc: "https://rpc.morphl2.io", indexer: "https://indexer.morph.network",
  l1Messenger: "0xDc71366EFFA760804DCFC3EDF87fa2A6f1623304", rollup: "0x759894Ced0e6af42c26668076Ffa84d02E3CeF60",
  l2Messenger: "0x5300000000000000000000000000000000000007",
};
const evSentMessage = parseAbiItem("event SentMessage(address indexed sender, address indexed target, uint256 value, uint256 messageNonce, uint256 gasLimit, bytes message)");
const relayAbi = parseAbi(["function relayMessage(address from, address to, uint256 value, uint256 nonce, bytes message)"]);
const l1Abi = parseAbi([
  "function finalizedWithdrawals(bytes32) view returns (bool)",
  "function paused() view returns (bool)",
  "function withdrawalRoots(bytes32) view returns (bool)",
  "function proveAndRelayMessage(address _from, address _to, uint256 _value, uint256 _nonce, bytes _message, bytes32[32] _withdrawalProof, bytes32 _withdrawalRoot)",
]);
const morph = () => rpcClient(chains.morph, MO.rpc);
const read = (address, functionName, args = []) => l1().readContract({ address, abi: l1Abi, functionName, args });
const paused = memo(() => read(MO.l1Messenger, "paused"), 10 * MIN);

// one indexer row -> a stuck item (amount in raw units of the L1 token; tokens keep the L2 symbol and decimals)
function fromIndexer(w) {
  const token = w.l1Token && w.l1Token !== zeroAddress ? w.l1Token : null;
  return {
    tx: w.transactionHash, block: BigInt(w.blockNumber), time: Number(w.blockTimestamp), owner: getAddress(w.to), from: getAddress(w.from),
    asset: token ? { ...erc20("eth-mainnet", token), symbol: w.l2Token?.symbol, decimals: w.l2Token?.decimals } : ETH,
    amount: BigInt(w.amount), nonce: BigInt(w.withdrawalNonce),
  };
}
// the L2 messenger's SentMessage with this nonce in a receipt, and the hash Ethereum keys it by
function message(logs, nonce) {
  for (const l of logs) {
    if (l.address.toLowerCase() !== MO.l2Messenger) continue;
    try {
      const a = decodeEventLog({ abi: [evSentMessage], data: l.data, topics: l.topics }).args;
      if (a.messageNonce === nonce) return { ...a, hash: keccak256(encodeFunctionData({ abi: relayAbi, args: [a.sender, a.target, a.value, a.messageNonce, a.message] })) };
    } catch {}
  }
  return null;
}
// facts -> status (pure, for the tests): finalized on L1, messenger paused, the indexer's proof (leaf + root), root
// finalized on the Rollup, and the simulated claim (true, or its revert text)
function classify({ finalized, paused: p, proof, hash, rootFinal, sim }) {
  if (finalized) return { status: "claimed" };
  if (p) return { status: "blocked", detail: "the Morph messenger on Ethereum is paused" };
  if (!proof?.root || proof.leaf?.toLowerCase() !== hash.toLowerCase()) return { status: "waiting", detail: "no withdrawal proof yet: its batch is not finalized on Ethereum" };
  if (!rootFinal) return { status: "waiting", detail: "its batch is not finalized on Ethereum yet (2-day challenge window)" };
  if (sim === true) return { status: "claimable", detail: `withdrawal nonce ${proof.index}, claim simulated` };
  if (/already been finalized/i.test(sim ?? "")) return { status: "claimed" };
  return { status: "unknown", detail: `claim reverts: ${String(sim).match(/Messenger: [^"\n]+/)?.[0] ?? "simulation failed"}` };
}

const morphBridge = {
  key: "morph", name: "Morph", scan: false,
  async find(user) {
    if (!user) return []; // no chain-wide scan: per-wallet only
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      const r = await fetchJson(`${MO.indexer}/v1/withdrawals/${user}?limit=100&offset=${offset}`);
      if (!r?.pagination) throw new Error("Morph bridge indexer: no answer");
      rows.push(...(r.items ?? []));
      if (!r.items?.length || rows.length >= r.pagination.total) break;
    }
    return rows.map(fromIndexer).filter((i) => i.amount > 0n);
  },
  async status(it) {
    const receipt = await morph().getTransactionReceipt({ hash: it.tx });
    const m = message(receipt.logs, it.nonce);
    if (!m) { it.status = "unknown"; it.detail = `SentMessage nonce ${it.nonce} not found in the tx`; return it; }
    it.withdrawalHash = m.hash;
    const finalized = await read(MO.l1Messenger, "finalizedWithdrawals", [m.hash]);
    let facts = { finalized, hash: m.hash };
    if (!finalized) {
      const proof = await fetchJson(`${MO.indexer}/getProof?nonce=${it.nonce}`);
      facts = { ...facts, paused: await paused(), proof };
      if (proof?.root && proof.leaf?.toLowerCase() === m.hash.toLowerCase()) {
        facts.rootFinal = await read(MO.rollup, "withdrawalRoots", [proof.root]);
        if (facts.rootFinal) {
          const data = encodeFunctionData({ abi: l1Abi, functionName: "proveAndRelayMessage", args: [m.sender, m.target, m.value, m.messageNonce, m.message, proof.proof, proof.root] });
          facts.sim = await l1().call({ to: MO.l1Messenger, account: it.owner, data }).then(() => true, (e) => revertText(e));
        }
      }
    }
    Object.assign(it, classify(facts));
    it.action = "bridge.morph.network > History > Claim (proveAndRelayMessage on Ethereum, proof from Morph's indexer)";
    return it;
  },
};

export default morphBridge;
export { MO as MORPH, fromIndexer, message, classify };
