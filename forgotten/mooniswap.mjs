// forgotten/mooniswap.mjs - LP tokens left in Mooniswap pools on Ethereum (rewards.mooniswap): the first Mooniswap
// factory (MooniFactory 0x71CD6666, Aug 2020, DefiLlama's mooniswap adapter) and the 1inch Liquidity Protocol one
// (MooniswapFactory 0xbAF9A5d4, Mooniswap v2), both verified on Etherscan. Neither is maintained any more
// (hiddenfunds.xyz lists Mooniswap as dead); the pools still pay out. The pool list is data/mooniswap.json (getAllPools on both factories, kept when the pool's
// balances held at least $1,000 of trusted-priced tokens). A scan reads balanceOf on every listed pool (one
// Multicall3 sweep), then for the pools held: totalSupply and the pool's real balance of each token (ETH pools hold
// ETH itself: token 0x0, read with Multicall3 getEthBalance). Both versions pay withdraw(amount, minReturns) as
// balance x amount / totalSupply (no reserves to cap against), so a leg is the wallet's share of the pool balance.
// Pricing follows rewards.dead_dexes: DefiLlama, confidence under 0.9 or a quote older than 3 days = no price, legs
// priced more than 3x apart count only the smaller one. bad_prices in the data file lists quotes never to trust.
import { readFileSync } from "node:fs";
import { multiOn, pricesOf, trustedPrice, tokenKey, needEvm, units, round, writeLink, MULTICALL3 } from "./anyrpc.mjs";
import { staleQuote, countedLegs } from "./dexes.mjs";

export const MOONISWAP = JSON.parse(readFileSync(new URL("../data/mooniswap.json", import.meta.url), "utf8"));
const ZERO = "0x0000000000000000000000000000000000000000";
const ABI = ["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function getEthBalance(address) view returns (uint256)"];
const BAD = new Set(Object.keys(MOONISWAP.bad_prices || {}).map((t) => t.toLowerCase()));
const keyOf = (t) => (t === ZERO ? "coingecko:ethereum" : tokenKey("ethereum", t));

export async function mooniswapLps(p, ctx) {
  needEvm(p);
  const pools = MOONISWAP.pools, dexes = new Map(MOONISWAP.dexes.map((d) => [d.id, d]));
  const bals = await multiOn(ctx, "ethereum", pools.map((x) => ({ to: x.pool, abi: ABI, fn: "balanceOf", args: [p.address.toLowerCase()] })), { batch: 400 });
  const held = pools.map((x, i) => [x, bals[i]]).filter(([, b]) => b != null && b > 0n);
  if (!held.length) return { items: [], errors: [], pools_checked: pools.length };
  const leg = (pool, t) => (t === ZERO ? { to: MULTICALL3, abi: ABI, fn: "getEthBalance", args: [pool] } : { to: t, abi: ABI, fn: "balanceOf", args: [pool] });
  const [meta, px] = await Promise.all([
    multiOn(ctx, "ethereum", held.flatMap(([x]) => [{ to: x.pool, abi: ABI, fn: "totalSupply" }, leg(x.pool, x.token0), leg(x.pool, x.token1)])),
    pricesOf(ctx, held.flatMap(([x]) => [keyOf(x.token0), keyOf(x.token1)])),
  ]);
  const fresh = (t) => (BAD.has(t.toLowerCase()) || staleQuote(px.get(keyOf(t))) ? null : trustedPrice(px, keyOf(t)));
  const items = [];
  held.forEach(([x, raw], i) => {
    const [supply, b0, b1] = meta.slice(3 * i, 3 * i + 3);
    if (!(supply > 0n) || b0 == null || b1 == null) return;
    const share = Number(raw) / Number(supply), dex = dexes.get(x.dex) || { name: "Mooniswap" };
    const legs = [[x.token0, x.symbol0, x.dec0, b0], [x.token1, x.symbol1, x.dec1, b1]].map(([token, asset, dec, b]) => {
      const amount = units(b, dec) * share, pr = fresh(token);
      return { token, asset, amount: round(amount, 6), usd: pr == null ? null : round(amount * pr) };
    });
    const { priced, imbalanced } = countedLegs(legs);
    if (!priced.length) return; // nothing here we can price: skipped
    items.push({
      category: "token_migration", chain: "ethereum", protocol: dex.name, asset: `${x.symbol0}-${x.symbol1} LP`, token: x.pool.toLowerCase(), amount: units(raw, 18),
      usd: round(priced.reduce((t, l) => t + l.usd, 0)), legs, unpriced: legs.length - priced.length, status: "ready", ...(imbalanced && { imbalanced: true }),
      action: `remove the liquidity: withdraw(${String(raw)}, []) on the pool contract ${x.pool} (pays both tokens${x.token0 === ZERO || x.token1 === ZERO ? ", ETH as ETH" : ""})`,
      how_to_claim: writeLink("ethereum", x.pool),
      detail: `${dex.name} pool ${x.pool}: Mooniswap is no longer maintained, the pool still pays out; your share = ${legs.map((l) => `${l.amount} ${l.asset}`).join(" + ")}${imbalanced ? "; the two legs are priced more than 3x apart, so only the smaller one counts" : ""}`,
    });
  });
  return { items, errors: [], pools_checked: pools.length };
}
