// forgotten/agglayer.mjs - Silicon zkEVM exits sent to Ethereum and never claimed (bridge.agglayer, read 2026-10-21).
// Silicon (chain 2355, Polygon CDK, Agglayer network id 10 in the RollupManager) shuts down on 2026-12-31. A
// withdrawal from Silicon is a deposit on its L2 bridge with destination network 0; the money waits on the Agglayer
// unified bridge 0x2a3DD3EB on Ethereum until someone calls claimAsset with the proof. Silicon's own bridge service
// (the one bridge.silicon.network uses) lists a wallet's deposits both ways; we keep the exits (network_id 10,
// dest_net 0) and read isClaimed(deposit_cnt, 10) on Ethereum, which is the only truth. The proof comes from that
// service too, so once it goes off with the chain the claim gets much harder: the deadline is real.
import { readFileSync } from "node:fs";
import { multiOn, pricesOf, trustedPrice, needEvm, round, errText } from "./anyrpc.mjs";

export const UNIFIED_BRIDGE = "0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe";
const ZERO = "0x0000000000000000000000000000000000000000";
const NETWORKS = { 10: { name: "Silicon", route: "bridge.silicon_bridges", sunset: "silicon", app: "https://bridge.silicon.network" } };
const SUNSET = JSON.parse(readFileSync(new URL("../data/sunset-chains.json", import.meta.url), "utf8"));
const ABI = [
  "function isClaimed(uint32 leafIndex, uint32 sourceBridgeNetwork) view returns (bool)",
  "function getTokenWrappedAddress(uint32 originNetwork, address originTokenAddress) view returns (address)",
  "function decimals() view returns (uint8)", "function symbol() view returns (string)",
];

async function exitsOf(a, net, ctx) {
  const n = NETWORKS[net];
  const r = await ctx.call(n.route, { address: a });
  if (!r.ok) throw { status: 502, error: `step ${n.route} failed (upstream ${r.status})`, detail: r.data };
  const exits = (r.data?.deposits || []).filter((d) => Number(d.network_id) === net && Number(d.dest_net) === 0 && Number(d.leaf_type) === 0 && BigInt(d.amount || 0) > 0n
    && String(d.dest_addr || "").toLowerCase() === a.toLowerCase());
  if (!exits.length) return [];
  // claimed state + the token each exit pays on Ethereum (born on Ethereum = the token itself, else its wrapped copy)
  const first = await multiOn(ctx, "ethereum", exits.flatMap((d) => [
    { to: UNIFIED_BRIDGE, abi: ABI, fn: "isClaimed", args: [Number(d.deposit_cnt), net] },
    { to: UNIFIED_BRIDGE, abi: ABI, fn: "getTokenWrappedAddress", args: [Number(d.orig_net), d.orig_addr] },
  ]));
  const open = exits.map((d, i) => ({ d, claimed: first[2 * i], token: Number(d.orig_net) === 0 ? String(d.orig_addr).toLowerCase() : String(first[2 * i + 1] || ZERO).toLowerCase() }))
    .filter((x) => x.claimed === false);
  if (!open.length) return [];
  const erc = [...new Set(open.map((x) => x.token).filter((t) => t !== ZERO))];
  const meta = erc.length ? await multiOn(ctx, "ethereum", erc.flatMap((t) => [{ to: t, abi: ABI, fn: "decimals" }, { to: t, abi: ABI, fn: "symbol" }])) : [];
  const info = new Map(erc.map((t, i) => [t, { decimals: meta[2 * i], symbol: meta[2 * i + 1] }]));
  const px = await pricesOf(ctx, open.map((x) => (x.token === ZERO ? (Number(x.d.orig_net) === 0 ? "coingecko:ethereum" : null) : `ethereum:${x.token}`)));
  const sun = SUNSET.find((s) => s.id === n.sunset) || {};
  return open.map(({ d, token }) => {
    const eth = token === ZERO && Number(d.orig_net) === 0, m = eth ? { decimals: 18, symbol: "ETH" } : info.get(token) || {};
    if (m.decimals == null) return { protocol: `Agglayer (${n.name})`, chain: "ethereum", asset: null, amount: round(Number(BigInt(d.amount)) / 1e18, 8), usd: null, status: "hint", category: "bridge_stuck", deadline: sun.closes || null, how_to_claim: n.app, action: `claim the ${n.name} exit on Ethereum (Finalize in the ${n.name} bridge app)`, detail: `exit ${d.deposit_cnt} from ${n.name}: a token born on ${n.name} (${d.orig_addr}) whose Ethereum copy was never deployed; raw amount ${d.amount} (amount shown assumes 18 decimals)` };
    const amount = Number(BigInt(d.amount)) / 10 ** Number(m.decimals), p = trustedPrice(px, eth ? "coingecko:ethereum" : `ethereum:${token}`);
    return {
      category: "bridge_stuck", chain: "ethereum", protocol: `Agglayer (${n.name})`, asset: m.symbol, ...(!eth && { token }), amount: round(amount, 8), usd: p == null ? null : round(amount * p),
      status: d.ready_for_claim ? "ready" : "queued", deposit_count: Number(d.deposit_cnt), deadline: sun.closes || null,
      action: `claim the ${n.name} exit on Ethereum: Finalize in the ${n.name} bridge app (claimAsset on the Agglayer bridge with the proof from its bridge service)`,
      how_to_claim: n.app,
      detail: `withdrawal ${d.deposit_cnt} from ${n.name} to Ethereum, sent and never claimed (isClaimed(${d.deposit_cnt}, ${net}) = false on ${UNIFIED_BRIDGE}); ${n.name} and its bridge service shut down ${sun.closes || "soon"}, the proof goes with them`,
    };
  });
}

export async function agglayerExits(p, ctx) {
  needEvm(p);
  const errors = [], items = [];
  await Promise.all(Object.keys(NETWORKS).map((net) => exitsOf(p.address, Number(net), ctx).then((xs) => items.push(...xs), (e) => errors.push(`${NETWORKS[net].name}: ${errText(e)}`))));
  if (errors.length === Object.keys(NETWORKS).length) throw { status: 502, error: errors.join("; ") };
  return { items, errors };
}
