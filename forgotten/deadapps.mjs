// forgotten/deadapps.mjs - single-contract leftovers (read 2026-10-20): GMX v1 GLP still staked (Arbitrum, Avalanche;
// sell-only since July 2025, priced by its own GlpManager), Element Finance v1 tranches (all expired: PT and YT redeem
// on the tranche, LP exits the Balancer pool first), ERC-4337 EntryPoint deposits (v0.6 / v0.7 / v0.8 on 7 chains)
// and Lighter withdrawals waiting on Ethereum (getPendingBalance).
import { isEvmAddr } from "../solana.mjs";
import { multi, rpcCall, prices, priceOf, units, writeLink, each, ZERO } from "./evm.mjs";

const BAL = ["function balanceOf(address) view returns (uint256)"];
export const GLP = {
  arbitrum: { fsGlp: "0x1aDDD80E6039594eE970E5872D247bf0414C8903", manager: "0x3963FfC9dff443c2A94f21b129D429891E32ec18", router: "0xB95DB5B167D75e6d04227CfFFA61069348d271F5" },
  avalanche: { fsGlp: "0x9e295B5B976a184B14aD8cd72413aD846C299660", manager: "0xD152c7F25db7F4B95b7658323c5F33d176818EE4", router: "0xB70B91CE0771d3f4c81D87660f71Da31d48eB3B3" },
};
export const ENTRYPOINTS = { "v0.6": "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", "v0.7": "0x0000000071727De22E5E9d8BAf0edAc6f37da032", "v0.8": "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108" };
export const EP_CHAINS = ["ethereum", "arbitrum", "optimism", "base", "polygon", "bsc", "avalanche"];
const NATIVE = { bsc: "BNB", polygon: "POL", avalanche: "AVAX" }, NATIVE_ID = { ETH: "ethereum", BNB: "binancecoin", POL: "polygon-ecosystem-token", AVAX: "avalanche-2" };
export const LIGHTER = { zk: "0x3B4D794a66304F130a4Db8F2551B0070dfCf5ca7", usdcIndex: 3, assets: 14 };

async function glp(ctx, a) {
  const out = [];
  await Promise.all(Object.entries(GLP).map(async ([chain, g]) => {
    const [bal, price] = await multi(ctx, chain, [{ to: g.fsGlp, abi: BAL, fn: "balanceOf", args: [a] }, { to: g.manager, abi: ["function getPrice(bool maximise) view returns (uint256)"], fn: "getPrice", args: [false] }]);
    if (!(bal > 0n)) return;
    const px = price == null ? null : Number(price) / 1e30;
    out.push({ category: "unstake_ready", chain, protocol: "GMX v1", asset: "GLP", token: g.fsGlp, amount: units(bal), usd: px == null ? null : units(bal) * px, status: "ready",
      action: "sell the staked GLP (GMX v1 is sell-only since July 2025)", how_to_claim: "https://v1.app.gmx.io/#/buy_glp#redeem",
      detail: `fsGLP still staked on GMX v1 ${chain}, worth ${px == null ? "?" : px.toFixed(4)} USD per GLP by its GlpManager; if the page fails, unstakeAndRedeemGlp on ${g.router}` });
  }));
  return out;
}

// Element v1: tranche list from element-fi/elf-deploy (rewards.element_tranches); every tranche expired in 2022-2023
async function element(ctx, a) {
  const r = await ctx.call("rewards.element_tranches", {});
  if (!r.ok) throw { error: `upstream ${r.status}` };
  const tranches = Object.entries(r.data?.tranches || {}).flatMap(([name, list]) => (list || []).map((t) => ({ name, ...t })));
  if (!tranches.length) return [];
  const TR = ["function interestToken() view returns (address)", "function underlying() view returns (address)", "function decimals() view returns (uint8)"];
  const first = await multi(ctx, "ethereum", tranches.flatMap((t) => [
    { to: t.address, abi: BAL, fn: "balanceOf", args: [a] }, { to: t.address, abi: TR, fn: "interestToken" }, { to: t.address, abi: TR, fn: "underlying" }, { to: t.address, abi: TR, fn: "decimals" },
    ...(t.ptPool?.address ? [{ to: t.ptPool.address, abi: BAL, fn: "balanceOf", args: [a] }] : [null]),
  ]).map((c) => c || { to: ZERO, abi: BAL, fn: "balanceOf", args: [a] }));
  const rows = tranches.map((t, i) => ({ t, pt: first[i * 5], yt: first[i * 5 + 1], und: first[i * 5 + 2], dec: first[i * 5 + 3] ?? 18, lp: t.ptPool?.address ? first[i * 5 + 4] : null }));
  const ytBal = await multi(ctx, "ethereum", rows.map((x) => ({ to: x.yt || ZERO, abi: BAL, fn: "balanceOf", args: [a] })));
  rows.forEach((x, i) => { x.ytAmt = x.yt ? ytBal[i] : null; });
  // dust left by rounding (1e-7 LP) is not money
  const some = (raw, dec) => raw > 0n && units(raw, dec) >= 1e-4;
  for (const x of rows) { if (!some(x.pt, x.dec)) x.pt = 0n; if (!some(x.ytAmt, x.dec)) x.ytAmt = 0n; if (!some(x.lp, 18)) x.lp = 0n; }
  const held = rows.filter((x) => x.pt > 0n || x.ytAmt > 0n || x.lp > 0n);
  if (!held.length) return [];
  const px = await prices(ctx, held.map((x) => x.und && `ethereum:${x.und.toLowerCase()}`));
  const out = [];
  for (const x of held) {
    const exp = new Date(Number(x.t.expiration) * 1000).toISOString().slice(0, 10), pr = x.und ? priceOf(px, `ethereum:${x.und.toLowerCase()}`) : null;
    if (x.pt > 0n) out.push({ category: "unstake_ready", chain: "ethereum", protocol: "Element v1", asset: `ePT-${x.t.name}`, token: x.t.address, amount: units(x.pt, x.dec), usd: pr == null ? null : units(x.pt, x.dec) * pr, status: "ready", part: "pt",
      action: `redeem the principal token (withdrawPrincipal(amount, you)), expired ${exp}`, how_to_claim: writeLink("ethereum", x.t.address), detail: `Element v1 ${x.t.name} tranche ${x.t.address}: a PT redeems 1:1 for the underlying after expiry` });
    if (x.ytAmt > 0n) out.push({ category: "reward", chain: "ethereum", protocol: "Element v1", asset: `eYT-${x.t.name}`, token: x.yt, amount: units(x.ytAmt, x.dec), usd: null, status: "ready", part: "yt",
      action: `redeem the yield token for its interest (withdrawInterest(amount, you)), expired ${exp}`, how_to_claim: writeLink("ethereum", x.t.address), detail: `Element v1 ${x.t.name} tranche ${x.t.address}: YT interest is paid by the tranche; the amount depends on the yield earned, so no price` });
    if (x.lp > 0n) out.push({ category: "unstake_ready", chain: "ethereum", protocol: "Element v1", asset: `LP ePT-${x.t.name}`, token: x.t.ptPool.address, amount: units(x.lp), usd: null, status: "ready", part: "lp",
      action: `exit the Element PT pool on Balancer, then redeem the PT, expired ${exp}`, how_to_claim: `https://app.balancer.fi/#/ethereum/pool/${x.t.ptPool.poolId}`, detail: `Balancer pool ${x.t.ptPool.address} of the ${x.t.name} tranche` });
  }
  return out;
}

async function entryPoints(ctx, a) {
  const out = [];
  await Promise.all(EP_CHAINS.map(async (chain) => {
    const bals = await multi(ctx, chain, Object.values(ENTRYPOINTS).map((to) => ({ to, abi: BAL, fn: "balanceOf", args: [a] })));
    const vers = Object.keys(ENTRYPOINTS).filter((_, i) => bals[i] >= 10n ** 14n);
    if (!vers.length) return;
    // an EOA (or a 7702 delegated EOA) can call withdrawTo itself; a smart account needs a function that does it
    const code = await rpcCall(ctx, chain, "eth_getCode", [a, "latest"]).catch(() => null);
    const eoa = code === "0x" || (typeof code === "string" && code.startsWith("0xef0100"));
    for (const v of vers) {
      const amt = units(bals[Object.keys(ENTRYPOINTS).indexOf(v)]);
      out.push({ category: "reward", chain, protocol: `ERC-4337 EntryPoint ${v}`, asset: NATIVE[chain] || "ETH", token: "native", amount: amt, usd: null, status: eoa ? "ready" : "contract",
        action: `withdraw the gas deposit (withdrawTo(you, amount) on EntryPoint ${v})`, how_to_claim: writeLink(chain, ENTRYPOINTS[v]),
        detail: eoa ? `gas deposit held for this address by EntryPoint ${v} on ${chain}` : `gas deposit of this smart account on EntryPoint ${v} (${chain}): it needs a function that calls withdrawTo; many accounts have one, some do not` });
    }
  }));
  out.sort((x, y) => `${x.chain}${x.protocol}`.localeCompare(`${y.chain}${y.protocol}`)); // same price call whatever order chains answer in
  if (out.length) {
    const key = (x) => `coingecko:${NATIVE_ID[x.asset]}`;
    const px = await prices(ctx, out.map(key));
    for (const x of out) { const pr = priceOf(px, key(x)); if (pr != null) x.usd = x.amount * pr; }
  }
  return out;
}

// Lighter: a pending balance per asset (asset ids 1..14 registered by 2026-10-20); token amount = base x tickSize
async function lighter(ctx, a) {
  const ids = Array.from({ length: LIGHTER.assets }, (_, i) => i + 1);
  const CFG = ["function assetConfigs(uint16) view returns (address tokenAddress, uint8 withdrawalsEnabled, uint56 extensionMultiplier, uint128 tickSize, uint64 depositCapTicks, uint64 minDepositTicks)"];
  const PB = ["function getPendingBalance(address _owner, uint16 _assetIndex) view returns (uint128)", "function getPendingBalanceLegacy(address _owner) view returns (uint128)"];
  const res = await multi(ctx, "ethereum", [...ids.map((i) => ({ to: LIGHTER.zk, abi: PB, fn: "getPendingBalance", args: [a, i] })), { to: LIGHTER.zk, abi: PB, fn: "getPendingBalanceLegacy", args: [a] }]);
  const due = ids.map((id, k) => ({ id, base: res[k] ?? 0n })).filter((x) => x.base > 0n);
  const legacy = res[ids.length] ?? 0n;
  if (legacy > 0n) due.push({ id: LIGHTER.usdcIndex, base: legacy, legacy: true });
  if (!due.length) return [];
  const cfg = await multi(ctx, "ethereum", due.map((x) => ({ to: LIGHTER.zk, abi: CFG, fn: "assetConfigs", args: [x.id] })));
  const META = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
  const meta = await multi(ctx, "ethereum", cfg.flatMap((c) => { const to = c && c[0] !== ZERO ? c[0] : ZERO; return [{ to, abi: META, fn: "decimals" }, { to, abi: META, fn: "symbol" }]; }));
  const dec = cfg.map((_, k) => meta[k * 2]), sym = cfg.map((_, k) => meta[k * 2 + 1]);
  const rows = due.map((x, k) => {
    const c = cfg[k], native = !c || c[0] === ZERO, raw = x.base * (c ? c[3] : 1n);
    return { ...x, token: native ? "native" : c[0].toLowerCase(), asset: native ? "ETH" : sym[k] || "?", amount: units(raw, native ? 18 : dec[k] ?? 18) };
  });
  const px = await prices(ctx, rows.map((x) => (x.token === "native" ? "coingecko:ethereum" : `ethereum:${x.token}`)));
  return rows.map((x) => {
    const pr = priceOf(px, x.token === "native" ? "coingecko:ethereum" : `ethereum:${x.token}`);
    return { category: "bridge_stuck", chain: "ethereum", protocol: "Lighter", asset: x.asset, token: x.token, amount: x.amount, usd: pr == null ? null : x.amount * pr, status: "ready",
      action: `collect the Lighter withdrawal waiting on Ethereum (${x.legacy ? "withdrawPendingBalanceLegacy" : `withdrawPendingBalance(you, ${x.id}, amount)`})`, how_to_claim: "https://app.lighter.xyz",
      detail: `${x.asset} withdrawn from Lighter and waiting in the ZkLighter contract ${LIGHTER.zk} (asset ${x.id}${x.legacy ? ", legacy pending balance" : ""})` };
  });
}

export async function deadApps(p, ctx) {
  if (p.address == null || p.address === "") throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
  const a = p.address;
  const all = { glp: () => glp(ctx, a), element: () => element(ctx, a), entrypoint: () => entryPoints(ctx, a), lighter: () => lighter(ctx, a) };
  const want = p.parts ? String(p.parts).split(",").map((x) => x.trim()).filter((x) => all[x]) : Object.keys(all);
  return each(Object.fromEntries(want.map((k) => [k, all[k]])));
}
