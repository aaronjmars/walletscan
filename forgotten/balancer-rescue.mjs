// forgotten/balancer-rescue.mjs - Balancer v2 rescued funds never claimed (rewards.balancer_rescue, read 2026-10-21).
// After the 2025-11-03 Balancer v2 exploit, the rescued tokens are paid back pro rata to the pools' LPs at the
// snapshot (BIP-892) as Merkl JSON_AIRDROP campaigns, one per pool and token, on the Merkl Distributor of Ethereum,
// Arbitrum, Base, Polygon and Optimism. The reward tokens are Balancer "pull" wrappers: claiming burns the wrapper and
// pays the real token (WETH, wstETH, rETH...) from the Balancer DAO multisig. Merkl's user endpoint only lists these
// campaigns with test=true (as the Balancer app asks), so rewards.merkl never sees them. The claim window was 180 days
// from 2026-02-11, extended 6 months by BIP-923 (passed 2026-08-25): about 2027-02-10 (inferred, no official date).
// balancer.fi stops being maintained on 2026-10-30 (BIP-928); after that the claim is Distributor.claim with the
// amount and proofs from the Merkl API. Wrapper list: balancer/frontend-monorepo recovered-funds/wrapper-tokens.ts.
import { multiOn, pricesOf, trustedPrice, tokenKey, needEvm, round, errText } from "./anyrpc.mjs";

export const MERKL_DISTRIBUTOR = "0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae";
export const RESCUE_ENDS = "2027-02-10";
const CHAIN = { 1: "ethereum", 42161: "arbitrum", 8453: "base", 137: "polygon", 10: "optimism" };
// the same wrapper address can stand for a different token on another chain: the token is read with token()
export const RESCUE_WRAPPERS = {
  1: ["0xb0334c5287bfb15a8c9464898cdb0248ed176332", "0x8942c1e1e0d48e14efba4cc48d2e3584116e367f", "0x4e185b1502fea7a06b63fdda6de38f92c9528566", "0x84394fa6a39bdff63b255622da362b113c690267", "0x470c9034f50afe6633f7e84a80b9961baa893d77", "0x4da51947fe2e4d59a137a78ced3b740f5e230f92"],
  42161: ["0xb0334c5287bfb15a8c9464898cdb0248ed176332", "0x8942c1e1e0d48e14efba4cc48d2e3584116e367f", "0x4e185b1502fea7a06b63fdda6de38f92c9528566", "0x84394fa6a39bdff63b255622da362b113c690267", "0x470c9034f50afe6633f7e84a80b9961baa893d77", "0x4da51947fe2e4d59a137a78ced3b740f5e230f92", "0xc63ff8af78414f90069af3558d939127625abe78", "0x69b7afb870c31302de15371a2ee79aee444cc014", "0xad9e52ed75f71bdf67ddce3e417b805f042e54e3", "0xe995168d9924d72a4fe45af18edc06b498cb8dbb", "0x67763bc722abe1f041ddc3ed6e445f4ab476ff9e"],
  8453: ["0xe859ee83a3c8c5af058dc2f3533ac577b19706f2", "0x16814b50a7962592b8fc4080cdaf0008a8fd5620", "0x64e8e5fe82625e3b8ab7d9d00918736d6b8634b8"],
  137: ["0x467665d4ae90e7a99c9c9af785791058426d6ea0", "0xec2c6184761ab7fe061130b4a7e3da89c72f8395", "0x138d9e0d0cc4906c4cd865b38c9340a5cedd9850", "0xb0334c5287bfb15a8c9464898cdb0248ed176332"],
  10: ["0x467665d4ae90e7a99c9c9af785791058426d6ea0", "0xec2c6184761ab7fe061130b4a7e3da89c72f8395", "0x138d9e0d0cc4906c4cd865b38c9340a5cedd9850"],
};
const ABI = ["function token() view returns (address)", "function claimed(address user, address token) view returns (uint208 amount, uint48 timestamp, bytes32 merkleRoot)"];

export async function balancerRescue(p, ctx) {
  needEvm(p);
  const r = await ctx.call("rewards.merkl_test", { address: p.address });
  if (!r.ok || !Array.isArray(r.data)) throw { status: 502, error: `step rewards.merkl_test failed (upstream ${r.status})`, detail: r.data };
  const rows = [];
  for (const c of r.data) for (const w of c.rewards || []) {
    const id = Number(w.token?.chainId ?? c.chain?.id), wrapper = String(w.token?.address || "").toLowerCase();
    if (!CHAIN[id] || !RESCUE_WRAPPERS[id]?.includes(wrapper)) continue;
    const owed = BigInt(w.amount || 0) - BigInt(w.claimed || 0);
    if (owed > 0n) rows.push({ id, chain: CHAIN[id], wrapper, amount: BigInt(w.amount), api_claimed: BigInt(w.claimed || 0), decimals: Number(w.token?.decimals ?? 18), symbol: w.token?.symbol, pool: w.breakdowns?.[0]?.reason || null });
  }
  if (!rows.length) return { items: [], errors: [] };
  // per chain: the token each wrapper pays and what the Distributor says was claimed already
  const errors = [], byChain = new Map();
  rows.forEach((x) => (byChain.get(x.chain) || byChain.set(x.chain, []).get(x.chain)).push(x));
  await Promise.all([...byChain].map(async ([chain, list]) => {
    try {
      const res = await multiOn(ctx, chain, list.flatMap((x) => [{ to: x.wrapper, abi: ABI, fn: "token" }, { to: MERKL_DISTRIBUTOR, abi: ABI, fn: "claimed", args: [p.address, x.wrapper] }]));
      list.forEach((x, i) => { x.underlying = res[2 * i] ? String(res[2 * i]).toLowerCase() : null; x.onchain_claimed = res[2 * i + 1] ? BigInt(res[2 * i + 1][0]) : null; });
    } catch (e) { errors.push(`${chain}: ${errText(e)}`); }
  }));
  const px = await pricesOf(ctx, rows.filter((x) => x.underlying).map((x) => tokenKey(x.chain, x.underlying)));
  const items = rows.map((x) => {
    const claimed = x.onchain_claimed ?? x.api_claimed, owed = x.amount - claimed;
    if (owed <= 0n) return null;
    const amount = Number(owed) / 10 ** x.decimals, pr = x.underlying ? trustedPrice(px, tokenKey(x.chain, x.underlying)) : null;
    return {
      category: "reward", chain: x.chain, protocol: "Balancer rescued funds", asset: x.symbol, ...(x.underlying && { token: x.underlying }), amount: round(amount, 8), usd: pr == null ? null : round(amount * pr),
      status: x.onchain_claimed != null && x.underlying ? "ready" : "unconfirmed", deadline: RESCUE_ENDS, wrapper: x.wrapper,
      action: `claim the Balancer v2 rescued funds on balancer.fi/portfolio before 2026-10-30 (the app winds down), after that Distributor.claim on ${MERKL_DISTRIBUTOR} with the Merkl proofs; window to about ${RESCUE_ENDS}`,
      how_to_claim: "https://balancer.fi/portfolio",
      detail: `your share of tokens rescued after the 2025-11-03 Balancer v2 exploit (BIP-892, Merkl campaign${x.pool ? ` for pool ${x.pool}` : ""}), paid in ${x.symbol} via wrapper ${x.wrapper}; claim window extended to about ${RESCUE_ENDS} (BIP-923, date inferred); contract wallets: admin@balancer.finance`,
    };
  }).filter(Boolean);
  return { items, errors };
}
