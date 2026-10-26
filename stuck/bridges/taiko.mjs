// Taiko Alethia -> Ethereum withdrawals (Taiko's own bridge: Bridge.sendMessage on L2 writes a signal in the L2
// SignalService; on Ethereum, Bridge.processMessage(message, proof) checks a storage proof of that signal against a
// Taiko state root the protocol saved on the L1 SignalService, a "checkpoint", since the 2026 Shasta upgrade).
// Relayers process the messages that pay a fee; a message sent without one (or one no relayer took) waits for its
// owner to claim it on bridge.taiko.xyz, for ever.
// - finding: Taiko's relayer API (relayer.mainnet.taiko.xyz, what the bridge app lists) answers per wallet, keyless;
//   the message itself is decoded from the raw L2 log it returns. Alchemy has no Taiko, the public RPC caps log ranges.
// - status: messageStatus(msgHash) on the L1 Bridge (NEW / RETRIABLE / DONE / FAILED / RECALLED). A NEW message at or
//   before the latest checkpoint is proven like the bridge app does (eth_getProof of the signal slot on L2 at the
//   checkpoint block) and processMessage is simulated from the owner: claimable means the claim goes through now.
// L1 contracts: taikoxyz/taiko-mono packages/protocol/deployments/mainnet-contract-logs-L1.md, verified on Etherscan.
import { parseAbi, parseAbiItem, decodeEventLog, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, encodePacked, keccak256, getAddress, decodeFunctionResult } from "viem";
import * as chains from "viem/chains";
import { l1, rpcClient, memo, MIN, blockTime, ETH, erc20, fetchJson, revertText } from "../lib.mjs";

const TK = {
  chainId: 167000n, rpc: "https://rpc.mainnet.taiko.xyz", relayer: "https://relayer.mainnet.taiko.xyz",
  l1Bridge: "0xd60247c6848B7Ca29eDdF63AA924E53dB6Ddd8EC", l1Signal: "0x9e0a24964e5397B566c1ed39258e21aB5E35C77C", l1Vault: "0x996282cA11E5DEb6B5D122CC3B9A1FcAAD4415Ab",
  l2Bridge: "0x1670000000000000000000000000000000000001", l2Vault: "0x1670000000000000000000000000000000000002", l2Signal: "0x1670000000000000000000000000000000000005",
};
const MESSAGE = "(uint64 id, uint64 fee, uint32 gasLimit, address from, uint64 srcChainId, address srcOwner, uint64 destChainId, address destOwner, address to, uint256 value, bytes data)";
const evMessageSent = parseAbiItem(`event MessageSent(bytes32 indexed msgHash, ${MESSAGE} message)`);
const evCheckpoint = parseAbiItem("event CheckpointSaved(uint48 indexed blockNumber, bytes32 blockHash, bytes32 stateRoot)");
const bridgeAbi = parseAbi([
  `function processMessage(${MESSAGE} _message, bytes _proof) returns (uint8 status, uint8 reason)`,
  "function messageStatus(bytes32) view returns (uint8)",
  "function paused() view returns (bool)",
  "function onMessageInvocation(bytes _data)",
]);
const vaultAbi = parseAbi(["function canonicalToBridged(uint256 chainId, address canonicalAddress) view returns (address)"]);
const CANONICAL = [{ type: "tuple", components: [{ name: "chainId", type: "uint64" }, { name: "addr", type: "address" }, { name: "decimals", type: "uint8" }, { name: "symbol", type: "string" }, { name: "name", type: "string" }] }, { type: "address" }, { type: "address" }, { type: "uint256" }];
const HOP = [{ type: "tuple[]", components: [{ name: "chainId", type: "uint64" }, { name: "blockId", type: "uint64" }, { name: "rootHash", type: "bytes32" }, { name: "cacheOption", type: "uint8" }, { name: "accountProof", type: "bytes[]" }, { name: "storageProof", type: "bytes[]" }] }];
const STATUS = ["NEW", "RETRIABLE", "DONE", "FAILED", "RECALLED"];
const taiko = () => rpcClient(chains.taiko, TK.rpc);
const read = (abi, address, functionName, args = []) => l1().readContract({ address, abi, functionName, args });
const paused = memo(() => read(bridgeAbi, TK.l1Bridge, "paused"), 10 * MIN);
// the newest Taiko block whose state root Ethereum holds (saved every few minutes): look back ~2,000 L1 blocks
const checkpoint = memo(async () => {
  const tip = await l1().getBlockNumber();
  const logs = await l1().getLogs({ address: TK.l1Signal, event: evCheckpoint, fromBlock: tip - 2000n, toBlock: tip });
  const a = logs.at(-1)?.args;
  return a ? { block: BigInt(a.blockNumber), stateRoot: a.stateRoot } : null;
}, 5 * MIN);

// relayer rows (MessageSent events of the wallet) -> items, decoded from each row's raw log: ETH a message carries,
// and the token an ERC20Vault message pays out on Ethereum
function items(rows) {
  const out = [];
  for (const r of rows) {
    const raw = r?.data?.Raw;
    if (!raw?.topics || raw.address?.toLowerCase() !== TK.l2Bridge) continue;
    let a;
    try { a = decodeEventLog({ abi: [evMessageSent], data: raw.data, topics: raw.topics }).args; } catch { continue; }
    const m = a.message;
    if (m.destChainId !== 1n || m.srcChainId !== TK.chainId) continue;
    const base = { tx: raw.transactionHash, block: BigInt(raw.blockNumber), logIndex: Number(raw.logIndex), owner: m.destOwner, from: m.srcOwner, msgHash: a.msgHash, message: m };
    if (m.value > 0n) out.push({ ...base, asset: ETH, amount: m.value });
    const t = m.from.toLowerCase() === TK.l2Vault ? vaultTransfer(m.data) : null;
    if (t && t.amount > 0n) {
      const c = t.ctoken;
      // a token from Ethereum goes back to its own address; a Taiko token is paid as its bridged copy (looked up in status)
      out.push({ ...base, owner: t.to, asset: c.chainId === 1n ? { ...erc20("eth-mainnet", c.addr), symbol: c.symbol, decimals: c.decimals } : { kind: "erc20", network: "taiko-mainnet", address: getAddress(c.addr), canonical: c, symbol: c.symbol, decimals: c.decimals }, amount: t.amount });
    }
  }
  return out;
}
// ERC20Vault.onMessageInvocation(abi.encode(CanonicalERC20, from, to, amount)) -> its parts
function vaultTransfer(data) {
  try {
    if (data.slice(0, 10) !== encodeFunctionData({ abi: bridgeAbi, functionName: "onMessageInvocation", args: ["0x"] }).slice(0, 10)) return null;
    const [inner] = decodeAbiParameters([{ type: "bytes" }], `0x${data.slice(10)}`);
    const [ctoken, from, to, amount] = decodeAbiParameters(CANONICAL, inner);
    return { ctoken, from, to, amount };
  } catch { return null; }
}
// the signal slot of a message (SignalService.getSignalSlot) and the one-hop proof processMessage takes
const signalSlot = (msgHash) => keccak256(encodePacked(["string", "uint64", "address", "bytes32"], ["SIGNAL", TK.chainId, TK.l2Bridge, msgHash]));
const hopProof = (cp, p) => encodeAbiParameters(HOP, [[{ chainId: 1n, blockId: cp.block, rootHash: cp.stateRoot, cacheOption: 0, accountProof: p.accountProof, storageProof: p.storageProof[0].proof }]]);

// facts -> status (pure, for the tests): L1 status, bridge paused, latest checkpoint, the message's block and the
// simulated claim ({ status } it returns, or its revert text)
function classify({ l1Status, paused: p, checkpoint: cp, block, sim }) {
  const s = STATUS[l1Status] ?? `status ${l1Status}`;
  if (s === "DONE" || s === "RECALLED") return { status: "claimed" };
  if (p) return { status: "blocked", detail: "the Taiko bridge on Ethereum is paused" };
  if (s === "RETRIABLE") return { status: "claimable", detail: "the claim ran but its call failed: retry it (retryMessage) or let it fail and recall it on Taiko" };
  // not simulated: the recall proves the failure signal on Taiko
  if (s === "FAILED") return { status: "claimable", detail: "marked failed on Ethereum: recall it on Taiko to get it back there", claimChain: "taiko", confidence: "medium" };
  if (s !== "NEW") return { status: "unknown", detail: s };
  if (!cp || cp.block < block) return { status: "waiting", detail: "waiting for a Taiko checkpoint on Ethereum that covers its block" };
  if (sim?.status != null) return { status: "claimable", detail: `claim simulated (it would end ${STATUS[sim.status] ?? sim.status})` };
  return { status: "unknown", detail: `claim reverts: ${String(sim ?? "no simulation").split("\n")[0].slice(0, 160)}` };
}

const taikoBridge = {
  key: "taiko", name: "Taiko", scan: false,
  async find(user) {
    if (!user) return []; // no chain-wide scan: per-wallet only
    const rows = [];
    for (let page = 0; ; page++) {
      const r = await fetchJson(`${TK.relayer}/events?address=${user}&event=MessageSent&chainID=${TK.chainId}&page=${page}&size=100`);
      if (!r || !Array.isArray(r.items)) throw new Error("Taiko relayer API: no answer");
      rows.push(...r.items);
      if (r.last !== false || page + 1 >= (r.total_pages ?? 0)) break;
    }
    return items(rows);
  },
  async status(it) {
    it.time = await blockTime(taiko(), "taiko-public", it.block);
    if (it.asset.canonical) {
      const c = it.asset.canonical;
      const bridged = await read(vaultAbi, TK.l1Vault, "canonicalToBridged", [c.chainId, c.addr]).catch(() => null);
      it.asset = bridged && !/^0x0{40}$/i.test(bridged) ? { ...erc20("eth-mainnet", bridged), symbol: c.symbol, decimals: c.decimals } : { kind: "erc20", network: "taiko-mainnet", address: getAddress(c.addr), symbol: c.symbol, decimals: c.decimals };
    }
    const facts = { l1Status: await read(bridgeAbi, TK.l1Bridge, "messageStatus", [it.msgHash]), block: it.block };
    if (facts.l1Status !== 2 && facts.l1Status !== 4) {
      Object.assign(facts, { paused: await paused(), checkpoint: await checkpoint() });
      if (facts.l1Status === 0 && !facts.paused && facts.checkpoint && facts.checkpoint.block >= it.block) {
        try {
          const p = await taiko().getProof({ address: TK.l2Signal, storageKeys: [signalSlot(it.msgHash)], blockNumber: facts.checkpoint.block });
          const data = encodeFunctionData({ abi: bridgeAbi, functionName: "processMessage", args: [it.message, hopProof(facts.checkpoint, p)] });
          const r = await l1().call({ to: TK.l1Bridge, account: it.message.destOwner, data, gas: 10_000_000n });
          facts.sim = { status: decodeFunctionResult({ abi: bridgeAbi, functionName: "processMessage", data: r.data })[0] };
        } catch (e) { facts.sim = revertText(e); }
      }
    }
    Object.assign(it, classify(facts));
    it.action = it.claimChain === "taiko"
      ? "bridge.taiko.xyz > Transactions > Release (recallMessage on Taiko)"
      : "bridge.taiko.xyz > Transactions > Claim (processMessage on Ethereum with a proof against the latest checkpoint)";
    delete it.message;
    return it;
  },
};

export default taikoBridge;
export { TK as TAIKO, items, vaultTransfer, signalSlot, hopProof, classify };
