// forgotten/soldead.mjs - positions left in dead Solana apps (rewards.sol_dead_apps, read 2026-10-21): Sunny
// Aggregator vaults (Saber LP staked through Sunny; sunny.ag is parked), Friktion volts (volt tokens, pending deposits
// and withdrawals; the site closed in 2023, the volts stay withdraw-only) and Francium lending (fTokens in the wallet or
// staked in its reward pool; the lending program now runs in a wind-down build that still pays withdrawals). Account
// lists (Sunny pools + their Saber swaps, Friktion volts, Francium pools) are data/sol-dead-apps.json, built from the
// programs' own accounts. Francium leveraged farms are left out: in Sept 2026 its admin removed the strategies' LP
// and swept it to a custody account (AdminSweepCustody), so a farm position's value is no longer readable onchain.
import { readFileSync } from "node:fs";
import { isSolAddr, findPda, seed, ata } from "../solana.mjs";
import { each, prices, trusted } from "./evm.mjs";
import { b64, u64, key, scale, round, result, accounts, jupiter, tokenAmount, decimalsOf, priced } from "./solana.mjs";

export const SOL_DEAD = JSON.parse(readFileSync(new URL("../data/sol-dead-apps.json", import.meta.url), "utf8"));
const supplyOf = (acc) => { try { return BigInt(acc?.data?.parsed?.info?.supply ?? 0); } catch { return 0n; } };
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u128 = (d, o) => (d.length >= o + 16 ? d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n) : 0n);
const mulDiv = (a, b, c) => (c > 0n ? (a * b) / c : 0n);
const usdOf = (t, amount) => (priced(t) ? round(amount * t.price, 2) : null);
// Jupiter first (its verification + price); a mint Jupiter has no row for (unknown, or the call was rate limited in a
// busy scan) falls back to DefiLlama at confidence >= 0.9. A mint Jupiter lists as unverified stays unpriced
async function pricesFor(ctx, mints) {
  const jup = await jupiter(ctx, mints);
  const miss = [...new Set(mints.filter(Boolean))].filter((m) => !jup.has(m));
  if (!miss.length) return jup;
  const px = await prices(ctx, miss.map((m) => `solana:${m}`));
  for (const m of miss) { const c = trusted(px.get(`solana:${m}`.toLowerCase())); if (c) jup.set(m, { symbol: c.symbol, price: c.price, verified: true }); }
  return jup;
}
// the wallet's SPL token balances by mint (one getTokenAccountsByOwner, shared with scan.sol's own call through the cache)
async function walletTokens(ctx, owner) {
  const out = new Map();
  for (const a of (await result(ctx, "sol.token_accounts", { owner }))?.value || []) {
    const i = a.account?.data?.parsed?.info, raw = tokenAmount(a.account);
    if (i?.mint && raw > 0n) out.set(i.mint, (out.get(i.mint) || 0n) + raw);
  }
  return out;
}

// ---- Sunny ----------------------------------------------------------------------------------------------------
// sunny_pool_quarry (anchor IDL onchain; program id in DefiLlama-Adapters projects/sunny.js): Vault {pool @8, owner @40,
// vendor_balance u64 @81} = Saber LP staked in Saber's Quarry through the vault; LP the vault already pulled out
// (withdrawVendor done, withdrawFromVault not) sits in the vault's own ATA. Saber SwapInfo (saber-hq/stable-swap
// stable-swap-client/src/state.rs): reserves a @107, b @139, pool_mint @171, mint a @203, mint b @235
async function sunny(ctx, owner) {
  const rows = (await result(ctx, "sol.sunny_vaults", { owner })) || [];
  const pools = new Map(SOL_DEAD.sunny.pools.map((p) => [p.pool, p]));
  const vaults = rows.map((r) => { const d = b64(r.account); return { vault: r.pubkey, pool: pools.get(key(d, 8)), owner: key(d, 40), staked: u64(d, 81) }; }).filter((v) => v.owner === owner && v.pool?.swap);
  if (!vaults.length) return [];
  for (const v of vaults) v.idle = ata(v.vault, v.pool.lp);
  const idle = await accounts(ctx, vaults.map((v) => v.idle));
  for (const v of vaults) v.idleRaw = tokenAmount(idle.get(v.idle));
  const live = vaults.filter((v) => v.staked > 0n || v.idleRaw > 0n);
  if (!live.length) return [];
  const used = [...new Set(live.map((v) => v.pool))];
  const [acc, jup] = await Promise.all([accounts(ctx, used.flatMap((p) => [p.lp, p.a[0], p.a[1], p.b[0], p.b[1]])), pricesFor(ctx, used.flatMap((p) => [p.a[0], p.b[0]]))]);
  const items = [];
  for (const v of live) {
    const p = v.pool, supply = supplyOf(acc.get(p.lp)), lpDec = decimalsOf(acc.get(p.lp)), raw = v.staked + v.idleRaw;
    if (!(supply > 0n) || lpDec == null) continue;
    const share = Number(raw) / Number(supply);
    const legs = [p.a, p.b].map(([mint, reserve]) => {
      const t = jup.get(mint), dec = decimalsOf(acc.get(mint)), amount = dec == null ? 0 : scale(tokenAmount(acc.get(reserve)), dec) * share;
      return { token: mint, asset: t?.symbol || mint.slice(0, 6), amount: round(amount), usd: usdOf(t, amount) };
    });
    // a Saber withdraw pays both legs pro rata; a drained stable pool is lopsided, so legs are not checked against each other
    const counted = legs.filter((l) => l.usd != null);
    items.push({
      category: "unstake_ready", chain: "solana", protocol: "Sunny Aggregator", asset: `${legs[0].asset}-${legs[1].asset} Saber LP`, token: p.lp, amount: scale(raw, lpDec),
      usd: counted.length ? round(counted.reduce((t, l) => t + l.usd, 0), 2) : null, legs, unpriced: legs.length - counted.length, status: "ready",
      vault: v.vault, pool: v.pool.pool, swap: p.swap, staked: scale(v.staked, lpDec), in_vault: scale(v.idleRaw, lpDec),
      action: "claim the Saber LP stuck in Sunny on the SaberDAO claims portal (permissionless, open indefinitely), then withdraw the liquidity there",
      how_to_claim: "https://claim.saberdao.so/",
      detail: `Sunny vault ${v.vault} holds ${scale(raw, lpDec)} Saber LP (${scale(v.staked, lpDec)} staked in Quarry${v.idleRaw > 0n ? `, ${scale(v.idleRaw, lpDec)} already in the vault account` : ""}); your share of Saber swap ${p.swap} = ${legs.map((l) => `${l.amount} ${l.asset}`).join(" + ")}; sunny.ag is parked, the program still answers UnstakeInternal / WithdrawVendor / WithdrawFromVault`,
    });
  }
  return items;
}

// ---- Friktion -------------------------------------------------------------------------------------------------
// volt program (anchor IDL onchain; Friktion-Labs/sdk friktion-sdk/src/constants.ts): VoltVault {round_number @105,
// deposit_pool @169, writer_token_pool @265, vault_mint @297, deposit_mint @329, underlying_amount_per_contract @497};
// PendingDeposit {round @9, num_underlying_deposited @17} and PendingWithdrawal {round @9, num_volt_redeemed @17} are
// PDAs [volt, user, "pendingDeposit" | "pendingWithdrawal"]; Round {underlying_from_pending_deposits @16,
// volt_tokens_from_pending_withdrawals @24} = PDA [volt, round u64 LE, "roundInfo"]; ExtraVoltData
// turn_off_deposits_and_withdrawals @740. Value math = VoltSDK.getBalancesForUser (Friktion-Labs/sdk)
const FRIKTION = SOL_DEAD.friktion.program;
const FRIKTION_SDK = "https://github.com/Friktion-Labs/sdk/blob/master/examples/instructions/withdraw.ts";
const pda = (volt, ...rest) => findPda([volt, ...rest], FRIKTION).address;
const roundPda = (volt, n, tag) => pda(volt, u64le(n), seed(tag));

async function friktion(ctx, owner, wallet) {
  const volts = SOL_DEAD.friktion.volts.map((v) => ({ ...v, pd: pda(v.volt, owner, seed("pendingDeposit")), pw: pda(v.volt, owner, seed("pendingWithdrawal")) }));
  const [acc, held] = await Promise.all([accounts(ctx, volts.flatMap((v) => [v.pd, v.pw])), wallet]);
  const pending = (a) => { const d = b64(a); return d.length >= 25 ? { round: u64(d, 9), amount: u64(d, 17) } : null; };
  const touched = volts.map((v) => ({ ...v, dep: pending(acc.get(v.pd)), wd: pending(acc.get(v.pw)), shares: held.get(v.vault_mint) || 0n }))
    .filter((v) => v.dep?.amount > 0n || v.wd?.amount > 0n || v.shares > 0n);
  if (!touched.length) return [];
  for (const v of touched) v.extra = pda(v.volt, seed("extraVoltData"));
  const state = await accounts(ctx, touched.flatMap((v) => [v.volt, v.extra]));
  for (const v of touched) {
    const d = b64(state.get(v.volt)), x = b64(state.get(v.extra));
    Object.assign(v, { round: u64(d, 105), depositPool: key(d, 169), writerPool: key(d, 265), perContract: u64(d, 497), off: x.length > 740 && x[740] === 1 });
    v.keys = { cur: roundPda(v.volt, v.round, "roundInfo"), ...(v.dep && { depRound: roundPda(v.volt, v.dep.round, "roundInfo"), depTokens: roundPda(v.volt, v.dep.round, "roundVoltTokens") }), ...(v.wd && { wdRound: roundPda(v.volt, v.wd.round, "roundInfo"), wdTokens: roundPda(v.volt, v.wd.round, "roundUlPending") }) };
  }
  const [more, jup] = await Promise.all([
    accounts(ctx, touched.flatMap((v) => [v.depositPool, v.writerPool, v.vault_mint, v.deposit_mint, ...Object.values(v.keys)])),
    pricesFor(ctx, touched.map((v) => v.deposit_mint)),
  ]);
  const items = [];
  for (const v of touched) {
    const dec = decimalsOf(more.get(v.deposit_mint)), t = jup.get(v.deposit_mint);
    if (dec == null || !state.get(v.volt)) continue;
    const round_ = (k, o) => u64(b64(more.get(v.keys[k])), o);
    // a volt token is worth (deposit pool + writer tokens x underlying per contract) / (supply + tokens queued to burn)
    const tvl = tokenAmount(more.get(v.depositPool)) + tokenAmount(more.get(v.writerPool)) * v.perContract;
    const supply = supplyOf(more.get(v.vault_mint)) + round_("cur", 24);
    const worth = (tokens) => mulDiv(tokens, tvl, supply);
    const parts = [], vdec = decimalsOf(more.get(v.vault_mint)), atPool = "valued at the deposit pool per volt token";
    if (v.shares > 0n) parts.push({ part: "volt_tokens", category: "token_migration", raw: worth(v.shares), action: "withdraw from the volt with your volt tokens (withdraw)", note: `${scale(v.shares, vdec)} volt tokens in the wallet, ${atPool}` });
    if (v.dep?.amount > 0n) {
      // a deposit of the running round never entered the volt: cancelling returns it as is
      const now = v.dep.round === v.round, mintable = now ? 0n : mulDiv(v.dep.amount, tokenAmount(more.get(v.keys.depTokens)), round_("depRound", 16));
      parts.push(now ? { part: "pending_deposit", category: "unstake_ready", raw: v.dep.amount, action: "cancel the pending deposit (cancelPendingDeposit)", note: `deposit of round ${v.dep.round}, never entered the volt` }
        : { part: "pending_deposit", category: "unstake_ready", raw: worth(mintable), action: "claim the volt tokens of the old deposit (claimPendingDeposit), then withdraw", note: `deposit of round ${v.dep.round}: ${scale(mintable, vdec)} volt tokens waiting in the round account, ${atPool}` });
    }
    if (v.wd?.amount > 0n) {
      // a withdrawal of a past round was paid into that round's own account: the wallet's share of it, whatever the pool holds now
      const now = v.wd.round === v.round, claim = now ? worth(v.wd.amount) : mulDiv(v.wd.amount, tokenAmount(more.get(v.keys.wdTokens)), round_("wdRound", 24));
      parts.push({ part: "pending_withdrawal", category: "unstake_ready", raw: claim, action: now ? "cancel the pending withdrawal (cancelPendingWithdrawal), then withdraw" : "claim the old withdrawal (claimPendingWithdrawal)",
        note: now ? `withdrawal of round ${v.wd.round} still queued, ${atPool}` : `withdrawal of round ${v.wd.round}, paid from the round's account ${v.keys.wdTokens}` });
    }
    for (const x of parts) {
      if (!(x.raw > 0n)) continue;
      const amount = scale(x.raw, dec);
      items.push({
        category: x.category, chain: "solana", protocol: "Friktion", asset: t?.symbol || v.deposit_mint, token: x.part === "volt_tokens" ? v.vault_mint : v.deposit_mint, amount, usd: usdOf(t, amount),
        status: v.off ? "turned_off" : "ready", part: x.part, volt: v.volt, deposit_mint: v.deposit_mint, vault_mint: v.vault_mint,
        action: v.off ? "no exit path: the Friktion team turned deposits and withdrawals off on this volt" : `${x.action}; friktion.fi is gone, so build the transaction with the open-source Friktion SDK`,
        how_to_claim: FRIKTION_SDK,
        detail: `Friktion volt ${v.volt} (withdraw-only since Jan 2023, still processing withdrawals): ${x.note}; worth ${amount} ${t?.symbol || "deposit tokens"}`,
      });
    }
  }
  return items;
}

// ---- Francium lending -----------------------------------------------------------------------------------------
// lending pool (francium-sdk 1.4.16 LendingPoolLayout): liquidity mint @42, decimals @74, available u64 @175, borrowed
// wads u128 @183, share mint @223, share supply u64 @255; reward-pool user (FarmingUserLayout): staked u64 @1, farming
// pool @25, user @57. An fToken redeems for (available + borrowed) / shares, paid from what is available now
const FRANCIUM_SDK = "https://www.npmjs.com/package/francium-sdk";

async function francium(ctx, owner, wallet) {
  const pools = new Map(SOL_DEAD.francium.pools.map((p) => [p.share, p]));
  const farms = new Map(SOL_DEAD.francium.farms.map((f) => [f.farm, f.share]));
  const [rows, held] = await Promise.all([result(ctx, "sol.francium_lend_stakes", { owner }), wallet]);
  const positions = [];
  for (const r of rows || []) {
    const d = b64(r.account), share = farms.get(key(d, 25));
    if (key(d, 57) === owner && share && u64(d, 1) > 0n) positions.push({ part: "staked", share, raw: u64(d, 1), account: r.pubkey });
  }
  for (const [mint, raw] of held) if (pools.has(mint)) positions.push({ part: "wallet", share: mint, raw });
  if (!positions.length) return [];
  const used = [...new Set(positions.map((x) => pools.get(x.share).pool))];
  const acc = await accounts(ctx, used);
  const state = new Map(used.map((k) => { const d = b64(acc.get(k)); return [k, { mint: key(d, 42), dec: d[74], avail: u64(d, 175), borrowed: u128(d, 183) / 10n ** 18n, shares: u64(d, 255) }]; }));
  const jup = await pricesFor(ctx, [...state.values()].map((s) => s.mint));
  const items = [];
  for (const x of positions) {
    const pool = pools.get(x.share).pool, s = state.get(pool), t = jup.get(s.mint);
    const owed = mulDiv(x.raw, s.avail + s.borrowed, s.shares), now = owed < s.avail ? owed : s.avail;
    if (!(now > 0n)) continue;
    const amount = scale(now, s.dec), full = scale(owed, s.dec);
    items.push({
      category: x.part === "staked" ? "unstake_ready" : "token_migration", chain: "solana", protocol: "Francium", asset: t?.symbol || s.mint, token: x.part === "wallet" ? x.share : s.mint, amount, usd: usdOf(t, amount),
      status: owed <= s.avail ? "ready" : "partial", part: x.part, owed: full, pool, share_mint: x.share, ...(x.account && { stake_account: x.account }),
      action: `${x.part === "staked" ? "unstake the fTokens from the Francium reward pool, then " : ""}withdraw from the Francium lending pool (francium.io sits behind a bot wall: build it with francium-sdk)`,
      how_to_claim: FRANCIUM_SDK,
      detail: `Francium lending pool ${pool}: your fTokens are worth ${full} ${t?.symbol || "tokens"}${owed > s.avail ? `, but the pool holds only ${scale(s.avail, s.dec)} to pay out now (the rest was lent to Francium farms, wound down in Sept 2026); first come, first served` : ""}; the lending program runs a wind-down build that still pays withdrawals`,
    });
  }
  return items;
}

export async function solDeadApps(p, ctx) {
  if (!isSolAddr(p?.address)) throw { status: 400, error: "address must be a Solana address" };
  const owner = p.address, wallet = walletTokens(ctx, owner);
  wallet.catch(() => {}); // each part that awaits it reports the failure
  return each({ sunny: () => sunny(ctx, owner), friktion: () => friktion(ctx, owner, wallet), francium: () => francium(ctx, owner, wallet) });
}
