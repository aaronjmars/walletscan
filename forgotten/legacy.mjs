// forgotten/legacy.mjs - money left in protocols and chains that stopped (read 2026-10-22).
//
// alpaca2: Alpaca Finance closed in 2025 (new positions off in June, withdrawals promised to 2025-12-31), but the
// Alpaca 2.0 money market on BSC (diamond 0x7389aaf2, account manager 0xD20B8876, MiniFL 0x4579587A) still holds
// the cash and pays out. Lenders' ibTokens sit staked for them in MiniFL, funded by the account manager
// (depositAndStake); ibTokens a wallet put up as collateral are staked in MiniFL for the wallet too, funded by the
// money market, and are listed per sub account by the money market with any debt next to them. An ibToken is worth
// convertToAssets of its token, paid out of the market's cash: a market lent out to borrowers (THE) pays later or
// never, so only what it holds now counts. rewards.bnb_farms (forgotten/bnb.mjs) counts v1 ibTokens not yet moved by
// claimFor; the v1 vault holds the 2.0 ibTokens for those until then, so nothing is counted twice.
//
// Not built (2026-10-22): Stargate veSTG fees on Fantom (the Fantom distributor 0x9895D81b in stargate.finance's
// own config never received any USDC and has no claim; the old fee distributor 0xAF667811 there is empty too: nothing
// to claim). D8X (the Arbitrum USDC pool is stopped, "not running", its 5 queued LP withdrawals since 2025-06-17
// cannot execute; the live stUSD pool cannot start a withdrawal, withdrawLiquidity is not routed by the proxy; the
// Berachain pools hold a D8X composite bUSD with no market price and need a fresh oracle feed to withdraw; about $8k
// in all, mostly in 2 or 3 wallets). Agglayer exits of chains other than Silicon (bridge.agglayer) and Polygon zkEVM
// (bridge.polygon_zkevm): no keyless service lists a wallet's exits (X Layer's bridge API answers 410 retired, Astar
// zkEVM closed in 2025 without one, Katana and the gateway.fm CDK chains go through Polygon's keyed API gateway).
//
// mmFinance: MM Finance (mm.finance is down) left LP staked in its MasterChefs on Cronos (0x6bE34986, about $560k
// of LP still in it) and Polygon (0xa2B41708, about $20k). The Cronos chef can no longer mint MMF ("caller is not the
// minter"), so withdraw() reverts there; emergencyWithdraw(pid) still hands the LP back (the pending MMF, worth about
// nothing, is dropped). The Polygon chef still mints, withdraw works. rewards.dead_dexes values MM Finance LP held in
// the wallet; LP staked in a chef is only here. The Arbitrum MM Finance is not covered (no farm contract found). A
// staked pair is valued like dead_dexes does: the wallet's share of each reserve (the lower of reserve and the
// pair's balance), DefiLlama prices, a 3-day-old quote is no price.
import { multiOn, pricesOf, trustedPrice, tokenKey, needEvm, round, units, writeLink, parts } from "./anyrpc.mjs";
import { staleQuote, countedLegs } from "./dexes.mjs";

// ---- Alpaca 2.0 (BSC)
const AF2 = { mm: "0x7389aaf2e32872cABD766D0CEB384220e8F2A590", manager: "0xD20B887654dB8dC476007bdca83d22Fa51e93407", minifl: "0x4579587AE043131999cE3d9C66199726972E3Fb7" };
// [MiniFL pool id, ibToken, token] of each market (the money market's .mainnet.json plus the 2 later markets)
const AF2_MARKETS = [
  [1, "0x2928623eFF453Fb8C9BC744041637a4D2D5Fc56b", "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c"], // WBNB
  [3, "0x547593f6aFa897bb05828FBb8D587Ca31D9fF519", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d"], // USDC
  [5, "0x90476BFEF61F190b54a439E2E98f8E43Fb9b4a45", "0x55d398326f99059fF775485246999027B3197955"], // USDT
  [7, "0x3f38BA29AcC107E6F0b059a17c9bAb0598d0f249", "0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56"], // BUSD
  [9, "0x6C9Cb3739d6B390A4BAcc4D5F0a2629cF5c383B3", "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c"], // BTCB
  [11, "0x0A4FE32De91bE99a3EFAC80F6576976293B95369", "0x2170Ed0880ac9A755fd29B2688956BD959F933F8"], // ETH
  [13, "0x0c9E2653B17b60E9aD9465D1cF478bD6d76a03F0", "0x5f4Bde007Dc06b867f86EBFE4802e34A1fFEEd63"], // HIGH
  [15, "0x848204278E491f5f15B3F2dce593e6af9552b372", "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82"], // CAKE
  [17, "0xACb41b8bddF67727F07bf375b01edC40Ed51c4ff", "0x1D2F0da169ceB9fC7B3144628dB156f3F6c60dBE"], // XRP
  [19, "0x72Ad41ecf9C6C1171F19FaCCBA2b347D64AFe57f", "0xbA2aE424d960c26247Dd6c32edC70B295c744C43"], // DOGE
  [21, "0x42b2D846785636CfB393b5EC48C6581f47c37EC3", "0x4338665CBB7B2485A8855A139b75D5e34AB0DB94"], // LTC
  [23, "0x91E3A9B3f5a2c02Dd5cd40733fe4d52a87A213d9", "0xF4C8E32EaDEC4BFe97E0F595AdD0f4450a863a11"], // THE
  [25, "0x674d38092D177A9b074e5CAA5D45315eaAcEc790", "0x3EE2200Efb3400fAbB9AacF31297cBdD1d435D47"], // ADA
  [27, "0x86be7A7dd35c0A0E10824E29e4bF862697337341", "0xa2E3356610840701BDf5611a53974510Ae27E2e1"], // wBETH
];
const AF2_SUBS = [0, 1, 2]; // sub accounts the app used; collateral and debt are kept per sub account
const AF2_ABI = [
  "struct Node { address token; uint256 amount; }",
  "function getUserAmountFundedBy(address funder, address user, uint256 pid) view returns (uint256)",
  "function getAllSubAccountCollats(address account, uint256 subAccountId) view returns (Node[])",
  "function getOverCollatDebtSharesOf(address account, uint256 subAccountId) view returns (Node[])",
  "function getOverCollatTokenDebt(address token) view returns (uint256 debtShares, uint256 debtValue)",
  "function getFloatingBalance(address token) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)",
];
const lc = (a) => String(a).toLowerCase();

export async function alpaca2(p, ctx) {
  needEvm(p);
  const a = p.address, M = AF2_MARKETS;
  // 1 call: what MiniFL holds for the wallet, ibTokens in the wallet, each ib's rate and decimals, collateral + debt per sub account
  const r = await multiOn(ctx, "bsc", [
    ...M.flatMap(([pid, ib, tok]) => [
      { to: AF2.minifl, abi: AF2_ABI, fn: "getUserAmountFundedBy", args: [AF2.manager, a, BigInt(pid)] }, { to: ib, abi: AF2_ABI, fn: "balanceOf", args: [a] },
      { to: ib, abi: AF2_ABI, fn: "decimals" }, { to: tok, abi: AF2_ABI, fn: "symbol" },
    ]),
    ...AF2_SUBS.flatMap((s) => [{ to: AF2.mm, abi: AF2_ABI, fn: "getAllSubAccountCollats", args: [a, BigInt(s)] }, { to: AF2.mm, abi: AF2_ABI, fn: "getOverCollatDebtSharesOf", args: [a, BigInt(s)] }]),
  ]);
  const mk = new Map(M.map(([pid, ib, tok], i) => [lc(ib), { pid, ib, tok: lc(tok), staked: r[i * 4] || 0n, held: r[i * 4 + 1] || 0n, dec: r[i * 4 + 2] == null ? 18 : Number(r[i * 4 + 2]), sym: r[i * 4 + 3] }]));
  const byTok = new Map([...mk.values()].map((m) => [m.tok, m]));
  const base = M.length * 4;
  const subs = AF2_SUBS.map((s, k) => ({ s, collats: (r[base + k * 2] || []).filter((n) => n.amount > 0n), debts: (r[base + k * 2 + 1] || []).filter((n) => n.amount > 0n) }))
    .filter((x) => x.collats.length || x.debts.length);
  // MiniFL keeps each stake by who funded it: the account manager for lending (only it can unstake that part), the
  // money market for ib collateral (listed per sub account below), so the two never overlap
  const lend = [...mk.values()].map((m) => ({ m, ib: m.staked, held: m.held })).filter((x) => x.ib > 0n || x.held > 0n);
  if (!lend.length && !subs.length) return { items: [], errors: [] };
  // second call: ib -> token rates of the markets in play, the cash the market holds of each (an ibToken pays out of
  // it: a market lent out to borrowers pays later), the debt totals for share -> amount, decimals and symbols of plain collateral tokens
  const ibs = [...new Set([...lend.map((x) => lc(x.m.ib)), ...subs.flatMap((x) => x.collats.map((n) => lc(n.token)).filter((t) => mk.has(t)))])];
  const debtToks = [...new Set(subs.flatMap((x) => x.debts.map((n) => lc(n.token))))];
  const plain = [...new Set(subs.flatMap((x) => x.collats.map((n) => lc(n.token)).filter((t) => !mk.has(t) && !byTok.has(t))))];
  const r2 = await multiOn(ctx, "bsc", [
    ...ibs.flatMap((ib) => [{ to: ib, abi: AF2_ABI, fn: "convertToAssets", args: [10n ** BigInt(mk.get(ib).dec)] }, { to: AF2.mm, abi: AF2_ABI, fn: "getFloatingBalance", args: [mk.get(ib).tok] }]),
    ...debtToks.map((t) => ({ to: AF2.mm, abi: AF2_ABI, fn: "getOverCollatTokenDebt", args: [t] })),
    ...plain.flatMap((t) => [{ to: t, abi: AF2_ABI, fn: "decimals" }, { to: t, abi: AF2_ABI, fn: "symbol" }]),
  ]);
  const rate = new Map(ibs.map((ib, i) => [ib, r2[2 * i]]));
  const cash = new Map(ibs.map((ib, i) => [mk.get(ib).tok, r2[2 * i + 1] == null ? null : Number(r2[2 * i + 1]) / 10 ** mk.get(ib).dec]));
  const n2 = ibs.length * 2;
  const debtTot = new Map(debtToks.map((t, i) => [t, r2[n2 + i]]));
  const plainInfo = new Map(plain.map((t, i) => [t, { dec: r2[n2 + debtToks.length + i * 2], sym: r2[n2 + debtToks.length + i * 2 + 1] }]));
  // an ib leg the market cannot pay in full now (its cash is lent out): "queued", with what it holds today
  const short = (l) => (cash.get(l.token) != null && l.ib && cash.get(l.token) < l.amount ? `the market holds only ${round(cash.get(l.token), 6)} ${l.asset} now (the rest is lent out and pays as borrowers repay)` : null);
  const px = await pricesOf(ctx, [...new Set([...mk.values()].map((m) => m.tok).concat(debtToks, plain))].map((t) => tokenKey("bsc", t)));
  // a token amount (raw) of `t`: an ibToken is valued through its rate, the rest as is
  const value = (t, raw) => {
    t = lc(t);
    const m = mk.get(t) || byTok.get(t), isIb = mk.has(t);
    const dec = m ? m.dec : Number(plainInfo.get(t)?.dec ?? 18), tok = m ? m.tok : t, sym = m ? m.sym : plainInfo.get(t)?.sym;
    const amount = isIb ? (Number(raw) / 10 ** dec) * (rate.get(t) == null ? NaN : Number(rate.get(t)) / 10 ** dec) : Number(raw) / 10 ** dec;
    const price = trustedPrice(px, tokenKey("bsc", tok));
    return { token: tok, asset: sym, ib: isIb, amount: Number.isFinite(amount) ? amount : null, usd: price == null || !Number.isFinite(amount) ? null : amount * price };
  };
  const how = "https://app.alpacafinance.org";
  const items = [];
  for (const x of lend) {
    const v = value(x.m.ib, x.ib + x.held);
    if (v.amount == null) continue;
    // usd counts only what the market can pay today; the lent-out rest may never come back (Alpaca is closed)
    const wait = short(v), now = wait && v.usd != null ? (v.usd * cash.get(v.token)) / v.amount : v.usd;
    items.push({
      category: "exchange_balance", chain: "bsc", protocol: "Alpaca Finance 2.0", asset: v.asset, token: v.token, amount: round(v.amount, 8), usd: round(now), status: wait ? "queued" : "ready", deadline: null,
      action: x.ib > 0n ? `withdraw from Alpaca 2.0 lending: unstakeAndWithdraw(${x.m.ib}, ${x.ib}) on the account manager (or the app while it is up)` : `redeem the Alpaca 2.0 ${x.m.sym} ibToken: withdraw(${x.m.ib}, ${x.held}) on the account manager`,
      how_to_claim: `https://bscscan.com/address/${AF2.manager}#writeProxyContract`,
      detail: `Alpaca 2.0 lending: ${round(Number(x.ib + x.held) / 10 ** x.m.dec, 6)} ib${x.m.sym} (${x.ib > 0n ? "staked in MiniFL" : ""}${x.ib > 0n && x.held > 0n ? " + " : ""}${x.held > 0n ? "in the wallet" : ""}) worth ${round(v.amount, 6)} ${x.m.sym}; ${wait || "Alpaca Finance closed in 2025, the money market still pays out"} (${how})`,
    });
  }
  for (const x of subs) {
    const legs = x.collats.map((n) => value(n.token, n.amount)).filter((l) => l.amount != null);
    const debts = x.debts.map((n) => {
      const t = debtTot.get(lc(n.token)), raw = t && t[0] > 0n ? (n.amount * t[1]) / t[0] : null;
      return raw == null ? null : value(n.token, raw);
    }).filter(Boolean);
    const collatUsd = legs.reduce((s, l) => s + (l.usd || 0), 0), debtUsd = debts.reduce((s, l) => s + (l.usd || 0), 0);
    const unpriced = legs.filter((l) => l.usd == null).length + debts.filter((l) => l.usd == null).length;
    if (!legs.length || collatUsd - debtUsd <= 0 && !unpriced) continue;
    const main = legs.slice().sort((p1, p2) => (p2.usd || 0) - (p1.usd || 0))[0];
    const owe = debts.map((d) => `${round(d.amount, 6)} ${d.asset}`).join(" + ");
    const wait = legs.map(short).filter(Boolean);
    items.push({
      category: "exchange_balance", chain: "bsc", protocol: "Alpaca Finance 2.0", asset: legs.length === 1 ? main.asset : `${main.asset} +${legs.length - 1}`, token: main.token,
      amount: legs.length === 1 ? round(main.amount, 8) : round(collatUsd - debtUsd, 2), usd: round(collatUsd - debtUsd), status: wait.length ? "queued" : "ready", deadline: null, unpriced,
      legs: legs.map((l) => ({ token: l.token, asset: l.asset, amount: round(l.amount, 8), usd: round(l.usd) })),
      action: debts.length ? `repay ${owe} on Alpaca 2.0 sub account ${x.s}, then removeCollateralAndWithdraw on the account manager` : `take back the collateral of Alpaca 2.0 sub account ${x.s}: removeCollateralAndWithdraw on the account manager (or the app while it is up)`,
      how_to_claim: `https://bscscan.com/address/${AF2.manager}#writeProxyContract`,
      detail: `Alpaca 2.0 collateral in sub account ${x.s}: ${legs.map((l) => `${round(l.amount, 6)} ${l.asset}`).join(" + ")}${debts.length ? `, debt ${owe} (usd is collateral minus debt)` : ", no debt"}; ${wait.join("; ") || "Alpaca Finance closed in 2025, the money market still pays out"}`,
    });
  }
  return { items, errors: [] };
}

// ---- MM Finance (Cronos, Polygon)
// chain -> [MasterChef, poolLength() when read 2026-10-22 (the farms are dead, no pool gets added), can it still mint
// MMF (withdraw works) or not (only emergencyWithdraw)]; checked with eth_call from stakers on 2026-10-22
const MMF_CHEFS = { cronos: ["0x6bE34986Fdd1A91e4634eb6b9F8017439b7b5EDc", 47, false], polygon: ["0xa2B417088D63400d211A4D5EB3C4C5363f834764", 20, true] };
const CHEF = [
  "function userInfo(uint256 pid, address user) view returns (uint256 amount, uint256 rewardDebt)",
  "function poolInfo(uint256 pid) view returns (address lpToken, uint256 allocPoint, uint256 lastRewardBlock, uint256 accMeerkatPerShare)",
];
const PAIR = [
  "function token0() view returns (address)", "function token1() view returns (address)", "function totalSupply() view returns (uint256)",
  "function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)",
  "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)",
];

export async function mmFinance(p, ctx) {
  needEvm(p);
  const out = await parts(Object.fromEntries(Object.keys(MMF_CHEFS).map((chain) => [chain, () => mmChef(p.address, chain, ctx)])));
  if (out.errors.length === Object.keys(MMF_CHEFS).length) throw { status: 502, error: out.errors.join("; ") };
  return out;
}

async function mmChef(a, chain, ctx) {
  const [MMF_CHEF, MMF_POOLS, mints] = MMF_CHEFS[chain];
  const r = await multiOn(ctx, chain, Array.from({ length: MMF_POOLS }, (_, i) => [
    { to: MMF_CHEF, abi: CHEF, fn: "userInfo", args: [BigInt(i), a] }, { to: MMF_CHEF, abi: CHEF, fn: "poolInfo", args: [BigInt(i)] },
  ]).flat());
  const staked = [];
  for (let i = 0; i < MMF_POOLS; i++) if (r[2 * i]?.[0] > 0n && r[2 * i + 1]) staked.push({ pid: i, raw: r[2 * i][0], lp: r[2 * i + 1][0] });
  if (!staked.length) return [];
  const meta = await multiOn(ctx, chain, staked.flatMap((x) => ["token0", "token1", "totalSupply", "getReserves", "symbol"].map((fn) => ({ to: x.lp, abi: PAIR, fn }))));
  staked.forEach((x, i) => { const [t0, t1, ts, res, sym] = meta.slice(i * 5, i * 5 + 5); Object.assign(x, { t0, t1, ts, res, sym }); });
  const pairs = staked.filter((x) => x.t0 && x.t1 && x.res && x.ts > 0n);
  const toks = [...new Set(pairs.flatMap((x) => [lc(x.t0), lc(x.t1)]))];
  const tm = await multiOn(ctx, chain, [...toks.flatMap((t) => [{ to: t, abi: PAIR, fn: "decimals" }, { to: t, abi: PAIR, fn: "symbol" }]),
    ...pairs.flatMap((x) => [{ to: x.t0, abi: PAIR, fn: "balanceOf", args: [x.lp] }, { to: x.t1, abi: PAIR, fn: "balanceOf", args: [x.lp] }])]);
  const info = new Map(toks.map((t, i) => [t, { dec: tm[2 * i] == null ? 18 : Number(tm[2 * i]), sym: tm[2 * i + 1] || "?" }]));
  pairs.forEach((x, i) => { x.bal = [tm[toks.length * 2 + 2 * i], tm[toks.length * 2 + 2 * i + 1]]; });
  // single-token pools (the MMF pool) and non-pair LPs (3MM stable pools) are valued at the LP token's own price, if any
  const px = await pricesOf(ctx, [...toks, ...staked.filter((x) => !pairs.includes(x)).map((x) => lc(x.lp))].map((t) => tokenKey(chain, t)));
  const fresh = (t) => (staleQuote(px.get(tokenKey(chain, t))) ? null : trustedPrice(px, tokenKey(chain, t)));
  const items = [];
  const exit = (x) => (mints ? `take the LP back with withdraw(${x.pid}, ${x.raw}) on the MM Finance MasterChef`
    : `take the LP back with emergencyWithdraw(${x.pid}) on the MM Finance MasterChef (withdraw reverts: the chef can no longer mint MMF; the pending MMF is dropped)`);
  for (const x of staked) {
    if (pairs.includes(x)) {
      const share = Number(x.raw) / Number(x.ts), low = (rv, b) => (b != null && b < rv ? b : rv);
      const legs = [[x.t0, x.res[0], x.bal[0]], [x.t1, x.res[1], x.bal[1]]].map(([t, rv, b]) => {
        const m = info.get(lc(t)), amount = units(low(rv, b), m.dec) * share, price = fresh(t);
        return { token: lc(t), asset: m.sym, amount: round(amount, 6), usd: price == null ? null : round(amount * price) };
      });
      const { priced, imbalanced } = countedLegs(legs);
      if (!priced.length) continue;
      items.push({
        category: "token_migration", chain, protocol: "MM Finance", asset: `${legs[0].asset}-${legs[1].asset} LP`, token: lc(x.lp), amount: units(x.raw, 18),
        usd: round(priced.reduce((t, l) => t + l.usd, 0)), legs, unpriced: legs.length - priced.length, status: "ready", deadline: null, ...(imbalanced && { imbalanced: true }),
        action: `${exit(x)}, then send the LP to the pair ${x.lp} and call burn(your address) on it`,
        how_to_claim: writeLink(chain, MMF_CHEF),
        detail: `MM Finance LP staked in the MasterChef (pool ${x.pid}, pair ${x.lp}): your share = ${legs.map((l) => `${l.amount} ${l.asset}`).join(" + ")}; mm.finance is down and the farm stopped paying${imbalanced ? "; the two legs are priced more than 3x apart, so only the smaller one counts" : ""}`,
      });
    } else {
      const price = fresh(x.lp), amount = units(x.raw, 18);
      if (price == null || amount * price < 0.01) continue; // MMF itself trades at ~$0.0001: dust
      items.push({
        category: "token_migration", chain, protocol: "MM Finance", asset: x.sym || "LP", token: lc(x.lp), amount: round(amount, 6), usd: round(amount * price), status: "ready", deadline: null,
        action: exit(x), how_to_claim: writeLink(chain, MMF_CHEF),
        detail: `MM Finance MasterChef pool ${x.pid}: ${round(amount, 6)} ${x.sym || x.lp} staked; mm.finance is down and the farm stopped paying`,
      });
    }
  }
  return items;
}
