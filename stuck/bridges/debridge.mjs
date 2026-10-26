// deBridge DLN: cross-chain orders the user made that no taker filled, so the funds sit in DlnSource
// until the order authority cancels on the destination chain and the refund is claimed on the source.
import { parseAbi, parseAbiItem, getAddress, zeroAddress } from "viem";
import * as chains from "viem/chains";
import { DAY, now, client, logsFromTxs, ETH } from "../lib.mjs";

const API = "https://stats-api.dln.trade/api/Orders";
const SRC = "0xeF4fB24aD0916217251F553c0596F8Edc630EB66"; // DlnSource, same address on every EVM chain but Abstract
const DST = "0xE7351Fd770A37282b91D153Ee690B63579D6dd7f"; // DlnDestination
const SOLANA = 7565164;
// deBridge chain id -> Alchemy network. Chains added after 2024 use deBridge-internal 1000000xx ids.
const CHAINS = {
  1: { name: "Ethereum", chain: chains.mainnet, net: "eth-mainnet" },
  10: { name: "Optimism", chain: chains.optimism, net: "opt-mainnet" },
  56: { name: "BNB Chain", chain: chains.bsc, net: "bnb-mainnet" },
  137: { name: "Polygon", chain: chains.polygon, net: "polygon-mainnet" },
  8453: { name: "Base", chain: chains.base, net: "base-mainnet" },
  42161: { name: "Arbitrum", chain: chains.arbitrum, net: "arb-mainnet" },
  43114: { name: "Avalanche", chain: chains.avalanche, net: "avax-mainnet" },
  59144: { name: "Linea", chain: chains.linea, net: "linea-mainnet" },
  100000002: { name: "Gnosis", chain: chains.gnosis, net: "gnosis-mainnet" },
  100000004: { name: "Metis", chain: chains.metis, net: "metis-mainnet" },
  100000009: { name: "Flow EVM", chain: chains.flowMainnet, net: "flow-mainnet" },
  100000013: { name: "Story", chain: chains.story, net: "story-mainnet" },
  100000014: { name: "Sonic", chain: chains.sonic, net: "sonic-mainnet" },
  100000017: { name: "Abstract", chain: chains.abstract, net: "abstract-mainnet", src: "0xA13771CaBD2E44dCa8DeA846CC954d1FBac0623B", dst: "0x422C63dc43E8e98a73c608138fcb69C3eCE1eE47" },
  100000019: { name: "Cronos", chain: chains.cronos, net: "cronos-mainnet" },
  100000020: { name: "Berachain", chain: chains.berachain, net: "berachain-mainnet" },
  100000022: { name: "HyperEVM", chain: chains.hyperEvm, net: "hyperliquid-mainnet" },
  100000023: { name: "Mantle", chain: chains.mantle, net: "mantle-mainnet" },
  100000030: { name: "Monad", chain: chains.monad, net: "monad-mainnet" },
  100000031: { name: "MegaETH", chain: chains.megaeth, net: "megaeth-mainnet" },
};
const chainName = (id) => CHAINS[id]?.name ?? (id === SOLANA ? "Solana" : `chain ${id}`);
const dlnAbi = parseAbi([
  // status: 0 NotSet, 1 Created, 2 ClaimedUnlock (filled), 3 ClaimedCancel (refunded)
  "function giveOrders(bytes32) view returns (uint8 status, uint160 giveTokenAddress, uint88 nativeFixFee, uint48 takeChainId, uint208 percentFee, uint256 giveAmount, address affiliateBeneficiary, uint256 affiliateAmount)",
  // status: 0 NotSet, 1 Fulfilled, 2 SentUnlock, 3 SentCancel
  "function takeOrders(bytes32) view returns (uint8 status, address takerAddress, uint256 giveChainId)",
]);
const ORDER = "(uint64 makerOrderNonce, bytes makerSrc, uint256 giveChainId, bytes giveTokenAddress, uint256 giveAmount, uint256 takeChainId, bytes takeTokenAddress, uint256 takeAmount, bytes receiverDst, bytes givePatchAuthoritySrc, bytes orderAuthorityAddressDst, bytes allowedTakerDst, bytes allowedCancelBeneficiarySrc, bytes externalCall) order";
// Orders before mid 2023 were emitted without the trailing metadata field.
const evCreated = [`event CreatedOrder(${ORDER}, bytes32 orderId, bytes affiliateFee, uint256 nativeFixFee, uint256 percentFee, uint32 referralCode, bytes metadata)`, `event CreatedOrder(${ORDER}, bytes32 orderId, bytes affiliateFee, uint256 nativeFixFee, uint256 percentFee, uint32 referralCode)`].map(parseAbiItem);

// The stats API sits behind Cloudflare and answers 429 with a retry-after: wait once, bounded.
let inflight = 0;
const waiters = [];
async function api(path, body) {
  while (inflight >= 2) await new Promise((r) => waiters.push(r));
  inflight++;
  try {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${API}${path}`, { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, body: body && JSON.stringify(body), signal: AbortSignal.timeout(30_000) }).catch(() => null);
      if (r?.status === 429 && i === 0) { await new Promise((s) => setTimeout(s, Math.min(Number(r.headers.get("retry-after")) || 10, 30) * 1000)); continue; }
      if (!r?.ok) throw new Error(`DLN API ${r?.status ?? "unreachable"}`);
      return await r.json();
    }
  } finally { inflight--; waiters.shift()?.(); }
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function base58(hex) {
  let n = BigInt(hex), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  return "1".repeat(hex.slice(2).match(/^(00)*/)[0].length / 2) + s;
}
// Order addresses are raw bytes: 20 for EVM, 32 for Solana.
const addr = (hex, chainId) => (!hex || hex === "0x" ? null : hex.length === 42 ? getAddress(hex) : chainId === SOLANA && /^0x[0-9a-f]{64}$/i.test(hex) ? base58(hex) : hex);
const sameAddr = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();

const debridge = {
  key: "debridge", name: "deBridge DLN", scan: false,
  async find(user) {
    const orders = new Map();
    // "maker" and "creator" each match orders the other misses (maker vs tx sender / cancel beneficiary):
    // ask both. Server-side filter: open, cancelled-on-destination and cancel-sent orders only. Bounded.
    await Promise.all(["maker", "creator"].map(async (by) => {
      for (let skip = 0; skip < 1000; skip += 100) {
        const r = await api("/filteredList", { skip, take: 100, [by]: user, orderStates: ["Created", "OrderCancelled", "SentOrderCancel"] });
        for (const o of r?.orders ?? []) orders.set(o.orderId.stringValue, o);
        if ((r?.orders?.length ?? 0) < 100) break;
      }
    }));
    return [...orders.values()].map((o) => {
      const give = o.giveOfferWithMetadata, src = Number(give.chainId.stringValue), cfg = CHAINS[src];
      const token = give.tokenAddress.stringValue;
      const native = token === zeroAddress;
      const network = cfg?.net ?? `dln-${src}`; // unknown networks just go unpriced
      return {
        tx: o.createEventTransactionHash?.stringValue, block: 0n, time: o.creationTimestamp, owner: user,
        asset: native && give.symbol === "ETH" ? ETH : { kind: "erc20", network, address: token.length === 42 ? getAddress(token) : token, symbol: give.symbol ?? "?", decimals: give.decimals ?? 18 },
        amount: BigInt(give.amount.stringValue) + BigInt(o.finalPercentFee?.stringValue ?? 0) + BigInt(o.affiliateFee?.amount?.stringValue ?? 0),
        orderId: o.orderId.stringValue, src, dst: Number(o.takeOfferWithMetadata.chainId.stringValue), state: o.state, user, native,
      };
    });
  },
  async status(it) {
    const { orderId, src, dst, user } = it;
    const s = CHAINS[src], d = CHAINS[dst];
    const route = `${chainName(src)} -> ${chainName(dst)}`;
    let order, give, take;
    if (s) {
      const c = client(s.chain, s.net);
      // The CreatedOrder event has the cancel authority and refund address, without one API call per order.
      const logs = it.tx ? await logsFromTxs(c, [it.tx], evCreated.map((event) => ({ address: s.src ?? SRC, event }))).catch(() => []) : [];
      const ev = logs.find((l) => l.args.orderId === orderId);
      if (ev) { order = ev.args.order; it.block = ev.blockNumber; }
      give = await c.readContract({ address: s.src ?? SRC, abi: dlnAbi, functionName: "giveOrders", args: [orderId] });
    }
    if (d && (!give || give[0] === 1)) take = await client(d.chain, d.net).readContract({ address: d.src ? d.dst : DST, abi: dlnAbi, functionName: "takeOrders", args: [orderId] });
    let detail;
    // Orders made from non-Alchemy chains, or receipts we could not decode: fall back to the order API.
    const settled = (give && give[0] !== 1) || take?.[0] === 1 || take?.[0] === 2;
    if (!order && !settled) {
      detail = await api(`/${orderId}`).catch(() => null);
      if (detail) order = { orderAuthorityAddressDst: detail.orderAuthorityAddressDst?.stringValue, allowedCancelBeneficiarySrc: detail.allowedCancelBeneficiarySrc?.stringValue };
    }
    const authority = addr(order?.orderAuthorityAddressDst, dst);
    // Refund goes to allowedCancelBeneficiarySrc when set; otherwise the authority picks one, normally the maker.
    // Orders made through a forwarder have the forwarder as maker, so fall back to the user who matched.
    it.owner = addr(order?.allowedCancelBeneficiarySrc, src) ?? user;
    if (give) {
      if (give[0] === 2) Object.assign(it, { status: "claimed", detail: `${route} order filled` });
      else if (give[0] === 3) Object.assign(it, { status: "claimed", detail: `${route} order cancelled and refunded` });
      else if (give[0] === 0) Object.assign(it, { status: "unknown", detail: `${route} order not found in DlnSource` });
      else it.amount = give[5] + give[4] + give[7] + (it.native ? give[2] : 0n); // what claimCancel pays back
    }
    if (!it.status && (take?.[0] === 1 || take?.[0] === 2)) Object.assign(it, { status: "claimed", detail: `${route} order filled on ${chainName(dst)}` });
    if (!it.status) {
      const who = authority ? `cancel authority ${authority}${sameAddr(authority, user) ? " (you)" : ""}` : "cancel authority unknown";
      const app = `app.debridge.finance/order?orderId=${orderId}`;
      if (take?.[0] === 3 || it.state === "SentOrderCancel") {
        // Cancel reached the destination but nobody claimed the refund on the source chain (no execution fee paid).
        detail ??= await api(`/${orderId}`).catch(() => null);
        const sub = detail?.sentOrderCancelDstEventInfo?.submissionId?.stringValue;
        Object.assign(it, { status: "claimable", detail: `${route} order cancelled on ${chainName(dst)}, refund never claimed on ${chainName(src)}`, action: `${app} > Claim refund, or DeBridgeGate.claim on ${chainName(src)} with the validator signatures${sub ? ` for submission ${sub}` : ""}` });
      } else if (it.state === "OrderCancelled") {
        // Solana destinations cancel in two steps: cancel, then send the cancel message back to the source.
        Object.assign(it, { status: "claimable", detail: `${route} order cancelled on ${chainName(dst)} but the cancel message was never sent; ${who}`, action: `${app} > Cancel (finish), then claim the refund on ${chainName(src)}` });
      } else if (now() - it.time < DAY) {
        Object.assign(it, { status: "waiting", detail: `${route} order open, under a day old` });
      } else {
        Object.assign(it, {
          status: "claimable", detail: `${route} order never filled; ${who}`,
          action: `${app} > Cancel (signed by the cancel authority on ${chainName(dst)}), or ${dst === SOLANA ? "the DLN destination program cancel + send_order_cancel on Solana" : `DlnDestination.sendEvmOrderCancel(order, ${it.owner}, fee) on ${chainName(dst)}`}`,
        });
      }
    }
    for (const k of ["orderId", "src", "dst", "state", "user", "native"]) delete it[k];
    it.detail = `${it.detail} (order ${orderId})`;
    return it;
  },
};

export default debridge;
