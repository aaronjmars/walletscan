// core.mjs - built-in bridges, the bridge registry, pricing and the per-wallet check, shared by the
// CLI (stuck.mjs) and the library (index.mjs). Importing it runs nothing but the bridges/*.mjs imports.
//
// Built in: OP Stack (base, optimism incl. pre-Bedrock, zora, ink, unichain, soneium, worldchain, shape,
// blast; mode, bob and dbk read through their public RPCs), arbitrum (Nitro), polygon (PoS), linea, zksync (Era), scroll.
// bridges/*.mjs: cctp, wormhole, wormhole-ntt, debridge, gnosis, starknet, starkex, ronin, sui, lisk, mantle, manta, opbnb, taiko, morph.
// Some modules keep an on-disk index (see cachePath in lib.mjs), built on first use, then updated incrementally.
// Statuses: claimable / ready-to-prove / ready-to-finalize = the owner can claim it now;
// blocked = stuck until the bridge team acts; waiting = still inside the bridge delay.

import {
  createPublicClient, http, parseAbi, parseAbiItem, formatUnits, keccak256,
  encodeFunctionData, decodeFunctionData, decodeEventLog, isAddress, getAddress, zeroAddress, pad, defineChain,
} from "viem";
import * as chains from "viem/chains";
import { readdirSync, readFileSync } from "node:fs";
import { llamaPrices, LLAMA } from "../keyless.mjs";
import {
  alchemyKey, needsKeyOf, DAY, MIN, now, rpcUrl, client, rpcClient, l1, RangeCapError, getLogsAll, transferTxs, logsFromTxs, blockTime, pool, memo, cachePath, saveJson, ctx, revertText, ETH, erc20, fetchJson,
} from "./lib.mjs";

// ---------- OP Stack ----------

const OP_CHAINS = {
  base: { name: "Base", chain: chains.base, net: "base-mainnet" },
  optimism: { name: "OP Mainnet", chain: chains.optimism, net: "opt-mainnet", bedrockBlock: 105235063n },
  zora: { name: "Zora", chain: chains.zora, net: "zora-mainnet" },
  ink: { name: "Ink", chain: chains.ink, net: "ink-mainnet" },
  unichain: { name: "Unichain", chain: chains.unichain, net: "unichain-mainnet" },
  soneium: { name: "Soneium", chain: chains.soneium, net: "soneium-mainnet" },
  // rpc: Alchemy caps these at 10k-block log ranges with no Transfers API; their public RPCs serve the whole range
  mode: { name: "Mode", chain: chains.mode, net: "mode-mainnet", rpc: "https://mainnet.mode.network", app: "app.mode.network bridge" },
  worldchain: { name: "World Chain", chain: chains.worldchain, net: "worldchain-mainnet" },
  shape: { name: "Shape", chain: chains.shape, net: "shape-mainnet" },
  blast: { name: "Blast", chain: chains.blast, net: "blast-mainnet", note: "modified portal: claim in the Blast bridge app" },
  // BOB: Kailua dispute games; viem's chain lacks the factory (superchain-registry configs/mainnet/bob.toml)
  bob: { name: "BOB", chain: { ...chains.bob, contracts: { ...chains.bob.contracts, disputeGameFactory: { 1: { address: "0x96123dbFC3253185B594c6a7472EE5A21E9B1079" } } } }, net: "bob-mainnet", rpc: "https://rpc.gobob.xyz", app: "app.gobob.xyz bridge", delay: "out the challenge window" },
  // DBK Chain: L2OutputOracle portal, 7-day window, no bridge app on file (l2beat/l2beat projects/dbk/discovered.json)
  dbk: {
    name: "DBK Chain", net: "dbk-public", rpc: "https://rpc.mainnet.dbkchain.io", app: "the OptimismPortal 0x63CA00232F471bE2A3Bf3C4e95Bc1d2B3EA5DB92 (no bridge app on file)",
    chain: defineChain({
      id: 20240603, name: "DBK Chain", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: ["https://rpc.mainnet.dbkchain.io"] } }, sourceId: 1,
      contracts: { portal: { 1: { address: "0x63CA00232F471bE2A3Bf3C4e95Bc1d2B3EA5DB92" } }, l2OutputOracle: { 1: { address: "0x0341bb689CB8a4c16c61307F4BdA254E1bFD525e" } } },
    }),
  },
};
const opClient = (cfg) => (cfg.rpc ? rpcClient(cfg.chain, cfg.rpc) : client(cfg.chain, cfg.net));
const OP_BRIDGE = "0x4200000000000000000000000000000000000010";
const OP_MESSENGER = "0x4200000000000000000000000000000000000007";
const OP_PASSER = "0x4200000000000000000000000000000000000016";
const OP_L1_MESSENGER = "0x25ace71c97B33Cc4729CF772ae268934F7ab5fA1"; // OP Mainnet L1CrossDomainMessenger
const evOpWithdrawal = parseAbiItem("event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)");
const evMessagePassed = parseAbiItem("event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)");
const evLegacySentMessage = parseAbiItem("event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)");
const legacyMessengerAbi = parseAbi([
  "function relayMessage(address target, address sender, bytes message, uint256 nonce)",
  "function relayMessage(uint256 nonce, address sender, address target, uint256 value, uint256 minGasLimit, bytes message)",
  "function successfulMessages(bytes32) view returns (bool)",
  "function finalizeETHWithdrawal(address from, address to, uint256 amount, bytes data)",
]);

function opBridge(key) {
  const cfg = OP_CHAINS[key];
  return {
    key, name: cfg.name, scan: true, scanOnly: cfg.scanOnly,
    async find(user, range) {
      const c = opClient(cfg);
      let bridgeLogs, direct;
      if (user) {
        try {
          const to = await c.getBlockNumber();
          const q = (address, event, args) => getLogsAll(c, { address, event, args }, 0n, to, { chunk: false });
          // Bridge withdrawals, and direct L2ToL1MessagePasser ones (not through the standard bridge), in parallel:
          // a public RPC takes seconds per whole-range query.
          let sent, got;
          [bridgeLogs, sent, got] = await Promise.all([q(OP_BRIDGE, evOpWithdrawal, { from: user }), q(OP_PASSER, evMessagePassed, { sender: user }), q(OP_PASSER, evMessagePassed, { target: user })]);
          direct = [...sent, ...got];
        } catch (e) {
          if (!(e instanceof RangeCapError)) throw e;
          // Chain caps log ranges at 10k blocks: find candidate txs with the Transfers API instead.
          // ETH goes to the bridge/messenger/passer predeploys; bridged tokens are burned or, if L2-native, locked in the bridge.
          const txs = [
            ...(await transferTxs(c, user, OP_BRIDGE, ["external", "erc20"])),
            ...(await transferTxs(c, user, OP_MESSENGER, ["external"])),
            ...(await transferTxs(c, user, OP_PASSER, ["external"])),
            ...(await transferTxs(c, user, zeroAddress, ["erc20"])),
          ].map((t) => t.hash);
          const logs = await logsFromTxs(c, txs, [{ address: OP_BRIDGE, event: evOpWithdrawal }, { address: OP_PASSER, event: evMessagePassed }]);
          bridgeLogs = logs.filter((l) => l.eventName === "WithdrawalInitiated" && getAddress(l.args.from) === user);
          direct = logs.filter((l) => l.eventName === "MessagePassed" && (getAddress(l.args.sender) === user || getAddress(l.args.target) === user));
        }
      } else {
        const [from, to] = range;
        bridgeLogs = await getLogsAll(c, { address: OP_BRIDGE, event: evOpWithdrawal }, from, to);
        direct = (await getLogsAll(c, { address: OP_PASSER, event: evMessagePassed }, from, to))
          .filter((l) => l.args.value > 0n && l.args.sender.toLowerCase() !== OP_MESSENGER);
      }
      const items = bridgeLogs.map((l) => ({
        tx: l.transactionHash, block: l.blockNumber, logIndex: l.logIndex,
        owner: l.args.to, from: l.args.from,
        asset: l.args.l1Token === zeroAddress ? ETH : erc20("eth-mainnet", l.args.l1Token),
        amount: l.args.amount,
      }));
      const seen = new Set();
      for (const l of direct) {
        const k = `${l.transactionHash}:${l.logIndex}`;
        if (seen.has(k) || l.args.value === 0n) continue;
        seen.add(k);
        items.push({ tx: l.transactionHash, block: l.blockNumber, logIndex: l.logIndex, owner: l.args.target, from: l.args.sender, asset: ETH, amount: l.args.value });
      }
      return items;
    },
    async status(it) {
      const c = opClient(cfg);
      const receipt = await c.getTransactionReceipt({ hash: it.tx });
      it.time = await blockTime(c, cfg.net, it.block);
      if (cfg.bedrockBlock && it.block < cfg.bedrockBlock) return legacyOpStatus(it, receipt);
      // The withdrawal for a bridge log is the first MessagePassed after it in the same receipt.
      const passerLogs = receipt.logs.filter((l) => l.address.toLowerCase() === OP_PASSER);
      const idx = Math.max(0, passerLogs.findIndex((l) => l.logIndex >= it.logIndex));
      try {
        const s = await l1().getWithdrawalStatus({ receipt, targetChain: cfg.chain, logIndex: idx });
        const map = { "ready-to-prove": "ready-to-prove", "ready-to-finalize": "ready-to-finalize", finalized: "claimed", "waiting-to-prove": "waiting", "waiting-to-finalize": "waiting" };
        it.status = map[s] ?? "unknown";
        if (it.status === "waiting") it.detail = s;
      } catch (e) {
        it.status = "unknown";
        it.detail = (e.shortMessage ?? e.message).split("\n")[0];
      }
      const step = it.status === "ready-to-prove" ? `prove on Ethereum, wait ${cfg.delay ?? "~7 days"}, then finalize` : "finalize on Ethereum";
      it.action = cfg.note ?? (cfg.app ? `${cfg.app}: ${step}` : `${cfg.name} official bridge (or Superbridge): ${step}`);
      return it;
    },
  };
}

// Pre-Bedrock OP Mainnet withdrawal: finalized if L1CrossDomainMessenger marked either the legacy
// (v0) hash or the hash the Bedrock migration relays it under (v1, value parsed, minGasLimit 0).
async function legacyOpStatus(it, receipt) {
  // The legacy messenger's SentMessage closest after the bridge log carries the message.
  let msg;
  for (const l of receipt.logs.filter((l) => l.address.toLowerCase() === OP_MESSENGER)) {
    try {
      msg = decodeEventLog({ abi: [evLegacySentMessage], data: l.data, topics: l.topics }).args;
      if (l.logIndex > it.logIndex) break;
    } catch {}
  }
  it.legacy = true;
  if (!msg) { it.status = "unknown"; it.detail = "pre-Bedrock: SentMessage not found"; return it; }
  const v0 = keccak256(encodeFunctionData({ abi: legacyMessengerAbi, functionName: "relayMessage", args: [msg.target, msg.sender, msg.message, msg.messageNonce] }));
  let value = 0n;
  try {
    const d = decodeFunctionData({ abi: legacyMessengerAbi, data: msg.message });
    if (d.functionName === "finalizeETHWithdrawal") value = d.args[2];
  } catch {}
  const v1 = keccak256(encodeFunctionData({ abi: legacyMessengerAbi, functionName: "relayMessage", args: [msg.messageNonce, msg.sender, msg.target, value, 0n, msg.message] }));
  const [a, b] = await Promise.all([v0, v1].map((h) => l1().readContract({ address: OP_L1_MESSENGER, abi: legacyMessengerAbi, functionName: "successfulMessages", args: [h] })));
  it.status = a || b ? "claimed" : "ready-to-prove";
  it.detail = "pre-Bedrock withdrawal";
  it.action = "Pre-Bedrock: not shown in bridge apps. Rebuild the migrated withdrawal, prove on OptimismPortal, finalize after ~7 days";
  return it;
}

// ---------- Arbitrum One (Nitro) ----------

const ARB = { chain: chains.arbitrum, net: "arb-mainnet", outbox: "0x0B9857ae2D4A3DBe74ffE1d7DF045bb7F96E4840", arbsys: "0x0000000000000000000000000000000000000064", nitroBlock: 22207817n };
const evL2ToL1Tx = parseAbiItem("event L2ToL1Tx(address caller, address indexed destination, uint256 indexed hash, uint256 indexed position, uint256 arbBlockNum, uint256 ethBlockNum, uint256 timestamp, uint256 callvalue, bytes data)");
const evArbWithdrawal = parseAbiItem("event WithdrawalInitiated(address l1Token, address indexed _from, address indexed _to, uint256 indexed _l2ToL1Id, uint256 _exitNum, uint256 _amount)");
const outboxAbi = parseAbi(["function isSpent(uint256 index) view returns (bool)"]);
const ARB_CONFIRM_AGE = 8 * DAY; // ~6.4 day challenge period plus assertion cadence

const arbitrum = {
  key: "arbitrum", name: "Arbitrum One", scan: true,
  async find(user, range) {
    const c = client(ARB.chain, ARB.net);
    const [from0, to] = range ?? [0n, await c.getBlockNumber()];
    const from = from0 < ARB.nitroBlock ? ARB.nitroBlock : from0;
    const ethLogs = await getLogsAll(c, { address: ARB.arbsys, event: evL2ToL1Tx, args: user ? { destination: user } : undefined }, from, to);
    const items = ethLogs
      .filter((l) => l.args.callvalue > 0n && l.args.data === "0x")
      .map((l) => ({ tx: l.transactionHash, block: l.blockNumber, time: Number(l.args.timestamp), owner: l.args.destination, position: l.args.position, asset: ETH, amount: l.args.callvalue }));
    // Token gateways (router, standard, custom, WETH...) all emit the same event. Only keep it
    // when the receipt has an ArbSys L2ToL1Tx at the same position, so look-alike events drop out.
    const tokenLogs = await getLogsAll(c, { event: evArbWithdrawal, args: user ? { _from: user } : undefined }, from, to);
    for (const l of tokenLogs) {
      items.push({ tx: l.transactionHash, block: l.blockNumber, owner: l.args._to, from: l.args._from, position: l.args._l2ToL1Id, asset: erc20("eth-mainnet", l.args.l1Token), amount: l.args._amount, verify: true });
    }
    return items;
  },
  async status(it) {
    const c = client(ARB.chain, ARB.net);
    if (it.verify) {
      const r = await c.getTransactionReceipt({ hash: it.tx });
      const ok = r.logs.some((l) => l.address.toLowerCase() === ARB.arbsys && BigInt(l.topics[3] ?? 0) === it.position);
      if (!ok) { it.status = "ignore"; return it; }
      it.time = await blockTime(c, ARB.net, it.block);
    }
    const spent = await l1().readContract({ address: ARB.outbox, abi: outboxAbi, functionName: "isSpent", args: [it.position] });
    it.status = spent ? "claimed" : now() - it.time > ARB_CONFIRM_AGE ? "claimable" : "waiting";
    it.detail = `outbox index ${it.position}`;
    it.action = "bridge.arbitrum.io > Transaction history > Claim (Outbox.executeTransaction on Ethereum)";
    return it;
  },
};

// ---------- Polygon PoS ----------

const POLY = { chain: chains.polygon, net: "polygon-mainnet", rcm: "0xA0c68C638235ee32657e8f720a23ceC1bFc77C77" };
const TRANSFER_SIG = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const rcmAbi = parseAbi(["function exit(bytes inputData)", "function childToRootToken(address) view returns (address)"]);
const isMapped = memo((child) => l1().readContract({ address: POLY.rcm, abi: rcmAbi, functionName: "childToRootToken", args: [child] }).then((r) => r !== zeroAddress), 60 * MIN);

const polygon = {
  key: "polygon", name: "Polygon PoS", scan: false,
  async find(user) {
    const c = client(POLY.chain, POLY.net);
    const transfers = [];
    let pageKey;
    do {
      const r = await c.request({ method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", fromAddress: user, toAddress: zeroAddress, category: ["erc20"], withMetadata: true, excludeZeroValue: true, maxCount: "0x3e8", ...(pageKey ? { pageKey } : {}) }] });
      transfers.push(...r.transfers);
      pageKey = r.pageKey;
    } while (pageKey);
    const perTx = new Map();
    return transfers.map((t) => {
      const n = perTx.get(t.hash) ?? 0;
      perTx.set(t.hash, n + 1);
      return {
        tx: t.hash, block: BigInt(t.blockNum), time: Math.floor(Date.parse(t.metadata.blockTimestamp) / 1000), owner: user, tokenIndex: n,
        asset: { ...erc20("polygon-mainnet", t.rawContract.address), symbol: t.asset, decimals: Number(t.rawContract.decimal ?? 18) },
        amount: BigInt(t.rawContract.value),
      };
    });
  },
  async status(it) {
    // Burns of tokens the PoS bridge does not know are not withdrawals: skip the slow proof API.
    if (!(await isMapped(it.asset.address))) { it.status = "ignore"; return it; }
    const url = `https://proof-generator.polygon.technology/api/v1/matic/exit-payload/${it.tx}?eventSignature=${TRANSFER_SIG}${it.tokenIndex ? `&tokenIndex=${it.tokenIndex}` : ""}`;
    const res = await fetchJson(url);
    if (!res?.result) {
      const m = res?.message ?? "proof API error";
      it.status = /checkpoint/i.test(m) ? "waiting" : "ignore";
      it.detail = m;
      return it;
    }
    // Simulate the exit on Ethereum. Success means claimable; "already processed" means claimed.
    try {
      await l1().call({ to: POLY.rcm, account: it.owner, data: encodeFunctionData({ abi: rcmAbi, functionName: "exit", args: [res.result] }) });
      it.status = "claimable";
    } catch (e) {
      const t = revertText(e);
      // EXIT_DISABLED: the bridge turned exits off for this token, only the Polygon team can unblock it.
      it.status = /ALREADY_PROCESSED/.test(t) ? "claimed" : /EXIT_DISABLED/.test(t) ? "blocked" : "ignore";
      it.detail = t.match(/(RootChainManager: [A-Z_]+)/)?.[1] ?? t.match(/reason:\s*([^\n]+)/)?.[1] ?? "exit reverts";
    }
    it.payload = res.result;
    it.action = "portal.polygon.technology > Claim, or RootChainManager.exit(payload) on Ethereum";
    return it;
  },
};

// ---------- Linea ----------

const LINEA = { chain: chains.linea, net: "linea-mainnet", msgService: "0x508Ca82Df566dCD1B0DE8296e70a96332cD644ec", tokenBridge: "0x353012dc4a9A6cF55c941bADC267f82004A8ceB9", rollup: "0xd19d4B5d358258f05D7B411E21A1460D11B0876F" };
const evMessageSent = parseAbiItem("event MessageSent(address indexed _from, address indexed _to, uint256 _fee, uint256 _value, uint256 _nonce, bytes _calldata, bytes32 indexed _messageHash)");
const evBridgingV1 = parseAbiItem("event BridgingInitiated(address indexed sender, address recipient, address indexed token, uint256 indexed amount)");
const evBridgingV2 = parseAbiItem("event BridgingInitiatedV2(address indexed sender, address indexed recipient, address indexed token, uint256 amount)");
const lineaRollupAbi = parseAbi([
  "function currentL2BlockNumber() view returns (uint256)",
  "function isMessageClaimed(uint256 messageNumber) view returns (bool)",
  "function inboxL2L1MessageStatus(bytes32) view returns (uint256)",
  "function systemMigrationBlock() view returns (uint256)",
]);
// The finalized L2 block moves: refresh it every few minutes in a long-lived process.
const lineaL1State = memo(async () => {
  const r = (fn) => l1().readContract({ address: LINEA.rollup, abi: lineaRollupAbi, functionName: fn });
  const [finalized, migrationBlock] = await Promise.all([r("currentL2BlockNumber"), r("systemMigrationBlock")]);
  const migrationTime = Number((await l1().getBlock({ blockNumber: migrationBlock })).timestamp);
  return { finalized, migrationTime };
}, 5 * MIN);

const linea = {
  key: "linea", name: "Linea", scan: true,
  async find(user, range) {
    const c = client(LINEA.chain, LINEA.net);
    let ethLogs, tokenLogs;
    if (user) {
      // ETH: value sent straight to the message service. Tokens: locked in the token bridge or burned.
      const txs = [
        ...(await transferTxs(c, user, LINEA.msgService, ["external"])),
        ...(await transferTxs(c, user, LINEA.tokenBridge, ["erc20"])),
        ...(await transferTxs(c, user, zeroAddress, ["erc20"])),
      ].map((t) => t.hash);
      const logs = await logsFromTxs(c, txs, [{ address: LINEA.msgService, event: evMessageSent }, { address: LINEA.tokenBridge, event: evBridgingV1 }, { address: LINEA.tokenBridge, event: evBridgingV2 }]);
      ethLogs = logs.filter((l) => l.eventName === "MessageSent" && getAddress(l.args._from) === user);
      tokenLogs = logs.filter((l) => l.eventName.startsWith("BridgingInitiated") && getAddress(l.args.sender) === user);
    } else {
      const [from, to] = range;
      ethLogs = await getLogsAll(c, { address: LINEA.msgService, event: evMessageSent }, from, to);
      tokenLogs = [
        ...(await getLogsAll(c, { address: LINEA.tokenBridge, event: evBridgingV1 }, from, to)),
        ...(await getLogsAll(c, { address: LINEA.tokenBridge, event: evBridgingV2 }, from, to)),
      ];
    }
    const items = ethLogs.filter((l) => l.args._value > 0n).map((l) => ({
      tx: l.transactionHash, block: l.blockNumber, owner: l.args._to, from: l.args._from, asset: ETH, amount: l.args._value,
      nonce: l.args._nonce, hash: l.args._messageHash, fee: l.args._fee,
    }));
    for (const l of tokenLogs) {
      items.push({ tx: l.transactionHash, block: l.blockNumber, logIndex: l.logIndex, owner: l.args.recipient, from: l.args.sender, asset: erc20("linea-mainnet", l.args.token), amount: l.args.amount, needMessage: true });
    }
    return items;
  },
  async status(it) {
    const c = client(LINEA.chain, LINEA.net);
    it.time = await blockTime(c, LINEA.net, it.block);
    if (it.needMessage) {
      const r = await c.getTransactionReceipt({ hash: it.tx });
      // The bridge emits MessageSent just before BridgingInitiated: take the closest one before it.
      const m = r.logs.filter((l) => l.address.toLowerCase() === LINEA.msgService.toLowerCase() && l.logIndex < it.logIndex)
        .map((l) => { try { return decodeEventLog({ abi: [evMessageSent], data: l.data, topics: l.topics }).args; } catch { return null; } })
        .filter((a) => a && a._from.toLowerCase() === LINEA.tokenBridge.toLowerCase())
        .at(-1);
      if (!m) { it.status = "unknown"; it.detail = "MessageSent not found"; return it; }
      Object.assign(it, { nonce: m._nonce, hash: m._messageHash, fee: m._fee });
    }
    const { finalized, migrationTime } = await lineaL1State();
    const read = (fn, args) => l1().readContract({ address: LINEA.rollup, abi: lineaRollupAbi, functionName: fn, args });
    if (it.time < migrationTime) {
      // Pre-migration messages live in the legacy status map; 1 = delivered and unclaimed, claim deletes it.
      const s = await read("inboxL2L1MessageStatus", [it.hash]);
      it.status = s === 1n ? "claimable" : "claimed";
      it.detail = "legacy message (claimMessage, no proof)";
    } else if (await read("isMessageClaimed", [it.nonce])) {
      it.status = "claimed";
    } else {
      it.status = it.block <= finalized ? "claimable" : "waiting";
      it.detail = `nonce ${it.nonce}${it.fee === 0n ? ", sent without relay fee" : ""}`;
    }
    it.action = "linea.build bridge > history > Claim, or claimMessageWithProof on LineaRollup (Linea SDK)";
    return it;
  },
};

// ---------- zkSync Era ----------

const ZK = {
  chain: chains.zksync, net: "zksync-mainnet", chainId: 324n,
  baseToken: "0x000000000000000000000000000000000000800a", messenger: "0x0000000000000000000000000000000000008008",
  nullifier: "0xD7f9f54194C633F36CCD5F3da84ad4a1c38cB2cB", diamond: "0x32400084C286CF3E17e7B677ea9583e60a000324", legacyErc20: "0x57891966931Eb4Bb6FB81430E6cE0A03AAbDe063",
};
const evZkEth = parseAbiItem("event Withdrawal(address indexed _l2Sender, address indexed _l1Receiver, uint256 _amount)");
const evZkErc20 = parseAbiItem("event WithdrawalInitiated(address indexed l2Sender, address indexed l1Receiver, address indexed l2Token, uint256 amount)");
const zkL1Abi = parseAbi([
  "function isWithdrawalFinalized(uint256 chainId, uint256 batch, uint256 index) view returns (bool)",
  "function isEthWithdrawalFinalized(uint256 batch, uint256 index) view returns (bool)",
  "function isWithdrawalFinalized(uint256 batch, uint256 index) view returns (bool)",
]);

const zksync = {
  key: "zksync", name: "ZKsync Era", scan: true,
  async find(user, range) {
    const c = client(ZK.chain, ZK.net);
    let ethLogs, tokLogs;
    if (user) {
      // ETH: value sent to L2BaseToken.withdraw. Tokens: bridged tokens are burned (Transfer to 0x0).
      const txs = [...(await transferTxs(c, user, ZK.baseToken, ["external"])), ...(await transferTxs(c, user, zeroAddress, ["erc20"]))].map((t) => t.hash);
      const logs = await logsFromTxs(c, txs, [{ address: ZK.baseToken, event: evZkEth }, { event: evZkErc20 }]);
      ethLogs = logs.filter((l) => l.eventName === "Withdrawal" && getAddress(l.args._l2Sender) === user);
      tokLogs = logs.filter((l) => l.eventName === "WithdrawalInitiated" && getAddress(l.args.l2Sender) === user);
    } else {
      const [from, to] = range;
      ethLogs = await getLogsAll(c, { address: ZK.baseToken, event: evZkEth }, from, to);
      tokLogs = await getLogsAll(c, { event: evZkErc20 }, from, to);
    }
    return [
      ...ethLogs.map((l) => ({ tx: l.transactionHash, block: l.blockNumber, owner: l.args._l1Receiver, from: l.args._l2Sender, asset: ETH, amount: l.args._amount, emitter: l.address })),
      ...tokLogs.map((l) => ({ tx: l.transactionHash, block: l.blockNumber, owner: l.args.l1Receiver, from: l.args.l2Sender, asset: erc20("zksync-mainnet", l.args.l2Token), amount: l.args.amount, emitter: l.address })),
    ].filter((i) => i.amount > 0n);
  },
  async status(it) {
    const c = client(ZK.chain, ZK.net);
    it.time = await blockTime(c, ZK.net, it.block);
    const r = await c.request({ method: "eth_getTransactionReceipt", params: [it.tx] });
    const key = pad(it.emitter.toLowerCase(), { size: 32 });
    const idx = (r.l2ToL1Logs ?? []).findIndex((l) => l.sender.toLowerCase() === ZK.messenger && l.key.toLowerCase() === key);
    if (idx < 0 || r.l1BatchNumber == null) { it.status = "waiting"; it.detail = "batch not sealed"; return it; }
    const proof = await c.request({ method: "zks_getL2ToL1LogProof", params: [it.tx, idx] });
    if (!proof) { it.status = "waiting"; it.detail = "batch not final on Ethereum"; return it; }
    const batch = BigInt(r.l1BatchNumber), id = BigInt(proof.id);
    const read = (address, fn, args) => l1().readContract({ address, abi: zkL1Abi, functionName: fn, args }).catch(() => false);
    const done = (await read(ZK.nullifier, "isWithdrawalFinalized", [ZK.chainId, batch, id]))
      || (it.asset.kind === "native"
        ? await read(ZK.diamond, "isEthWithdrawalFinalized", [batch, id])
        : await read(ZK.legacyErc20, "isWithdrawalFinalized", [batch, id]));
    it.status = done ? "claimed" : "claimable";
    it.detail = `batch ${batch} msg ${id}`;
    it.action = "portal.zksync.io > withdrawals > Claim, or zksync-ethers wallet.finalizeWithdrawal(tx)";
    return it;
  },
};

// ---------- Scroll (official bridge API) ----------

const scroll = {
  key: "scroll", name: "Scroll", scan: false,
  async find(user) {
    const items = [];
    for (let page = 1; ; page++) {
      const r = await fetchJson(`https://mainnet-api-bridge-v2.scroll.io/api/l2/unclaimed/withdrawals?address=${user}&page=${page}&page_size=100`);
      const rows = r?.data?.results ?? [];
      for (const w of rows) {
        const token = w.l1_token_address && w.l1_token_address !== zeroAddress ? erc20("eth-mainnet", w.l1_token_address) : ETH;
        const amount = BigInt(w.token_amounts?.[0] ?? w.token_amount ?? 0);
        items.push({ tx: w.hash, block: BigInt(w.block_number ?? 0), time: Number(w.block_timestamp ?? 0), owner: w.claim_info?.to ?? user, asset: token, amount, raw: w });
      }
      if (rows.length < 100) break;
    }
    return items;
  },
  async status(it) {
    it.status = it.raw?.claim_info?.claimable === false ? "waiting" : "claimable";
    it.action = "scroll.io/bridge > history > Claim, or L1ScrollMessenger.relayMessageWithProof";
    delete it.raw;
    return it;
  },
};

// ---------- registry ----------

// Extra bridges live in bridges/*.mjs: each default-exports one bridge object or an array of them.
const pluginDir = new URL("./bridges/", import.meta.url);
const plugins = [];
for (const f of (() => { try { return readdirSync(pluginDir).filter((x) => x.endsWith(".mjs")).sort(); } catch { return []; } })()) {
  const m = await import(new URL(f, pluginDir));
  plugins.push(...[m.default].flat());
}
const BRIDGES = Object.fromEntries([...Object.keys(OP_CHAINS).map(opBridge), arbitrum, polygon, linea, zksync, scroll, ...plugins].map((b) => [b.key, b]));

// ---------- pricing (Alchemy Prices + token metadata) ----------

async function enrich(items) {
  const meta = new Map();
  const tokens = [...new Map(items.filter((i) => i.asset.kind === "erc20").map((i) => [`${i.asset.network}:${i.asset.address}`, i.asset])).values()];
  await pool(tokens, 6, async (t) => {
    if (t.symbol && t.decimals != null) return meta.set(`${t.network}:${t.address}`, { symbol: t.symbol, decimals: t.decimals });
    const c = alchemyKey() ? createPublicClient({ transport: http(rpcUrl(t.network), { retryCount: 3 }) }) : client(undefined, t.network);
    const m = await c.request({ method: "alchemy_getTokenMetadata", params: [t.address] }).catch(() => null);
    meta.set(`${t.network}:${t.address}`, { symbol: m?.symbol ?? "?", decimals: m?.decimals ?? 18 });
  });
  const prices = new Map();
  if (!alchemyKey()) return priceKeyless(items, meta);
  for (let i = 0; i < tokens.length; i += 25) {
    const body = { addresses: tokens.slice(i, i + 25).map((t) => ({ network: t.network, address: t.address })) };
    const r = await fetch(`https://api.g.alchemy.com/prices/v1/${alchemyKey()}/tokens/by-address`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((x) => x.json()).catch(() => null);
    for (const d of r?.data ?? []) {
      const p = d.prices?.find((x) => x.currency === "usd");
      if (p) prices.set(`${d.network}:${getAddress(d.address)}`, Number(p.value));
    }
  }
  // Tokens the Prices API has no address entry for (common on L2s): fall back to a symbol lookup.
  const bySymbol = new Map();
  // native coins: ETH, and BNB for opBNB withdrawals
  const symbols = [...new Set(["ETH", ...items.filter((i) => i.asset.kind === "native").map((i) => i.asset.symbol), ...tokens.filter((t) => !prices.has(`${t.network}:${t.address}`)).map((t) => meta.get(`${t.network}:${t.address}`).symbol).filter((x) => /^[A-Za-z0-9.]{1,12}$/.test(x))])];
  for (let i = 0; i < symbols.length; i += 25) {
    const q = symbols.slice(i, i + 25).map((x) => `symbols=${encodeURIComponent(x)}`).join("&");
    const r = await fetch(`https://api.g.alchemy.com/prices/v1/${alchemyKey()}/tokens/by-symbol?${q}`).then((x) => x.json()).catch(() => null);
    for (const d of r?.data ?? []) {
      const p = d.prices?.find((x) => x.currency === "usd");
      if (p) bySymbol.set(d.symbol, Number(p.value));
    }
  }
  const eth = bySymbol.get("ETH") ?? 0;
  for (const it of items) {
    const k = `${it.asset.network}:${it.asset.address}`;
    const m = it.asset.kind === "native" ? { ...ETH, ...it.asset } : meta.get(k);
    it.symbol = m.symbol;
    it.value = Number(formatUnits(it.amount, m.decimals));
    const px = it.asset.kind === "native" ? (m.symbol === "ETH" ? eth : bySymbol.get(m.symbol)) : prices.get(k) ?? bySymbol.get(m.symbol);
    it.usd = px ? it.value * px : null;
  }
}

// No key: DefiLlama prices by address, native coins by their CoinGecko id (a thin market is no price)
const NATIVE_IDS = { ETH: "coingecko:ethereum", BNB: "coingecko:binancecoin", MNT: "coingecko:mantle", POL: "coingecko:polygon-ecosystem-token", MATIC: "coingecko:polygon-ecosystem-token", XDAI: "coingecko:xdai" };
async function priceKeyless(items, meta) {
  const keyOf = (it) => (it.asset.kind === "native" ? NATIVE_IDS[{ ...ETH, ...it.asset }.symbol] : LLAMA[it.asset.network] && `${LLAMA[it.asset.network]}:${it.asset.address}`);
  const px = await llamaPrices(items.map(keyOf));
  for (const it of items) {
    const m = it.asset.kind === "native" ? { ...ETH, ...it.asset } : meta.get(`${it.asset.network}:${it.asset.address}`);
    it.symbol = m.symbol;
    it.value = Number(formatUnits(it.amount, m.decimals));
    const p = px.get(String(keyOf(it) || "").toLowerCase())?.price;
    it.usd = p ? it.value * p : null;
  }
}

// ---------- check ----------

// No key: a bridge that needed one as a whole is noted on disk, so later keyless runs skip it at once instead of
// rebuilding an index that fails the same way (Ronin, Starknet: minutes of public RPC calls each run). A week, then retried.
const SKIPS = "keyless-skips.json", SKIP_MS = 7 * DAY * 1000;
const readSkips = () => { try { return JSON.parse(readFileSync(cachePath(SKIPS), "utf8")); } catch { return {}; } };
function keylessSkip(key) {
  if (alchemyKey()) return null;
  const s = readSkips()[key];
  return s && Date.now() - s.at < SKIP_MS ? s : null;
}
function noteKeylessSkip(key, nk) {
  if (alchemyKey()) return;
  try { saveJson(cachePath(SKIPS), { ...readSkips(), [key]: { needs_key: nk.needs_key, why: nk.why, at: Date.now() } }); } catch {}
}
const skipError = (key, s) => ({ bridge: key, error: `${s.why}: no keyless source, needs ${s.needs_key}`, needs_key: s.needs_key, why: s.why, whole: true });

// Partial failures (warn) and whole-bridge failures land in errors when given, else on stderr.
async function runBridge(b, user, range, errors) {
  const skip = keylessSkip(b.key);
  if (skip) { errors?.push(skipError(b.key, skip)); return []; }
  return ctx.run({ bridge: b.key, errors }, async () => {
    try {
      const found = await b.find(user, range);
      const done = await pool(found, 6, (it) => b.status(it).catch((e) => Object.assign(it, { status: "unknown", detail: (e.shortMessage ?? e.message).split("\n")[0] })));
      return done.filter((i) => i.status !== "ignore").map((i) => ({ bridge: b.name, ...i }));
    } catch (e) {
      const nk = needsKeyOf(e); // no key and no keyless source for a part this bridge needs: skipped, not failed
      if (nk) noteKeylessSkip(b.key, nk);
      const msg = nk ? nk.message : (e.shortMessage ?? e.message).split("\n")[0];
      if (errors) errors.push({ bridge: b.key, error: msg, ...(nk && { needs_key: nk.needs_key, why: nk.why, whole: true }) });
      else console.error(`! ${b.name}: ${msg}`);
      return [];
    }
  });
}

// One wallet (checksummed) on the given bridges, not yet priced.
async function checkAddress(user, bridges, errors) {
  const per = (await Promise.all(bridges.map((b) => runBridge(b, user, undefined, errors)))).flat();
  // A withdrawal sent to someone else still belongs to its recipient; keep it but say so.
  for (const i of per) if (i.owner && (!isAddress(i.owner) || getAddress(i.owner) !== user)) i.detail = `${i.detail ? `${i.detail}; ` : ""}recipient is ${i.owner}`;
  return per;
}

// Plain JSON-safe items: internal fields dropped, BigInts as strings (what --json prints).
const toJson = (items) => JSON.parse(JSON.stringify(items.map(({ payload, verify, needMessage, emitter, logIndex, ...i }) => i), (_, v) => (typeof v === "bigint" ? v.toString() : v)));

// ---------- scan ----------

// Chain whose blocks a scan range counts in.
const scanChainOf = (b) => b.scanChain ?? OP_CHAINS[b.key] ?? { arbitrum: ARB, linea: LINEA, zksync: ZK }[b.key];
// Its client: the chain's public RPC when it has one (Mode, BOB, DBK), else Alchemy.
const scanClient = (b) => opClient(scanChainOf(b));

async function blockAtAgo(c, seconds) {
  const latest = await c.getBlock();
  const span = 100_000n > latest.number ? latest.number : 100_000n;
  const past = await c.getBlock({ blockNumber: latest.number - span });
  const bt = Number(latest.timestamp - past.timestamp) / Number(span);
  const back = BigInt(Math.floor(seconds / bt));
  return [back > latest.number ? 0n : latest.number - back, latest.number];
}

export { BRIDGES, enrich, runBridge, checkAddress, toJson, scanChainOf, scanClient, blockAtAgo, keylessSkip, noteKeylessSkip, skipError };
