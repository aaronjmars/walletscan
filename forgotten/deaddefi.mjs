// forgotten/deaddefi.mjs - rewards.dead_defi: tokens of dead DeFi protocols that still redeem for their underlying
// (the 46-token Ethereum list deaddefi.com scans: Aave v1, dForce, PieDAO, Pickle jars, Index Coop, PowerPool,
// Set v1, Indexed, BasketDAO, Cook, Domani, Degenerative) and the Pickle Finance USDC merkle distribution
// (deaddefi.com/pickle). One Multicall3 balanceOf over the list, then each held token is valued with its own redeem
// math (exchange rate, pro-rata pool share, set units) and DefiLlama prices for what it pays out.
import { readFileSync } from "node:fs";
import { isEvmAddr } from "../solana.mjs";
import { read, multi, prices, priceOf, llamaKey, units, big, each, ZERO } from "./evm.mjs";

export const TOKENS = JSON.parse(readFileSync(new URL("./deaddefi-tokens.json", import.meta.url), "utf8"));
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const AAVE_V1_CORE = "0x3dfd23A6c5E8BbcFc9581d2E864a68feb6a076d3"; // LendingPoolCore: getReserveAvailableLiquidity
const PICKLE = { distributor: "0x63a9Fd263688BB3B7c79305cdD5D91Fb064D7865", usdc: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" };
const E18 = 10n ** 18n;

const A = {
  erc20: ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function totalSupply() view returns (uint256)"],
  ctoken: ["function exchangeRateStored() view returns (uint256)", "function getCash() view returns (uint256)", "function controller() view returns (address)"],
  dforceCtl: ["function calcAccountEquity(address) view returns (uint256, uint256, uint256, uint256)"],
  aaveCore: ["function getReserveAvailableLiquidity(address) view returns (uint256)"],
  pie: ["function calcTokensForAmount(uint256) view returns (address[], uint256[])"],
  jar: ["function getRatio() view returns (uint256)"],
  setv2: ["function getComponents() view returns (address[])", "function getDefaultPositionRealUnit(address) view returns (int256)"],
  bpool: ["function getCurrentTokens() view returns (address[])", "function getBalance(address) view returns (uint256)", "function totalSupply() view returns (uint256)"],
  basket: ["function getAssetsAndBalances() view returns (address[], uint256[])", "function totalSupply() view returns (uint256)"],
  rebal: ["function currentSet() view returns (address)", "function unitShares() view returns (uint256)", "function naturalUnit() view returns (uint256)"],
  set1: ["function getComponents() view returns (address[])", "function getUnits() view returns (uint256[])", "function naturalUnit() view returns (uint256)"],
  pickle: ["function claimed(address) view returns (bool)"],
};

const outs = (tokens, raws) => tokens.map((t, i) => ({ token: String(t).toLowerCase(), raw: big(raws[i]) })).filter((o) => o.raw > 0n);
const cover = (have, want) => (have == null ? null : have >= want ? "covers" : have > 0n ? "partial" : "none");

// per valuation kind: what `bal` of token t redeems for, read from the token's own contracts
// -> { outputs [{token, raw}], liquidity: covers | partial | none | strategy | null, debt_usd? }
const VALUE = {
  // dForce iToken: underlying = bal x exchangeRateStored / 1e18, paid from getCash(); the controller says if the
  // wallet borrowed against it (values scaled 1e36 USD)
  async ctoken(ctx, t, bal, owner) {
    const [rate, cash, ctl] = await multi(ctx, "ethereum", ["exchangeRateStored", "getCash", "controller"].map((fn) => ({ to: t.address, abi: A.ctoken, fn })));
    if (rate == null) throw new Error("exchangeRateStored reverted");
    const raw = (bal * rate) / E18;
    const eq = ctl ? await read(ctx, "ethereum", ctl, A.dforceCtl, "calcAccountEquity", [owner]).catch(() => null) : null;
    const debt = eq ? Number(eq[3] / 10n ** 30n) / 1e6 : 0;
    return { outputs: [{ token: t.underlying, raw }], liquidity: cover(cash, raw), ...(debt > 0 && { debt_usd: debt }) };
  },
  // Aave v1 aToken: 1:1 underlying (balanceOf includes interest), paid from the reserve's available liquidity
  async atoken_v1(ctx, t, bal) {
    const liq = await read(ctx, "ethereum", AAVE_V1_CORE, A.aaveCore, "getReserveAvailableLiquidity", [t.underlying]).catch(() => null);
    return { outputs: [{ token: t.underlying, raw: bal }], liquidity: cover(liq, bal) };
  },
  // PieDAO smart pool: exitPool(bal) pays calcTokensForAmount(bal); a paused proxy reverts
  async pie(ctx, t, bal) {
    const [tokens, raws] = await read(ctx, "ethereum", t.address, A.pie, "calcTokensForAmount", [bal]);
    return { outputs: outs(tokens, raws), liquidity: "covers" };
  },
  // Pickle jar: underlying = bal x getRatio / 1e18; idle underlying in the jar pays first, the rest comes back from
  // the jar's strategy on withdraw
  async pickle_jar(ctx, t, bal) {
    const [ratio, idle] = await multi(ctx, "ethereum", [{ to: t.address, abi: A.jar, fn: "getRatio" }, { to: t.underlying, abi: A.erc20, fn: "balanceOf", args: [t.address] }]);
    if (ratio == null) throw new Error("getRatio reverted");
    const raw = (bal * ratio) / E18;
    return { outputs: [{ token: t.underlying, raw }], liquidity: idle != null && idle >= raw ? "covers" : "strategy" };
  },
  // Set v2 (Index Coop, Cook, Domani): components x getDefaultPositionRealUnit per 1e18 set tokens
  async setv2(ctx, t, bal) {
    const comps = await read(ctx, "ethereum", t.address, A.setv2, "getComponents");
    const units_ = await multi(ctx, "ethereum", comps.map((c) => ({ to: t.address, abi: A.setv2, fn: "getDefaultPositionRealUnit", args: [c] })));
    return { outputs: outs(comps, units_.map((u) => (u != null && u > 0n ? (bal * u) / E18 : 0n))), liquidity: "covers" };
  },
  // Balancer-style index pool (PowerPool, Indexed): exitPool pays bal / totalSupply of every pool balance
  async bpool(ctx, t, bal) {
    const [tokens, supply] = await multi(ctx, "ethereum", [{ to: t.address, abi: A.bpool, fn: "getCurrentTokens" }, { to: t.address, abi: A.bpool, fn: "totalSupply" }]);
    if (!tokens || !supply) throw new Error("getCurrentTokens reverted");
    const bals = await multi(ctx, "ethereum", tokens.map((x) => ({ to: t.address, abi: A.bpool, fn: "getBalance", args: [x] })));
    return { outputs: outs(tokens, bals.map((b) => (b == null ? 0n : (b * bal) / supply))), liquidity: "covers" };
  },
  // BasketDAO: burn(bal) pays bal / totalSupply of every basket asset
  async basket(ctx, t, bal) {
    const [ab, supply] = await multi(ctx, "ethereum", [{ to: t.address, abi: A.basket, fn: "getAssetsAndBalances" }, { to: t.address, abi: A.basket, fn: "totalSupply" }]);
    if (!ab || !supply) throw new Error("getAssetsAndBalances reverted");
    return { outputs: outs(ab[0], ab[1].map((b) => (b * bal) / supply)), liquidity: "covers" };
  },
  // Set v1 rebalancing set: bal x unitShares / naturalUnit base sets, each base set = units / naturalUnit components
  async setv1_rebal(ctx, t, bal) {
    const [cur, shares, nat] = await multi(ctx, "ethereum", ["currentSet", "unitShares", "naturalUnit"].map((fn) => ({ to: t.address, abi: A.rebal, fn })));
    if (!cur || shares == null || !nat) throw new Error("currentSet reverted");
    const [comps, u, n] = await multi(ctx, "ethereum", ["getComponents", "getUnits", "naturalUnit"].map((fn) => ({ to: cur, abi: A.set1, fn })));
    if (!comps || !u || !n) throw new Error("base set reverted");
    const base = (bal * shares) / nat;
    return { outputs: outs(comps, u.map((x) => (base * x) / n)), liquidity: "covers" };
  },
  // no redeem view: the token's own DefiLlama price, if any
  async price() { return { outputs: [], liquidity: null }; },
};

const fmt = (n) => (n >= 1000 ? n.toLocaleString("en-US", { maximumFractionDigits: 2 }) : String(Number(n.toPrecision(6))));

async function catalog(ctx, owner) {
  const bals = await multi(ctx, "ethereum", TOKENS.map((t) => ({ to: t.address, abi: A.erc20, fn: "balanceOf", args: [owner] })));
  const held = TOKENS.map((t, i) => ({ t, bal: bals[i] ?? 0n })).filter((h) => h.bal > 0n);
  if (!held.length) return [];
  const valued = await Promise.all(held.map(async (h) => {
    try { return { ...h, ...(await VALUE[h.t.kind](ctx, h.t, h.bal, owner)), readable: true }; } catch { return { ...h, outputs: [], liquidity: null, readable: false }; }
  }));
  // output token facts: DefiLlama price (+ decimals, symbol), else decimals/symbol from the token itself
  const outTokens = [...new Set(valued.flatMap((v) => v.outputs.map((o) => o.token)))];
  const key = (tok) => llamaKey("ethereum", tok === NATIVE ? ZERO : tok);
  const px = await prices(ctx, [...outTokens.map(key), ...held.map((h) => key(h.t.address))]);
  const erc = outTokens.filter((tok) => tok !== NATIVE && px.get(key(tok))?.decimals == null);
  const meta = erc.length ? await multi(ctx, "ethereum", erc.flatMap((tok) => [{ to: tok, abi: A.erc20, fn: "decimals" }, { to: tok, abi: A.erc20, fn: "symbol" }])) : [];
  const info = new Map(erc.map((tok, i) => [tok, { decimals: meta[2 * i], symbol: meta[2 * i + 1] }]));
  const tokInfo = (tok) => {
    if (tok === NATIVE) return { decimals: 18, symbol: "ETH" };
    const p = px.get(key(tok)), m = info.get(tok) || {};
    return { decimals: p?.decimals ?? (m.decimals == null ? null : Number(m.decimals)), symbol: p?.symbol || (typeof m.symbol === "string" ? m.symbol : null) };
  };

  return valued.map((v) => {
    const { t, bal } = v, amount = units(bal, t.decimals);
    const outputs = v.outputs.map((o) => {
      const ti = tokInfo(o.token), amt = ti.decimals == null ? null : units(o.raw, ti.decimals), p = priceOf(px, key(o.token));
      return { token: o.token, symbol: ti.symbol, amount: amt, usd: amt != null && p != null ? amt * p : null };
    });
    const unpriced = outputs.filter((o) => o.usd == null).length;
    const own = priceOf(px, key(t.address));
    let usd = null, valued_by = null;
    if (outputs.length && unpriced < outputs.length) { usd = outputs.reduce((s, o) => s + (o.usd ?? 0), 0); valued_by = "contract"; }
    else if (own != null) { usd = amount * own; valued_by = "price"; }
    const status = v.readable ? t.status : "unreadable";
    const pays = outputs.filter((o) => o.amount != null).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
    const paysText = pays.length === 1 ? `${fmt(pays[0].amount)} ${pays[0].symbol || pays[0].token}` : pays.length ? `${pays.length} tokens (${pays.slice(0, 4).map((o) => o.symbol || o.token.slice(0, 8)).join(", ")}${pays.length > 4 ? ", ..." : ""})` : null;
    const notes = [
      `${t.symbol} is on deaddefi.com's list of wound-down ${t.protocol} tokens; it still redeems ${t.method === "router" ? "through the deaddefi.com router" : `with the token's own ${t.method}() or on deaddefi.com`}`,
      !v.readable && "its redeem view reverts now (contract paused or changed)",
      v.liquidity === "partial" && "the market holds less underlying than this balance: only part redeems now",
      v.liquidity === "none" && "the market holds no underlying to pay it out now",
      v.liquidity === "strategy" && "the jar pulls the underlying back from its strategy on withdraw",
      v.debt_usd > 0 && `this wallet has a $${fmt(v.debt_usd)} dForce loan secured by its deposits: repay it before redeeming all of it`,
      unpriced > 0 && valued_by === "contract" && `${unpriced} of ${outputs.length} payout tokens have no price (left out of usd)`,
      t.status === "limited" && "deaddefi.com marks this redeem path as limited",
    ].filter(Boolean);
    return {
      category: "token_migration", chain: "ethereum", protocol: t.protocol, asset: t.symbol, token: t.address, amount, usd,
      // market_price: DefiLlama's price for the dead token itself (null = no market: wallets and Zerion leave it unpriced)
      status, valued_by, liquidity: v.liquidity, unpriced, market_price: own, ...(v.debt_usd > 0 && { debt_usd: v.debt_usd }),
      outputs: outputs.map((o) => ({ ...o, usd: o.usd == null ? null : Math.round(o.usd * 100) / 100 })),
      action: `redeem ${fmt(amount)} ${t.symbol} (${t.protocol})${paysText ? ` for ${paysText}` : ""}`,
      how_to_claim: t.redeem, detail: notes.join("; "),
    };
  });
}

// Pickle Finance USDC distribution: one static merkle list (568 wallets), claimed(address) onchain
async function pickle(ctx, owner) {
  const r = await ctx.call("rewards.pickle_distribution", {});
  if (!r.ok) throw { status: 502, error: `step rewards.pickle_distribution failed (upstream ${r.status})` };
  const c = r.data?.claims?.[owner.toLowerCase()];
  if (!c || !(big(c.amount) > 0n)) return [];
  const [claimed, px] = await Promise.all([read(ctx, "ethereum", PICKLE.distributor, A.pickle, "claimed", [owner]), prices(ctx, [llamaKey("ethereum", PICKLE.usdc)])]);
  const amount = units(c.amount, 6), p = priceOf(px, llamaKey("ethereum", PICKLE.usdc));
  return [{
    category: "airdrop", chain: "ethereum", protocol: "Pickle Finance", asset: "USDC", token: PICKLE.usdc, amount, usd: p == null ? null : amount * p,
    status: claimed ? "claimed" : "ready", action: `claim ${fmt(amount)} USDC from the Pickle Finance distribution`,
    how_to_claim: "https://deaddefi.com/pickle", detail: `Pickle Finance wind-down payout (merkle claim on ${PICKLE.distributor}, no deadline)`,
  }];
}

export async function deadDefi(p, ctx) {
  if (p.address == null || p.address === "") throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
  const { items, errors } = await each({ catalog: () => catalog(ctx, p.address), pickle: () => pickle(ctx, p.address) });
  return { items: items.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)), errors };
}
