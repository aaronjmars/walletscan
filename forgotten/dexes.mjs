// forgotten/dexes.mjs - LP tokens left in dead Uniswap v2-style DEXes (rewards.dead_dexes). The pair list is
// data/dead-dexes.json: for each dead DEX (hiddenfunds.xyz llama-* sources, factories from DefiLlama adapters), the
// pairs whose reserves held at least $1,000 of trusted-priced tokens when the list was built. A scan reads balanceOf
// on every listed pair (one Multicall3 sweep per chain), then for the pairs the wallet holds: getReserves and
// totalSupply, valued at the wallet's share of each reserve on DefiLlama (confidence under 0.9 = no price). A pair
// with no priced leg is skipped; one priced leg, or two priced more than 3x apart, = medium (only the
// smaller priced leg counts). Each leg is the lower of reserve and the pair's balance (burn pays balances). Exit = removeLiquidity on the DEX
// router, or with no app: send the LP to the pair and call burn(to), which every v2 pair supports. LP amounts stay
// unrounded: a pair of 6- and 8-decimal tokens (WBTC-USDT) mints LP in units of 1e-9.
import { readFileSync } from "node:fs";
import { multiOn, pricesOf, trustedPrice, tokenKey, needEvm, units, round, parts, writeLink, RPC } from "./anyrpc.mjs";

export const DEAD_DEXES = JSON.parse(readFileSync(new URL("../data/dead-dexes.json", import.meta.url), "utf8"));
const BAL = ["function balanceOf(address) view returns (uint256)"];
const PAIR = ["function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)", "function totalSupply() view returns (uint256)"];
const STALE_S = 3 * 86400, IMBALANCE = 3;
// a price DefiLlama has not updated for 3 days is no price (dead DEX tokens often keep a frozen quote)
export const staleQuote = (c, nowS = Date.now() / 1000) => !!(c?.timestamp && nowS - c.timestamp > STALE_S);
// the priced legs that count: both priced but more than 3x apart means one price is wrong (a bridged copy priced as
// the original), so only the smaller leg counts and the row drops to medium
export function countedLegs(legs) {
  const priced = legs.filter((l) => l.usd != null);
  const imbalanced = priced.length === 2 && Math.max(priced[0].usd, priced[1].usd) > IMBALANCE * Math.min(priced[0].usd, priced[1].usd);
  return { priced: imbalanced ? [priced[0].usd <= priced[1].usd ? priced[0] : priced[1]] : priced, imbalanced };
}

async function chainRead(a, chain, pairs, dexes, ctx) {
  const bals = await multiOn(ctx, chain, pairs.map((x) => ({ to: x.pair, abi: BAL, fn: "balanceOf", args: [a] })), { batch: 400 });
  const held = pairs.map((x, i) => [x, bals[i]]).filter(([, b]) => b != null && b > 0n);
  if (!held.length) return [];
  // burn() pays out of the pair's token balances, so each leg is the lower of reserve and balance
  const meta = await multiOn(ctx, chain, held.flatMap(([x]) => [{ to: x.pair, abi: PAIR, fn: "getReserves" }, { to: x.pair, abi: PAIR, fn: "totalSupply" }, { to: x.token0, abi: BAL, fn: "balanceOf", args: [x.pair] }, { to: x.token1, abi: BAL, fn: "balanceOf", args: [x.pair] }]));
  const px = await pricesOf(ctx, held.flatMap(([x]) => [tokenKey(chain, x.token0), tokenKey(chain, x.token1)]));
  const fresh = (token) => (staleQuote(px.get(tokenKey(chain, token))) ? null : trustedPrice(px, tokenKey(chain, token)));
  const items = [];
  held.forEach(([x, raw], i) => {
    const [res, supply, b0, b1] = meta.slice(4 * i, 4 * i + 4);
    if (!res || !(supply > 0n)) return;
    const share = Number(raw) / Number(supply), dex = dexes.get(x.dex) || { name: x.dex };
    const low = (r, b) => (b != null && b < r ? b : r);
    const legs = [[x.token0, x.symbol0, x.dec0, low(res[0], b0)], [x.token1, x.symbol1, x.dec1, low(res[1], b1)]].map(([token, asset, dec, r]) => {
      const amount = units(r, dec) * share, p = fresh(token);
      return { token, asset, amount: round(amount, 6), usd: p == null ? null : round(amount * p) };
    });
    const { priced, imbalanced } = countedLegs(legs);
    if (!priced.length) return; // nothing here we can price: skipped
    items.push({
      category: "token_migration", chain, protocol: dex.name, asset: `${x.symbol0}-${x.symbol1} LP`, token: x.pair.toLowerCase(), amount: units(raw, 18),
      usd: round(priced.reduce((t, l) => t + l.usd, 0)), legs, unpriced: legs.length - priced.length, status: "ready", ...(imbalanced && { imbalanced: true }),
      action: dex.router ? `remove the liquidity: removeLiquidity(${x.token0}, ${x.token1}, ...) on the ${dex.name} router, or send the LP to the pair and call burn(your address)` : "remove the liquidity: send the LP tokens to the pair contract, then call burn(your address) on it",
      how_to_claim: dex.app || writeLink(chain, dex.router || x.pair),
      detail: `${dex.name} (${chain}) pair ${x.pair}: ${dex.status_note || "the DEX is no longer maintained"}; your share = ${legs.map((l) => `${l.amount} ${l.asset}`).join(" + ")}${imbalanced ? "; the two legs are priced more than 3x apart, so only the smaller one counts" : ""}`,
    });
  });
  return items;
}

export async function deadDexes(p, ctx) {
  needEvm(p);
  const dexes = new Map(DEAD_DEXES.dexes.map((d) => [d.id, d]));
  const byChain = new Map();
  for (const x of DEAD_DEXES.pairs) if (RPC[x.chain]) (byChain.get(x.chain) || byChain.set(x.chain, []).get(x.chain)).push(x);
  const out = await parts(Object.fromEntries([...byChain].map(([chain, list]) => [chain, () => chainRead(p.address, chain, list, dexes, ctx)])));
  return { ...out, pairs_checked: DEAD_DEXES.pairs.length };
}
