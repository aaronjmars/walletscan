// opBNB -> BNB Chain withdrawals (OP Stack with BNB Chain as L1: OptimismPortal 1.6 on an L2OutputOracle, 7-day
// window, BNB as the native coin). Two things differ from the built-in OP Stack bridges:
// - finding: Alchemy needs opBNB enabled and caps logs at 10k blocks (200M blocks), the public RPC at 50k, so a wallet's
//   unfinalized withdrawals come from NodeReal's opBNB explorer API (keyless; what opbnb-bridge.bnbchain.org lists),
//   then each tx is read back on the public RPC (bridge WithdrawalInitiated, direct L2ToL1MessagePasser sends);
// - L1: prove and finalize happen on BNB Chain: its portal and L2OutputOracle (portal 1.6, before dispute games) are
//   read on its public RPC with the shared reader in lib.mjs (classifyL2oo); a BNB withdrawal pays BNB, a token one its
//   BNB Chain address.
// Coverage (2026-10-22): over 7 sampled windows of the chain's bridge logs (1,101 withdrawals, 46 senders) every
// unfinalized withdrawal was listed under the account that sent the tx, and none of the finalized ones were.
// L1 contracts: viem chains.opBNB, verified on BscScan.
import { parseAbi, parseAbiItem, decodeEventLog, getAddress, zeroAddress } from "viem";
import * as chains from "viem/chains";
import { getWithdrawals } from "viem/op-stack";
import { now, rpcClient, blockTime, memo, pool, warn, erc20, fetchJson, l2ooSettings, l2ooFacts, classifyL2oo } from "../lib.mjs";

const OB = {
  rpc: "https://opbnb-mainnet-rpc.bnbchain.org", l1Rpc: "https://bsc-dataseed.bnbchain.org", api: "https://op-bnb-mainnet-explorer-api.nodereal.io/api",
  portal: "0x1876EA7702C0ad0C6A2ae6036DE7733edfBca519", oracle: "0x153CAB79f4767E2ff862C94aa49573294B13D169",
  bridge: "0x4200000000000000000000000000000000000010", messenger: "0x4200000000000000000000000000000000000007", passer: "0x4200000000000000000000000000000000000016",
};
const MAX_TXS = 200;
const BNB = { kind: "native", symbol: "BNB", decimals: 18 };
const evWithdrawal = parseAbiItem("event WithdrawalInitiated(address indexed l1Token, address indexed l2Token, address indexed from, address to, uint256 amount, bytes extraData)");
const evMessagePassed = parseAbiItem("event MessagePassed(uint256 indexed nonce, address indexed sender, address indexed target, uint256 value, uint256 gasLimit, bytes data, bytes32 withdrawalHash)");
const erc20Abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const opbnb = () => rpcClient(chains.opBNB, OB.rpc);
const bsc = () => rpcClient(chains.bsc, OB.l1Rpc);
// the L2 token's symbol and decimals (the BNB Chain token has the same): read once per token
const tokenMeta = memo(async (l2Token) => {
  const [symbol, decimals] = await Promise.all(["symbol", "decimals"].map((functionName) => opbnb().readContract({ address: l2Token, abi: erc20Abi, functionName })));
  return { symbol, decimals: Number(decimals) };
});

// one receipt's withdrawals that involve the wallet -> stuck items (tokens without symbol yet)
function items(logs, user, tx, block) {
  const me = user.toLowerCase(), out = [];
  for (const l of logs) {
    const at = l.address.toLowerCase();
    if (at === OB.bridge) {
      const a = decode(evWithdrawal, l);
      if (!a || a.amount === 0n || (a.from.toLowerCase() !== me && a.to.toLowerCase() !== me)) continue;
      out.push({ tx, block, logIndex: Number(l.logIndex), owner: getAddress(a.to), from: getAddress(a.from), l2Token: a.l2Token, asset: a.l1Token === zeroAddress ? BNB : erc20("bnb-mainnet", a.l1Token), amount: a.amount });
    } else if (at === OB.passer) {
      // BNB sent straight through the message passer (the bridge's own messages come from the messenger)
      const a = decode(evMessagePassed, l);
      if (!a || a.value === 0n || a.sender.toLowerCase() === OB.messenger || (a.sender.toLowerCase() !== me && a.target.toLowerCase() !== me)) continue;
      out.push({ tx, block, logIndex: Number(l.logIndex), owner: getAddress(a.target), from: getAddress(a.sender), asset: BNB, amount: a.value });
    }
  }
  return out;
}
const decode = (event, l) => { try { return decodeEventLog({ abi: [event], data: l.data, topics: l.topics }).args; } catch { return null; } };

const opbnbBridge = {
  key: "opbnb", name: "opBNB", scan: false,
  async find(user) {
    if (!user) return []; // no chain-wide scan: per-wallet only
    // getOngoingWithdrawByAddress: the wallet's withdrawals not finalized yet, what the bridge app's History shows
    // (getAssetTransferByAddress caps at 500 rows and keeps finished ones); 1,000 per page, lastID as the cursor
    const rows = [];
    for (let lastID = "", n = 0; n < 20; n++) {
      const r = await fetchJson(`${OB.api}/tx/getOngoingWithdrawByAddress?address=${user}&maxCount=0x3e8${lastID ? `&lastID=${encodeURIComponent(lastID)}` : ""}`);
      if (r?.code !== 0) throw new Error(`opBNB explorer API: ${r?.msg ?? "no answer"}`);
      rows.push(...(r.data?.transfers ?? []));
      lastID = r.data?.lastID ?? "";
      if (!lastID || !r.data?.transfers?.length) break;
    }
    // a bot wallet can hold hundreds of dust withdrawals: read the newest MAX_TXS, say how many were left out
    const all = [...new Map(rows.map((x) => [x.hash, x])).values()].sort((x, y) => Number(y.blockTimeStamp) - Number(x.blockTimeStamp));
    const txs = all.slice(0, MAX_TXS);
    if (all.length > MAX_TXS) warn(`opBNB: ${all.length} unfinalized withdrawals, only the newest ${MAX_TXS} checked`);
    const out = (await pool(txs, 6, async (x) => {
      const receipt = await opbnb().getTransactionReceipt({ hash: x.hash });
      if (receipt.status !== "success") return [];
      return items(receipt.logs, user, x.hash, receipt.blockNumber).map((it) => ({ ...it, time: Number(x.blockTimeStamp) || undefined, receiptLogs: receipt.logs }));
    })).flat();
    return out;
  },
  async status(it) {
    const cached = it.receiptLogs;
    delete it.receiptLogs;
    if (it.l2Token && it.asset.kind === "erc20") it.asset = { ...it.asset, ...(await tokenMeta(it.l2Token)) };
    delete it.l2Token;
    it.time ??= await blockTime(opbnb(), "opbnb-public", it.block);
    const logs = cached ?? (await opbnb().getTransactionReceipt({ hash: it.tx })).logs;
    // the withdrawal of a bridge log is the first MessagePassed at or after it in the same receipt
    const passed = logs.filter((l) => l.address.toLowerCase() === OB.passer);
    const idx = Math.max(0, passed.findIndex((l) => l.logIndex >= it.logIndex));
    const w = getWithdrawals({ logs })[idx];
    if (!w) { it.status = "unknown"; it.detail = "MessagePassed not found"; return it; }
    it.withdrawalHash = w.withdrawalHash;
    const [f, s] = await Promise.all([l2ooFacts(OB.portal, OB.oracle, w.withdrawalHash, bsc()), l2ooSettings(OB.portal, OB.oracle, bsc())]);
    Object.assign(it, classifyL2oo(f, s, it.block, now()));
    it.claimChain = "bsc";
    it.action = `opbnb-bridge.bnbchain.org > History: ${it.status === "ready-to-prove" ? "prove on BNB Chain, wait 7 days, then finalize" : "finalize on BNB Chain"}`;
    return it;
  },
};

export default opbnbBridge;
export { OB as OPBNB, BNB, items };
