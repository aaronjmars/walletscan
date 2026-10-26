// forgotten/balancer.mjs - Balancer pool shares (read 2026-10-20). v2 + v3 (and CoW AMM): Balancer's own API lists every
// pool the wallet holds BPT of, in the wallet or staked (gauge, Aura...), on all its chains; each balance is read back
// onchain (balanceOf on the BPT, the gauge or the Aura pool) and valued at the underlying: the wallet's share of each
// pool token, priced on DefiLlama. v1 (Ethereum, immutable): the BFactory's LOG_NEW_POOL logs list its ~3,300 pools,
// one Multicall3 sweep of balanceOf finds the wallet's. Pausable v2/v3 pools go withdraw-only on 2026-10-30 (BIP-928);
// exits stay open after, so the date is when to leave, not when the money is lost.
import { readFileSync } from "node:fs";
import { isEvmAddr } from "../solana.mjs";
import { multi, logs, prices, trusted, units, writeLink } from "./evm.mjs";

// Balancer API chain -> our chain name (evm.rpc host via evm.mjs HOST, or the name itself), DefiLlama prefix, app slug
export const BAL_CHAINS = {
  MAINNET: ["ethereum", "ethereum", "ethereum"], ARBITRUM: ["arbitrum", "arbitrum", "arbitrum"], BASE: ["base", "base", "base"], POLYGON: ["polygon", "polygon", "polygon"],
  OPTIMISM: ["optimism", "optimism", "optimism"], AVALANCHE: ["avalanche", "avax", "avalanche"], GNOSIS: ["gnosis", "xdai", "gnosis"], SONIC: ["sonic", "sonic", "sonic"],
  FRAXTAL: ["fraxtal", "fraxtal", "fraxtal"], MODE: ["mode", "mode", "mode"], ZKEVM: ["polygon-zkevm", "polygon_zkevm", "zkevm"], FANTOM: ["fantom", "fantom", "fantom"],
  HYPEREVM: ["hyperevm", "hyperliquid", "hyperevm"], PLASMA: ["plasma", "plasma", "plasma"], MONAD: ["monad", "monad", "monad"], XLAYER: ["xlayer", "xlayer", "xlayer"],
};
// chains whose BPT, gauge and Aura balances we read back through evm.rpc (publicnode); the rest keep the API's amount (medium)
const ONCHAIN = new Set(["ethereum", "arbitrum", "base", "polygon", "optimism", "avalanche", "gnosis", "sonic", "fraxtal"]);
// stakes we can read with balanceOf(user) on the stakingId contract; Beets farms (MasterChef, Reliquary, fresh BEETS) cannot
const READABLE = new Set(["GAUGE", "AURA", "VEBAL"]);
// the wind-down date comes from the hand-kept data/deadlines.json row (balancer-winddown)
export const WINDDOWN = JSON.parse(readFileSync(new URL("../data/deadlines.json", import.meta.url), "utf8")).find((d) => d.id === "balancer-winddown")?.closes || null;
export const BFACTORY_V1 = "0x9424B1412450D0f8Fc2255FAf6046b98213B76Bd";
const LOG_NEW_POOL = "0x8ccec77b0cb63ac2cafd0f5de8cdfadab91ce656d262240ba8a6343bccc5f945"; // LOG_NEW_POOL(address indexed caller, address indexed pool)
const BAL = ["function balanceOf(address) view returns (uint256)"];
const V1 = ["function getCurrentTokens() view returns (address[])", "function getBalance(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];

let v1Pools = null; // { at, list }: the v1 pool list, read once a day
async function v1PoolList(ctx) {
  if (v1Pools && Date.now() - v1Pools.at < 864e5) return v1Pools.list;
  const list = (await logs(ctx, { address: BFACTORY_V1, topics: [LOG_NEW_POOL] })).map((l) => `0x${l.topics[2].slice(26)}`);
  v1Pools = { at: Date.now(), list };
  return list;
}
export const resetV1Pools = () => { v1Pools = null; };

const appLink = (p) => `https://balancer.fi/pools/${BAL_CHAINS[p.chain]?.[2] || "ethereum"}/${p.protocolVersion === 1 ? "cow" : `v${p.protocolVersion}`}/${p.id}`;

// the wallet's share of each pool token, priced; usd = priced legs only (unpriced = how many legs had no trusted price)
function legsOf(tokens, share, llama, px) {
  let usd = 0, unpriced = 0;
  const legs = tokens.map((t) => {
    const amount = t.balance == null ? null : Number(t.balance) * share, c = trusted(px.get(`${llama}:${String(t.address).toLowerCase()}`));
    if (c && amount != null) usd += amount * c.price; else if (amount == null || amount > 0) unpriced++;
    return { token: String(t.address).toLowerCase(), asset: t.symbol, amount: round6(amount), usd: c && amount != null ? round2(amount * c.price) : null };
  });
  return { legs, usd: legs.some((l) => l.usd != null) ? round2(usd) : null, unpriced };
}

async function v2v3(a, ctx) {
  const r = await ctx.call("rewards.balancer_api", { address: a.toLowerCase() });
  if (!r.ok) throw { status: 502, error: `step rewards.balancer_api failed (upstream ${r.status})`, detail: r.data };
  const pools = r.data?.data?.poolGetPools || [];
  // one row per place the BPT sits: the wallet, then each stake
  const rows = [];
  for (const p of pools) {
    if (!BAL_CHAINS[p.chain]) continue;
    const ub = p.userBalance || {};
    if (Number(ub.walletBalance) > 0) rows.push({ p, where: "wallet", api: Number(ub.walletBalance), contract: p.address });
    for (const s of ub.stakedBalances || []) if (Number(s.balance) > 0) rows.push({ p, where: s.stakingType, api: Number(s.balance), contract: s.stakingId });
  }
  if (!rows.length) return { items: [], errors: [] };
  // read every balance back onchain, per chain
  const byChain = new Map();
  rows.forEach((row) => { const ch = BAL_CHAINS[row.p.chain][0]; if (ONCHAIN.has(ch) && (row.where === "wallet" || READABLE.has(row.where)) && /^0x[0-9a-f]{40}$/i.test(row.contract || "")) (byChain.get(ch) || byChain.set(ch, []).get(ch)).push(row); });
  const errors = [];
  await Promise.all([...byChain].map(async ([ch, list]) => {
    try {
      const res = await multi(ctx, ch, list.map((row) => ({ to: row.contract, abi: BAL, fn: "balanceOf", args: [a] })));
      list.forEach((row, i) => { if (res[i] != null) row.onchain = units(res[i], 18); });
    } catch (e) { errors.push(`${ch}: ${String(e?.error || e?.message || e).slice(0, 120)}`); }
  }));
  const px = await prices(ctx, rows.flatMap((row) => (row.p.poolTokens || []).map((t) => `${BAL_CHAINS[row.p.chain][1]}:${String(t.address).toLowerCase()}`)));
  const items = [];
  for (const row of rows) {
    const { p, where } = row, [chain, llama] = BAL_CHAINS[p.chain];
    const amount = row.onchain ?? row.api;
    if (!(amount > 0)) continue; // the API was behind: the balance is gone onchain
    const total = Number(p.dynamicData?.totalShares);
    const { legs, usd, unpriced } = legsOf(p.poolTokens || [], total > 0 ? amount / total : 0, llama, px);
    const version = p.protocolVersion === 1 ? "CoW AMM" : `v${p.protocolVersion}`, staked = where !== "wallet";
    items.push({
      category: staked ? "unstake_ready" : "token_migration", chain, protocol: `Balancer ${version}`, pool: p.id, asset: p.symbol, token: String(p.address).toLowerCase(),
      amount: round6(amount), usd, legs, unpriced, where, staked_in: staked ? row.contract : null, confirmed: row.onchain != null, deadline: p.protocolVersion >= 2 ? WINDDOWN : null,
      action: staked ? `${where === "AURA" ? "withdraw from Aura" : where === "GAUGE" ? "unstake from the gauge" : `unstake (${where.toLowerCase()})`}, then remove the liquidity` : "remove the liquidity (exit the pool)",
      how_to_claim: where === "AURA" ? "https://app.aura.finance" : appLink(p),
      detail: `${p.name || p.symbol} (${version}, ${p.chain.toLowerCase()})${staked ? `, staked: ${where}` : ""}${row.onchain == null ? "; balance as read by the Balancer API" : ""}`,
    });
  }
  return { items, errors };
}

async function v1(a, ctx) {
  const list = await v1PoolList(ctx);
  const bals = await multi(ctx, "ethereum", list.map((to) => ({ to, abi: BAL, fn: "balanceOf", args: [a] })), { batch: 500 }); // ~7 calls for ~3,300 pools
  const held = list.map((pool, i) => [pool, bals[i]]).filter(([, b]) => b != null && b > 0n);
  if (!held.length) return [];
  const meta = await multi(ctx, "ethereum", held.flatMap(([to]) => [{ to, abi: V1, fn: "getCurrentTokens" }, { to, abi: V1, fn: "totalSupply" }]));
  const legsIn = held.map(([pool], i) => ({ pool, tokens: meta[2 * i] || [], supply: meta[2 * i + 1] }));
  const tokenCalls = legsIn.flatMap(({ pool, tokens }) => tokens.flatMap((t) => [{ to: pool, abi: V1, fn: "getBalance", args: [t] }, { to: t, abi: V1, fn: "decimals" }, { to: t, abi: V1, fn: "symbol" }]));
  const tok = tokenCalls.length ? await multi(ctx, "ethereum", tokenCalls) : [];
  const px = await prices(ctx, legsIn.flatMap(({ tokens }) => tokens.map((t) => `ethereum:${t.toLowerCase()}`)));
  let k = 0;
  return held.map(([pool, raw], i) => {
    const { tokens, supply } = legsIn[i];
    const poolTokens = tokens.map((t) => { const [b, d, s] = tok.slice(k, k + 3); k += 3; return { address: t, symbol: s ?? null, balance: b == null || d == null ? null : units(b, d) }; });
    const share = supply > 0n ? Number(raw) / Number(supply) : 0;
    const { legs, usd, unpriced } = legsOf(poolTokens, share, "ethereum", px);
    return {
      category: "token_migration", chain: "ethereum", protocol: "Balancer v1", pool, asset: "BPT", token: pool.toLowerCase(), amount: round6(units(raw, 18)), usd, legs, unpriced, where: "wallet", staked_in: null, confirmed: true, deadline: null,
      action: "remove the liquidity: exitPool(poolAmountIn, minAmountsOut) on the pool contract (v1 has no app any more)", how_to_claim: writeLink("ethereum", pool),
      detail: `Balancer v1 pool of ${poolTokens.map((t) => t.symbol || t.address.slice(0, 8)).join("/")}; v1 pools are immutable and always exit`,
    };
  });
}

export async function balancerPools(p, ctx) {
  if (p.address == null || p.address === "") throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
  // the API read is the source: if it fails the route fails (scans then keep Zerion's Balancer rows); v1 is a side read
  const errors = [];
  const [main, old] = await Promise.all([
    v2v3(p.address, ctx),
    ctx.live("evm.alchemy") ? v1(p.address, ctx).catch((e) => { errors.push(`v1: ${String(e?.error || e?.message || e).slice(0, 120)}`); return []; }) : [],
  ]);
  const items = [...(main.items || []), ...old];
  errors.unshift(...(main.errors || []));
  return { items, errors, ...(!ctx.live("evm.alchemy") && { note: "v1 pools need ALCHEMY_API_KEY (the pool list comes from factory logs)" }) };
}

const round6 = (v) => (v == null ? null : Math.round(v * 1e6) / 1e6);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
