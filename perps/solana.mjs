// perps/solana.mjs - Solana perp venues (readers: async (address, io) -> item[], see perps/index.mjs).
// Drift recovery + Flash Trade + Adrena are shut-down venues (findings); Jupiter, Pacifica, Phoenix still trade.
import { base58 } from "@scure/base";
import { findPda, seed } from "../solana.mjs";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const day = (ts) => (ts ? new Date(Number(ts) * 1000).toISOString().slice(0, 10) : null);
const n6 = (v) => Number(v || 0) / 1e6;
const r2 = (x) => Math.round(x * 100) / 100;

// ---- Drift: April 2026 exploit recovery (dfx.drift.trade, read 2026-10-20). Insurance Fund stakers get their
// assets back from per-mint merkle trees (clawback 2027-07-01); traders get DFX, one token per $1 of loss
// (8 trees, clawback 2028-01-01, unclaimed DFX is burned)
const DFX = "dfxQsZjikuu5DGXPgX7yEpRog74HT5cJgytT3i5iLtw";

async function drift(address, io) {
  const r = await io.call("holdings.drift_eligibility", { address });
  if (r.status === 404) return []; // {error: "user not found"}: not in any tree
  if (!r.ok) throw { error: `drift eligibility ${r.status}` };
  const rows = (r.data || []).filter((x) => BigInt(x.claimable_amount || 0) > 0n);
  if (!rows.length) return [];
  const mints = [...new Set(rows.map((x) => x.mint))].sort();
  const [trees, tokens] = await Promise.all([io.get("holdings.drift_distributors", {}), io.get("token.jup_info", { query: mints.join(",") })]);
  const clawback = new Map((trees || []).map((t) => [t.merkle_tree, day(t.clawback_start_ts)]));
  const tok = new Map((tokens || []).map((t) => [t.id, t]));
  return rows.map((x) => {
    const t = tok.get(x.mint), dfx = x.mint === DFX;
    const amount = t?.decimals != null ? Number(x.claimable_amount) / 10 ** t.decimals : null;
    const usd = amount != null && t.usdPrice != null ? amount * t.usdPrice : null;
    const asset = t?.symbol || x.mint;
    return {
      protocol: "Drift", chain: "solana", asset, amount, usd, kind: "deposit", status: "closed", confidence: "high", liquidity: t?.liquidity ?? null,
      action: dfx ? "Claim DFX recovery tokens" : "Claim the Drift Insurance Fund refund",
      how_to_claim: "https://dfx.drift.trade/", deadline: clawback.get(x.merkle_tree) || null,
      detail: dfx
        ? `${amount} DFX from the Drift exploit recovery, par $1 each ($${r2(amount)} of verified loss); valued at the Jupiter market price, unclaimed DFX is burned at clawback`
        : `Drift Insurance Fund refund of ${amount} ${asset} (merkle tree ${x.merkle_tree})`,
    };
  });
}

// ---- Flash Trade: wound down (close-only 2026-08-31, force close 2026-09-02); FLP burn still open on-chain.
// FlpStake (flash-sdk 15.17.2 idl/perpetuals.json): owner 8, pool 40, stake_stats u64 pending_activation 72,
// active_amount 80, pending_deactivation 88, deactivated 96, unclaimed_rewards u64 120 (USDC, 6 dec).
// LP price = pool.equity_usd / supply of pool.lp_mint (PDA ["lp_token_mint", pool]), both 6 decimals.
const FLASH = "FLASH6Lo6h3iasJKWDs2F8TkW2UKf3s15C8PMGuVfgBn";

// Pool: disc 8, name string, Permissions 13 bools, inception_time i64, lp_mint + oracle_authority + staked_lp_vault
// + reward_custody pubkeys, custodies vec<pubkey>, ratios vec<{u64 x3}>, markets vec<pubkey>, max_aum_usd, buffer,
// raw_aum_usd, equity_usd
function flashPool(b) {
  let o = 8;
  const len = b.readUInt32LE(o), name = b.subarray(o + 4, o + 4 + len).toString(); o += 4 + len + 13 + 8 + 128;
  o += 4 + 32 * b.readUInt32LE(o);
  o += 4 + 24 * b.readUInt32LE(o);
  o += 4 + 32 * b.readUInt32LE(o);
  return { name, equity: n6(b.readBigUInt64LE(o + 24)) };
}

async function flashtrade(address, io) {
  const res = await io.get("sol.flash_stakes", { owner: address });
  const stakes = (res?.result || []).map((a) => {
    const b = Buffer.from(a.account.data[0], "base64"), u = (o) => b.readBigUInt64LE(o);
    return { pubkey: a.pubkey, pool: base58.encode(b.subarray(40, 72)), lp: n6(u(72) + u(80) + u(88)), rewards: n6(u(120)) };
  }).filter((s) => s.lp > 0 || s.rewards > 0);
  if (!stakes.length) return [];
  const pools = [...new Set(stakes.map((s) => s.pool))].sort();
  const mints = pools.map((p) => findPda([seed("lp_token_mint"), p], FLASH).address);
  const acc = (await io.get("sol.accounts", { pubkeys: [...pools, ...mints].join(",") }))?.result?.value || [];
  const price = new Map(pools.map((p, i) => {
    const pool = acc[i]?.data?.[0] ? flashPool(Buffer.from(acc[i].data[0], "base64")) : null;
    const supply = Number(acc[pools.length + i]?.data?.parsed?.info?.supply || 0) / 1e6;
    return [p, pool && supply > 0 ? { name: pool.name, lp: pool.equity / supply } : null];
  }));
  const base = { protocol: "Flash Trade", chain: "solana", kind: "deposit", status: "closed", deadline: null,
    action: "Unstake and burn FLP on flash.trade/earn before the site goes away", how_to_claim: "https://www.flash.trade/earn" };
  const out = [];
  for (const s of stakes) {
    const p = price.get(s.pool);
    if (s.lp > 0) out.push({
      ...base, asset: "FLP", amount: s.lp, usd: p ? s.lp * p.lp : null, confidence: p ? "medium" : "low",
      detail: p
        ? `${s.lp} staked FLP in pool ${p.name} at $${p.lp.toFixed(4)} (pool equity / LP supply); Flash wound down in Sep 2026`
        : `${s.lp} staked FLP in pool ${s.pool}, whose pool account is closed: likely not redeemable`,
    });
    if (s.rewards > 0) out.push({
      ...base, asset: "USDC", amount: s.rewards, usd: s.rewards, confidence: "high",
      detail: `unclaimed USDC staking rewards in Flash FLP stake ${s.pubkey}${p ? ` (pool ${p.name})` : ""}`,
    });
  }
  return out;
}

// ---- Adrena: shut down (Autonom support dropped 2026-08-27, app offline). Position (adrena-sdk-ts codama
// accounts/position.ts, 464 bytes): side u8 9 (1 long, 2 short), owner 16, custody 80, collateral_custody 112,
// update_time i64 152, size_usd u64 168, collateral_usd u64 184 (6 dec). Custody -> [market, token] read 2026-10-20
// (custody mint at 48): the SOL market's custody holds JitoSOL, BTC's holds WBTC
const ADRENA_CUSTODY = {
  GZ9XfWwgTRhkma2Y91Q9r1XKotNXYjBnKKabj19rhT71: ["SOL", "JitoSOL"],
  GFu3qS22mo6bAjg4Lr5R7L8pPgHq6GvbjJPKEHkbbs2c: ["BTC", "WBTC"],
  "8aJuzsgjxBnvRhDcfQBD7z4CUj7QoPEpaNwVd7KqsSk5": ["BONK", "BONK"],
  Dk523LZeDQbZtUwPEBjFXCd2Au1tD7mWZBJJmcgHktNk: ["USDC", "USDC"],
};

async function adrena(address, io) {
  const res = await io.get("sol.adrena_positions", { owner: address });
  return (res?.result || []).map((a) => {
    const b = Buffer.from(a.account.data[0], "base64"), u = (o) => n6(b.readBigUInt64LE(o));
    const [market = "unknown market"] = ADRENA_CUSTODY[base58.encode(b.subarray(80, 112))] || [];
    const [, coll = "collateral"] = ADRENA_CUSTODY[base58.encode(b.subarray(112, 144))] || [];
    const side = b[9] === 1 ? "long" : "short", usd = u(184);
    return {
      protocol: "Adrena", chain: "solana", asset: `${market}-PERP`, amount: usd, usd, kind: "position", status: "closed",
      confidence: "medium", deadline: null, how_to_claim: `https://solscan.io/account/${a.pubkey}`,
      action: "Close the Adrena position to recover its collateral (the app is offline: needs a direct program call)",
      detail: `Adrena ${side} ${market}, size $${r2(u(168))}, ${coll} collateral worth $${r2(usd)} at entry (excludes PnL and fees); Adrena shut down Aug 2026`,
    };
  }).filter((x) => x.usd > 0);
}

// ---- Jupiter Perps (live): perps-api.jup.ag v2, micro-USD strings. valueUsd = collateral + PnL after fees;
// a limit order not yet executed holds its collateral in a position request
const JUP_COLLATERAL = { // mint -> [symbol, decimals]: the five Jupiter Perps custodies
  So11111111111111111111111111111111111111112: ["SOL", 9],
  "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs": ["ETH", 8],
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": ["WBTC", 8],
  [USDC]: ["USDC", 6],
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: ["USDT", 6],
};

async function jupiter(address, io) {
  const [pos, orders] = await Promise.all([
    io.get("holdings.jupiter_perps_positions", { address }),
    io.get("holdings.jupiter_perps_orders", { address }),
  ]);
  const out = [];
  for (const p of pos?.dataList || []) {
    const usd = n6(p.valueUsd);
    if (usd > 0) out.push({
      protocol: "Jupiter Perps", chain: "solana", asset: `${p.asset}-PERP`, amount: usd, usd, kind: "position", status: "live",
      detail: `${p.side} ${p.asset} at ${p.leverage}x, size $${r2(n6(p.sizeUsd))}, collateral $${r2(n6(p.collateralUsd))}, PnL after fees $${r2(n6(p.pnlAfterFeesUsd))}; value = what closing returns`,
    });
  }
  for (const o of orders?.dataList || []) {
    const usd = n6(o.collateralUsd);
    if (o.executed || !(usd > 0)) continue;
    const [sym, dec] = JUP_COLLATERAL[o.collateralMint] || [];
    out.push({
      protocol: "Jupiter Perps", chain: "solana", asset: sym || "USD", amount: sym ? Number(o.collateralTokenAmount) / 10 ** dec : usd, usd, kind: "deposit", status: "live",
      detail: `collateral held by an unfilled ${o.side} limit order (trigger $${r2(n6(o.triggerPrice))}); cancel it on jup.ag/perps to get it back`,
    });
  }
  return out;
}

// ---- Pacifica (live): one account per wallet, decimal USD strings; 404 "Account not found" = no account
async function pacifica(address, io) {
  const r = await io.call("holdings.pacifica", { address });
  if (r.status === 404) return [];
  if (!r.ok) throw { error: `pacifica ${r.status}` };
  const a = r.data?.data;
  const usd = Number(a?.account_equity || 0);
  if (!(usd > 0)) return [];
  const open = Number(a.positions_count || 0);
  return [{
    protocol: "Pacifica", chain: "solana", asset: "USDC", amount: usd, usd, kind: open > 0 ? "position" : "deposit", status: "live",
    detail: `Pacifica account equity (incl. unrealized PnL), ${Number(a.available_to_withdraw || 0)} USDC withdrawable now, ${open} open position(s), ${Number(a.orders_count || 0)} open order(s)`,
  }];
}

// ---- Phoenix perps (Rise, live): trader state by authority (PDA index 0) lists subaccounts with collateral in
// quote lots (6 dec); the per-trader view adds PnL. Trader PDA = ["trader", authority, u8 pda index, u8 subaccount]
// (Ellipsis-Labs/rise-public, read 2026-10-20)
const PHOENIX = "EtrnLzgbS7nMMy5fbD42kXiUzGg8XQzJ972Xtk1cjWih";
const byte = (i) => seed(String.fromCharCode(i)); // one-byte seed (indexes stay under 128, one UTF-8 byte)

async function phoenix(address, io) {
  const r = await io.call("holdings.phoenix_state", { address });
  if (r.status === 404) return []; // "Trader not found"
  if (!r.ok) throw { error: `phoenix trader state ${r.status}` };
  const subs = (r.data?.snapshot?.subaccounts || []).filter((s) => Number(s.collateral || 0) > 0 || s.positions?.length);
  return (await Promise.all(subs.map(async (s) => {
    const pda = findPda([seed("trader"), address, byte(0), byte(s.subaccountIndex)], PHOENIX).address;
    const v = await io.call("holdings.phoenix_trader", { trader: pda });
    const view = v.ok ? v.data : null;
    const usd = view ? Number(view.effectiveCollateral?.ui || 0) : n6(s.collateral);
    if (!(usd > 0)) return null;
    const open = (view?.positions || s.positions || []).length;
    return {
      protocol: "Phoenix", chain: "solana", asset: "USDC", amount: usd, usd, kind: open > 0 ? "position" : "deposit", status: "live",
      detail: view
        ? `Phoenix subaccount ${s.subaccountIndex}: collateral ${view.collateralBalance?.ui} USDC + unrealized PnL ${view.unrealizedPnl?.ui}, ${view.withdrawableQuoteCollateral?.ui} USDC withdrawable now, ${open} open position(s)`
        : `Phoenix subaccount ${s.subaccountIndex}: ${usd} USDC collateral (excludes PnL), ${open} open position(s)`,
    };
  }))).filter(Boolean);
}

export const SOL = { drift, flashtrade, adrena, jupiter, pacifica, phoenix };
