// forgotten/soldefi.mjs - live Solana DeFi positions and the money they hold unclaimed (sol.defi, read 2026-10-22):
// Kamino (lending, multiply, leverage, liquidity vaults, earn vaults, KMNO staking + pending farm rewards, from
// Kamino's own portfolio API), MarginFi / Project 0 accounts (deposits, loans, emissions never claimed, banks wound
// down to reduce-only or paused; program accounts by authority), Save (ex Solend) obligations (deposits and loans,
// valued from the reserves), Orca Whirlpools and Raydium CLMM positions (position NFTs in the wallet: principal from
// the pool price, uncollected fees and rewards from the tick arrays, Uniswap v3 math) and
// Meteora DLMM + DAMM v2 positions (Meteora's own portfolio APIs). Facts only: each item is a holding (`kind`: a live
// position, counted in holdings) or a finding (`category`: money to collect); forgotten/soldefi-findings.mjs decides.
import { createHash } from "node:crypto";
import { isSolAddr, findPda, seed, TOKEN_2022 } from "../solana.mjs";
import { each, prices, trusted } from "./evm.mjs";
import { b64, u64, key, scale, round, result, accounts, jupiter, decimalsOf } from "./solana.mjs";

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const NONE = "11111111111111111111111111111111";
const u128 = (d, o) => (d.length >= o + 16 ? d.readBigUInt64LE(o) + (d.readBigUInt64LE(o + 8) << 64n) : 0n);
const i128 = (d, o) => { const v = u128(d, o); return v >= 1n << 127n ? v - (1n << 128n) : v; };
const i32 = (d, o) => (d.length >= o + 4 ? d.readInt32LE(o) : 0);
const disc = (name) => createHash("sha256").update(`account:${name}`).digest().subarray(0, 8).toString("hex");
const MOD = 1n << 128n;
const wrap = (v) => ((v % MOD) + MOD) % MOD;
// Jupiter row -> price fields every item carries: price only for a token Jupiter verifies, liquidity for the thin-market rule
const px = (t) => ({ price: t?.verified ? t.price ?? null : null, verified: !!t?.verified, liquidity: t?.liquidity ?? null });
const usdOf = (t, amount) => (t?.verified && t.price != null ? round(amount * t.price, 2) : null);

async function get(ctx, id, params) {
  const r = await ctx.call(id, params);
  if (!r.ok) throw { error: `step ${id} failed (upstream ${r.status})` };
  return r.data;
}

// ---- Kamino ---------------------------------------------------------------------------------------------------
// GET api.kamino.finance/portfolio/{wallet}: every Kamino position with Kamino's own prices (sections[].errors when
// an indexer part failed); /portfolio/{wallet}/rewards: pending farm rewards (lend, borrow, liquidity, earn farms)
const KAMINO_UI = "https://kamino.com/portfolio";
async function kamino(ctx, owner, price) {
  const [pf, rw] = await Promise.all([get(ctx, "sol.kamino_portfolio", { address: owner }), get(ctx, "sol.kamino_rewards", { address: owner })]);
  const items = [], broken = Object.entries(pf?.sections || {}).filter(([, s]) => (s.errors || []).length).map(([k]) => k);
  if (broken.length) throw { error: `kamino portfolio sections failed: ${broken.join(", ")}` };
  const obligation = (o, label) => {
    for (const x of o.deposits || []) items.push({ kind: "deposit", protocol: "Kamino Lend", asset: x.symbol, mint: x.mint, amount: num(x.amount), usd: round(num(x.value) ?? 0, 2), verified: true, obligation: o.obligation, market: o.market, detail: `${label} deposit in Kamino market ${o.market} (obligation ${o.obligation})` });
    for (const x of o.borrows || []) items.push({ kind: "loan", protocol: "Kamino Lend", asset: x.symbol, mint: x.mint, amount: num(x.amount), usd: -round(num(x.value) ?? 0, 2), verified: true, obligation: o.obligation, market: o.market, detail: `${label} loan in Kamino market ${o.market} (obligation ${o.obligation})` });
  };
  for (const o of pf?.lending || []) obligation(o, "lending");
  for (const o of pf?.multiply || []) obligation(o, "Multiply");
  for (const o of pf?.leverage || []) obligation(o, "Leverage");
  for (const l of pf?.liquidity || []) {
    const legs = [l.tokenA, l.tokenB].filter(Boolean).map((t) => ({ token: t.mint, asset: t.symbol, amount: round(num(t.amount) ?? 0), usd: round(num(t.value) ?? 0, 2) }));
    items.push({ kind: "position", protocol: "Kamino Liquidity", asset: `${legs.map((x) => x.asset).join("-")} kVault`, mint: l.shareMint, receipt: true, amount: num(l.shares), usd: round(num(l.netValue) ?? 0, 2), verified: true, legs, strategy: l.strategy, detail: `Kamino liquidity vault ${l.strategy}: ${legs.map((x) => `${x.amount} ${x.asset}`).join(" + ")}` });
  }
  // earn vault shares can sit in the wallet: the vault's share mint lets scan.sol drop that token's own holding row
  const earn = [...(pf?.earn || []), ...(pf?.privateCredit || [])];
  const shareMint = new Map(await Promise.all(earn.map(async (e) => [e.vault, (await ctx.call("sol.kamino_vault", { vault: e.vault }).catch(() => null))?.data?.state?.sharesMint || null])));
  for (const e of earn) items.push({ kind: "deposit", protocol: "Kamino Earn", asset: e.symbol, token: e.tokenMint, ...(shareMint.get(e.vault) && { mint: shareMint.get(e.vault), receipt: true }), amount: num(e.amount), usd: round(num(e.netValue) ?? 0, 2), verified: true, vault: e.vault, detail: `Kamino earn vault ${e.name || e.vault} (${num(e.shares)} shares)` });
  for (const s of pf?.staking || []) items.push({ kind: "staked", protocol: "Kamino", asset: s.symbol, mint: s.mint, amount: num(s.amount), usd: round(num(s.value) ?? 0, 2), verified: true, farm: s.farm, detail: `${s.symbol} staked in Kamino farm ${s.farm}` });
  // pending farm rewards: one row per reward token, summed over the farms that pay it
  const due = new Map();
  for (const f of rw?.farms || []) for (const r of f.rewards || []) {
    const a = num(r.amount);
    if (!(a > 0)) continue;
    const d = due.get(r.mint) || { amount: 0, farms: [] };
    d.amount += a; d.farms.push(`${f.positionType || "farm"} ${f.farm}`);
    due.set(r.mint, d);
  }
  if (due.size) {
    const jup = await price([...due.keys()]);
    for (const [mint, d] of due) {
      const t = jup.get(mint);
      items.push({
        category: "reward", protocol: "Kamino", asset: t?.symbol || mint, token: mint, amount: round(d.amount, 9), usd: usdOf(t, d.amount), ...px(t), status: "ready",
        action: "claim the pending Kamino farm rewards (Portfolio, Claim)", how_to_claim: KAMINO_UI,
        detail: `pending rewards of ${d.farms.length} Kamino farm${d.farms.length > 1 ? "s" : ""}: ${d.farms.slice(0, 4).join(", ")}${d.farms.length > 4 ? ", ..." : ""}`,
      });
    }
  }
  return items;
}

// ---- MarginFi (Project 0) -------------------------------------------------------------------------------------
// marginfi v2 IDL (onchain): MarginfiAccount {group @8, authority @40, balances [16 x 104] @72: active u8 +0, bank +1,
// asset_shares I80F48 +40, liability_shares +56, emissions_outstanding +72}; Bank {mint @8, mint_decimals @40,
// asset_share_value @80, liability_share_value @96, config.operational_state @608 (0 paused, 1 operational, 2 reduce
// only, 3 killed by bankruptcy), emissions_mint @872}. I80F48 = i128 / 2^48
const MFI_UI = "https://app.0.xyz/";
const fix = (d, o) => Number(i128(d, o)) / 2 ** 48;
const STATE = ["paused", "operational", "reduce_only", "killed"];
async function marginfi(ctx, owner, price) {
  const rows = (await result(ctx, "sol.marginfi_accounts", { owner })) || [];
  const bals = [];
  for (const r of rows) {
    const d = b64(r.account);
    if (d.length < 1736 || key(d, 40) !== owner) continue;
    for (let i = 0; i < 16; i++) {
      const o = 72 + i * 104;
      if (!d[o]) continue;
      const b = { account: r.pubkey, group: key(d, 8), bank: key(d, o + 1), asset: fix(d, o + 40), liability: fix(d, o + 56), emissions: fix(d, o + 72) };
      if (b.asset > 0 || b.liability > 0 || b.emissions > 0) bals.push(b);
    }
  }
  if (!bals.length) return [];
  const bk = await accounts(ctx, bals.map((b) => b.bank));
  const banks = new Map();
  for (const [k, a] of bk) {
    const d = b64(a);
    if (d.length >= 904) banks.set(k, { mint: key(d, 8), dec: d[40], assetValue: fix(d, 80), liabilityValue: fix(d, 96), state: STATE[d[608]] || "unknown", emissionsMint: key(d, 872) });
  }
  const emitMints = [...new Set(bals.filter((b) => b.emissions > 0).map((b) => banks.get(b.bank)?.emissionsMint).filter((m) => m && m !== NONE))];
  const [mints, jup] = await Promise.all([emitMints.length ? accounts(ctx, emitMints) : new Map(), price([...banks.values()].map((b) => b.mint).concat(emitMints))]);
  const debtOf = new Map(); // account -> has a loan (a deposit there may back it)
  for (const b of bals) if (b.liability > 0) debtOf.set(b.account, true);
  const items = [];
  for (const b of bals) {
    const k = banks.get(b.bank);
    if (!k) continue;
    const t = jup.get(k.mint), sym = t?.symbol || k.mint;
    const base = { protocol: "MarginFi", mint: k.mint, account: b.account, bank: b.bank, group: b.group, bank_state: k.state };
    if (b.asset > 0 && k.state !== "killed") {
      const amount = scale(BigInt(Math.floor(b.asset * k.assetValue)), k.dec), usd = usdOf(t, amount);
      if (k.state === "operational") items.push({ ...base, kind: "deposit", asset: sym, amount, usd, verified: !!t?.verified, liquidity: t?.liquidity ?? null, detail: `MarginFi (Project 0) deposit, account ${b.account}` });
      else { // a paused bank moves nothing: not claimable now, so medium
        const owes = debtOf.has(b.account);
        items.push({
          ...base, category: "unstake_ready", asset: sym, token: k.mint, amount, usd, ...px(t), status: k.state === "paused" ? "paused" : "ready", confidence: owes || k.state === "paused" ? "medium" : "high",
          action: k.state === "paused" ? "withdraw once the bank is unpaused: until the Project 0 team acts, nothing moves" : `${owes ? "repay the loans on this account, then " : ""}withdraw the ${sym} deposit: the bank is reduce-only (wound down)`,
          how_to_claim: MFI_UI, detail: `MarginFi bank ${b.bank} ${k.state === "paused" ? "is paused: deposits, withdrawals and loans all wait until Project 0 unpauses it" : `is reduce-only: it takes no new deposits, the ${amount} ${sym} here can be withdrawn`}${owes ? "; the account has a loan this deposit may back" : ""}`,
        });
      }
    }
    if (b.liability > 0) {
      const amount = scale(BigInt(Math.floor(b.liability * k.liabilityValue)), k.dec), usd = usdOf(t, amount);
      items.push({ ...base, kind: "loan", asset: sym, amount, usd: usd == null ? null : -usd, verified: true, detail: `MarginFi (Project 0) loan, account ${b.account}` });
    }
    if (b.emissions > 0 && k.emissionsMint !== NONE) {
      const dec = decimalsOf(mints.get(k.emissionsMint)), e = jup.get(k.emissionsMint);
      if (dec == null) continue;
      const amount = scale(BigInt(Math.floor(b.emissions)), dec);
      items.push({
        ...base, category: "reward", asset: e?.symbol || k.emissionsMint, token: k.emissionsMint, amount, usd: usdOf(e, amount), ...px(e), status: "ready", confidence: "medium",
        action: `claim the MarginFi emissions earned on the ${sym} ${b.asset > 0 ? "deposit" : "loan"} (Project 0 app, withdraw emissions)`, how_to_claim: MFI_UI,
        detail: `emissions owed as of the account's last update in bank ${b.bank}; more may have accrued since`,
      });
    }
  }
  return items;
}

// ---- Save (ex Solend) -----------------------------------------------------------------------------------------
// solend-sdk layouts (non-Anchor): Obligation (1300 bytes) {lending_market @10, owner @42, deposits_len u8 @202,
// borrows_len u8 @203, from @204: deposits of 88 bytes {reserve, deposited_amount u64 +32 (cTokens)} then borrows of
// 112 bytes {reserve, cumulative_borrow_rate_wads u128 +32, borrowed_amount_wads u128 +48}}; Reserve (619 bytes)
// {liquidity mint @42, decimals @74, available u64 @171, borrowed_wads u128 @179, cumulative_borrow_rate_wads @195,
// collateral mint supply u64 @259, accumulated_protocol_fees_wads u128 @373}. A cToken is worth (available + borrowed -
// protocol fees) / supply; a loan grows by the reserve's borrow rate over the obligation's. Checked 2026-10-22 against an
// obligation refreshed that slot: every deposit matched its stored market value to the cent
const WAD = 10n ** 18n;
async function save(ctx, owner, price) {
  const rows = (await result(ctx, "sol.save_obligations", { owner })) || [];
  const obs = [];
  for (const r of rows) {
    const d = b64(r.account);
    if (d.length < 1300 || key(d, 42) !== owner) continue;
    const nd = d[202], nb = d[203], deps = [], bors = [];
    for (let i = 0; i < nd && i < 10; i++) { const o = 204 + i * 88; if (u64(d, o + 32) > 0n) deps.push({ reserve: key(d, o), raw: u64(d, o + 32) }); }
    for (let i = 0; i < nb && i < 10; i++) { const o = 204 + nd * 88 + i * 112; if (u128(d, o + 48) > 0n) bors.push({ reserve: key(d, o), cum: u128(d, o + 32), wads: u128(d, o + 48) }); }
    if (deps.length || bors.length) obs.push({ obligation: r.pubkey, market: key(d, 10), deps, bors });
  }
  if (!obs.length) return [];
  const ra = await accounts(ctx, obs.flatMap((o) => [...o.deps, ...o.bors].map((x) => x.reserve)));
  const res = new Map();
  for (const [k, a] of ra) {
    const d = b64(a);
    if (d.length >= 389) res.set(k, { mint: key(d, 42), dec: d[74], avail: u64(d, 171), borrowed: u128(d, 179), cum: u128(d, 195), supply: u64(d, 259), fees: u128(d, 373) });
  }
  const jup = await price([...res.values()].map((r) => r.mint));
  const items = [];
  for (const o of obs) {
    const where = `Save (ex Solend) market ${o.market}, obligation ${o.obligation}`;
    for (const x of o.deps) {
      const r = res.get(x.reserve);
      if (!r || !(r.supply > 0n)) continue;
      const liq = r.avail * WAD + r.borrowed - r.fees; // in wads
      const amount = scale((x.raw * liq) / (r.supply * WAD), r.dec), t = jup.get(r.mint), usd = usdOf(t, amount);
      const short = (x.raw * liq) / (r.supply * WAD) > r.avail;
      items.push({ kind: "deposit", protocol: "Save", asset: t?.symbol || r.mint, mint: r.mint, amount, usd, verified: !!t?.verified, obligation: o.obligation, market: o.market, detail: `${where}${short ? `; the reserve holds only ${scale(r.avail, r.dec)} to pay out now` : ""}${o.bors.length ? "; backs a loan" : ""}` });
    }
    for (const x of o.bors) {
      const r = res.get(x.reserve);
      if (!r || !(x.cum > 0n)) continue;
      const amount = scale((x.wads * r.cum) / x.cum / WAD, r.dec), t = jup.get(r.mint), usd = usdOf(t, amount);
      items.push({ kind: "loan", protocol: "Save", asset: t?.symbol || r.mint, mint: r.mint, amount, usd: usd == null ? null : -usd, verified: true, obligation: o.obligation, market: o.market, detail: `${where}: loan` });
    }
  }
  return items;
}

// ---- Orca Whirlpools + Raydium CLMM ---------------------------------------------------------------------------
// Both are Uniswap v3 style: a position NFT in the wallet, a position PDA ["position", nft mint], the pool, and the two
// tick arrays holding its range ends. Orca (whirlpool IDL onchain): Position {whirlpool @8, liquidity u128 @72, tick
// lower @88, upper @92, fee checkpoint a @96, owed a @112, checkpoint b @120, owed b @136, rewards [3 x {checkpoint
// u128, owed u64}] @144}; Whirlpool {tick_spacing u16 @41, sqrt_price @65, tick_current i32 @81, mint a @101,
// fee_growth_global_a @165, mint b @181, global b @245, rewards [3 x 128] @269: mint +0, growth_global +112};
// TickArray (fixed, 88 ticks of 113 bytes from @12: initialized +0, fee outside a +33, b +49, rewards +65) or DynamicTickArray
// (ticks from @60, each a 1-byte tag + 112 bytes when initialized); PDA ["tick_array", pool, start as text].
// Raydium (raydium-io/raydium-idl raydium_clmm.json): PersonalPositionState {pool @41, lower @73, upper @77,
// liquidity @81, fee inside 0 @97, 1 @113, owed 0 @129, 1 @137, rewards [3 x {growth u128, owed u64}] @145};
// PoolState {mint 0 @73, mint 1 @105, decimals @233 @234, tick_spacing @235, sqrt_price @253, tick_current @269,
// fee global 0 @277, 1 @293, rewards [3 x 169] @397: state +0, mint +57, growth_global +153}; TickArrayState 60
// ticks of 168 bytes from @44 (fee outside 0 +20, 1 +36, rewards +52); PDA ["tick_array", pool, start i32 BE]
const ORCA = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", RAYDIUM = "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK";
const ORCA_FIXED = disc("TickArray"), ORCA_DYN = disc("DynamicTickArray");
const POSITION_BUDGET_MS = 20000; // stop with explicit coverage, keeping every completed chunk
const i32be = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return new Uint8Array(b); };
const DEX = {
  orca: {
    program: ORCA, name: "Orca", per: 88, ui: "https://www.orca.so/portfolio",
    pos: (d) => d.length >= 216 && { pool: key(d, 8), liq: u128(d, 72), lower: i32(d, 88), upper: i32(d, 92), cp: [u128(d, 96), u128(d, 120)], owed: [u64(d, 112), u64(d, 136)], rw: [0, 1, 2].map((i) => ({ cp: u128(d, 144 + i * 24), owed: u64(d, 160 + i * 24) })) },
    pool: (d) => d.length >= 653 && { spacing: d.readUInt16LE(41), sqrt: u128(d, 65), tick: i32(d, 81), mints: [key(d, 101), key(d, 181)], global: [u128(d, 165), u128(d, 245)], rewards: [0, 1, 2].map((i) => ({ mint: key(d, 269 + i * 128), growth: u128(d, 381 + i * 128) })).map((r) => (r.mint === NONE ? { mint: null, growth: 0n } : r)) },
    tickArray: (pool, start) => findPda([seed("tick_array"), pool, seed(String(start))], ORCA).address,
    tick(d, start, spacing, t) {
      const i = (t - start) / spacing, hex = d.subarray(0, 8).toString("hex");
      if (hex === ORCA_FIXED) { const o = 12 + i * 113; return d[o] ? { fee: [u128(d, o + 33), u128(d, o + 49)], rw: [0, 1, 2].map((r) => u128(d, o + 65 + r * 16)) } : ZERO_TICK; }
      if (hex === ORCA_DYN) {
        let o = 60;
        for (let k = 0; k < i; k++) o += d[o] ? 113 : 1;
        return d[o] ? { fee: [u128(d, o + 1 + 32), u128(d, o + 1 + 48)], rw: [0, 1, 2].map((r) => u128(d, o + 1 + 64 + r * 16)) } : ZERO_TICK;
      }
      return null;
    },
  },
  raydium: {
    program: RAYDIUM, name: "Raydium CLMM", per: 60, ui: "https://raydium.io/portfolio/",
    pos: (d) => d.length >= 225 && { pool: key(d, 41), liq: u128(d, 81), lower: i32(d, 73), upper: i32(d, 77), cp: [u128(d, 97), u128(d, 113)], owed: [u64(d, 129), u64(d, 137)], rw: [0, 1, 2].map((i) => ({ cp: u128(d, 145 + i * 24), owed: u64(d, 161 + i * 24) })) },
    pool: (d) => d.length >= 904 && { spacing: d.readUInt16LE(235), sqrt: u128(d, 253), tick: i32(d, 269), mints: [key(d, 73), key(d, 105)], decimals: [d[233], d[234]], global: [u128(d, 277), u128(d, 293)], rewards: [0, 1, 2].map((i) => ({ state: d[397 + i * 169], mint: key(d, 397 + i * 169 + 57), growth: u128(d, 397 + i * 169 + 153) })).map((r) => (r.state && r.mint !== NONE ? r : { mint: null, growth: 0n })) },
    tickArray: (pool, start) => findPda([seed("tick_array"), pool, i32be(start)], RAYDIUM).address,
    tick(d, start, spacing, t) {
      if (d.length < 10124) return null;
      const o = 44 + ((t - start) / spacing) * 168;
      return { fee: [u128(d, o + 36), u128(d, o + 52)], rw: [0, 1, 2].map((r) => u128(d, o + 68 + r * 16)) };
    },
  },
};
const ZERO_TICK = { fee: [0n, 0n], rw: [0n, 0n, 0n] };
const startOf = (t, spacing, per) => Math.floor(t / (spacing * per)) * spacing * per;
// fee (or reward) growth inside a range, mod 2^128, from the global growth and the two ticks' growth outside
const inside = (global, lo, hi, cur, lower, upper) => wrap(global - (cur >= lower ? lo : wrap(global - lo)) - (cur < upper ? hi : wrap(global - hi)));
const earned = (liq, now, cp) => (liq * wrap(now - cp)) >> 64n;
// token amounts of a liquidity range at the pool price (raw units, float: a value, not a payout)
function amounts(liq, sqrtX64, lower, upper) {
  const L = Number(liq), sp = Number(sqrtX64) / 2 ** 64, sa = Math.pow(1.0001, lower / 2), sb = Math.pow(1.0001, upper / 2);
  if (sp <= sa) return [L * (sb - sa) / (sa * sb), 0];
  if (sp >= sb) return [0, L * (sb - sa)];
  return [L * (sb - sp) / (sp * sb), L * (sp - sa)];
}

async function nftMints(ctx, owner) {
  const [a, b] = await Promise.all([result(ctx, "sol.token_accounts", { owner }), result(ctx, "sol.token_accounts", { owner, program_id: TOKEN_2022 })]);
  const out = [];
  for (const x of [...(a?.value || []), ...(b?.value || [])]) {
    const t = x.account?.data?.parsed?.info?.tokenAmount;
    if (t && t.decimals === 0 && t.amount === "1") out.push(x.account.data.parsed.info.mint);
  }
  return [...new Set(out)];
}

// https://github.com/orca-so/whirlpools/blob/main/programs/whirlpool/src/state/position_bundle.rs
// A bundle NFT owns up to 256 positions. Each set bitmap bit uses the decimal index in the bundled_position PDA.
export async function discoverClmmPositions(ctx, owner, { budgetMs = POSITION_BUDGET_MS } = {}) {
  const all = await nftMints(ctx, owner), until = Date.now() + budgetMs, pos = [], seen = new Set();
  let checked = 0, bundles = 0;
  const errors = [];
  const take = (c, account) => {
    if (!account || account.owner !== DEX[c.dex].program || seen.has(c.pda)) return;
    const d = b64(account), p = DEX[c.dex].pos(d);
    if (!p || (c.dex === "orca" && key(d, 40) !== c.nft)) return;
    seen.add(c.pda);
    if (p.liq > 0n || p.owed.some((x) => x > 0n) || p.rw.some((r) => r.owed > 0n)) pos.push({ ...c, ...p });
  };
  for (let start = 0; start < all.length; start += 100) {
    const nfts = all.slice(start, start + 100);
    const cand = nfts.flatMap((m) => Object.entries(DEX).map(([k, x]) => ({ dex: k, nft: m, pda: findPda([seed("position"), m], x.program).address })));
    try {
      const pa = await accounts(ctx, cand.map((c) => c.pda));
      for (const c of cand) take(c, pa.get(c.pda));
      const bundlePdas = nfts.map((m) => findPda([seed("position_bundle"), m], ORCA).address);
      const ba = await accounts(ctx, bundlePdas), bundled = [];
      for (let i = 0; i < nfts.length; i++) {
        const a = ba.get(bundlePdas[i]);
        if (!a || a.owner !== ORCA) continue;
        const d = b64(a);
        if (d.length < 72 || d.subarray(0, 8).toString("hex") !== disc("PositionBundle") || key(d, 8) !== nfts[i]) continue;
        bundles++;
        for (let bit = 0; bit < 256; bit++) if (d[40 + Math.floor(bit / 8)] & (1 << (bit % 8))) {
          bundled.push({ dex: "orca", nft: nfts[i], bundle_index: bit, pda: findPda([seed("bundled_position"), nfts[i], seed(String(bit))], ORCA).address });
        }
      }
      const bp = await accounts(ctx, bundled.map((c) => c.pda));
      for (const c of bundled) take(c, bp.get(c.pda));
      checked += nfts.length;
    } catch (e) { errors.push(String(e.error || e.message || e).slice(0, 100)); break; }
    if (Date.now() >= until) break;
  }
  return { pos, coverage: { status: checked === all.length ? "complete" : "truncated", checked, total: all.length, bundles,
    ...(checked < all.length && { reason: errors.length ? errors.join("; ") : "position discovery time budget reached" }) } };
}

async function clmm(ctx, owner, price) {
  const { pos, coverage } = await discoverClmmPositions(ctx, owner);
  const coverageRow = { coverage, ...(coverage.status === "truncated" && { hint: `${coverage.checked}/${coverage.total} position NFT candidates checked: ${coverage.reason}` }) };
  if (!pos.length) return [coverageRow];
  const pk = await accounts(ctx, pos.map((p) => p.pool));
  for (const p of pos) {
    p.state = DEX[p.dex].pool(b64(pk.get(p.pool)));
    if (p.state && p.liq > 0n) {
      const s = p.state.spacing, per = DEX[p.dex].per;
      p.arrays = [p.lower, p.upper].map((t) => ({ t, start: startOf(t, s, per) })).map((x) => ({ ...x, addr: DEX[p.dex].tickArray(p.pool, x.start) }));
    }
  }
  const live = pos.filter((p) => p.state);
  const mintList = [...new Set(live.flatMap((p) => [...p.state.mints, ...p.state.rewards.map((r) => r.mint)]))].filter(Boolean);
  const [ta, mk, jup] = await Promise.all([accounts(ctx, live.flatMap((p) => (p.arrays || []).map((a) => a.addr))), accounts(ctx, mintList), price(mintList)]);
  const items = [];
  for (const p of live) {
    const x = DEX[p.dex], st = p.state;
    const dec = st.decimals || st.mints.map((m) => decimalsOf(mk.get(m)));
    if (dec.some((v) => v == null)) continue;
    let fees = [...p.owed], rewards = p.rw.map((r) => r.owed), exact = true;
    if (p.liq > 0n) {
      const [lo, hi] = p.arrays.map((a) => { const acc = ta.get(a.addr); return acc ? x.tick(b64(acc), a.start, st.spacing, a.t) : null; });
      if (lo && hi) {
        fees = [0, 1].map((j) => p.owed[j] + earned(p.liq, inside(st.global[j], lo.fee[j], hi.fee[j], st.tick, p.lower, p.upper), p.cp[j]));
        // reward slots stay in place (an unused slot has no mint): slot j of the pool pays slot j of the position
        rewards = st.rewards.map((r, j) => (r.mint ? p.rw[j].owed + earned(p.liq, inside(r.growth, lo.rw[j], hi.rw[j], st.tick, p.lower, p.upper), p.rw[j].cp) : 0n));
      } else exact = false; // tick arrays unreadable: only what the position already owes
    }
    const toks = st.mints.map((m) => jup.get(m)), sym = toks.map((t, j) => t?.symbol || st.mints[j].slice(0, 6));
    const pair = `${sym[0]}-${sym[1]}`, link = `${x.ui}`, where = `${x.name} ${pair} position ${p.pda} (NFT ${p.nft})`;
    if (p.liq > 0n) {
      const amt = amounts(p.liq, st.sqrt, p.lower, p.upper).map((v, j) => v / 10 ** dec[j]);
      const legs = amt.map((v, j) => ({ token: st.mints[j], asset: sym[j], amount: round(v), usd: usdOf(toks[j], v) }));
      const priced = legs.every((l) => l.usd != null) && toks.every((t) => t?.verified);
      const thin = legs.some((l, j) => l.usd != null && toks[j]?.liquidity != null && toks[j].liquidity < l.usd * 2);
      items.push({
        kind: "position", protocol: x.name, asset: `${pair} LP ${p.pda.slice(0, 4)}`, mint: p.nft, amount: 1, usd: round(legs.reduce((t, l) => t + (l.usd ?? 0), 0), 2), verified: priced && !thin, legs,
        in_range: st.tick >= p.lower && st.tick < p.upper, position: p.pda, pool: p.pool,
        detail: `${where}: ${legs.map((l) => `${l.amount} ${l.asset}`).join(" + ")}${st.tick >= p.lower && st.tick < p.upper ? "" : " (out of range)"}${priced ? "" : "; a leg has no trusted price"}${thin ? "; thin market: not counted in holdings_usd" : ""}`,
      });
    }
    const out = [...fees.map((v, j) => ({ part: "fees", mint: st.mints[j], raw: v, dec: dec[j], t: toks[j] })), ...rewards.map((v, j) => ({ part: "rewards", mint: st.rewards[j]?.mint, raw: v }))];
    for (const o of out) {
      if (!o.mint || !(o.raw > 0n)) continue;
      const t = o.t || jup.get(o.mint), d = o.dec ?? decimalsOf(mk.get(o.mint));
      if (d == null) continue;
      const amount = scale(o.raw, d);
      items.push({
        category: "reward", protocol: x.name, asset: t?.symbol || o.mint, token: o.mint, amount, usd: usdOf(t, amount), ...px(t), status: "ready", confidence: exact ? "high" : "medium",
        action: `collect the ${o.part === "fees" ? "fees" : "rewards"} of the ${x.name} ${pair} position${p.liq > 0n ? "" : " (empty: collect, then close it for the rent)"}`, how_to_claim: link,
        position: p.pda, pool: p.pool,
        detail: `${where}: uncollected ${o.part === "fees" ? "swap fees" : "liquidity rewards"}${exact ? ", fee growth since the last collect x liquidity" : ", only what the position already owes (tick arrays unreadable)"}${o.part === "rewards" ? "; reward growth as of the pool's last update" : ""}`,
      });
    }
  }
  items.push(coverageRow);
  return items;
}

// ---- Meteora --------------------------------------------------------------------------------------------------
// DLMM: dlmm.datapi.meteora.ag/portfolio/open (per pool: balances and unclaimed fees in USD, Meteora's prices);
// DAMM v2: damm-v2.datapi.meteora.ag/wallets/{wallet}/open_positions (per position: deposits, unclaimed fees and
// rewards per token). Meteora prices memecoins too: a pool whose tokens Jupiter does not verify stays unverified
const METEORA_UI = "https://www.meteora.ag/portfolio";
async function meteora(ctx, owner, price) {
  const [dl, dm] = await Promise.all([get(ctx, "sol.meteora_dlmm", { address: owner }), get(ctx, "sol.meteora_damm_v2", { address: owner })]);
  const pools = dl?.pools || [], posns = dm?.data || [];
  if (!pools.length && !posns.length) return [];
  const jup = await price([...pools.flatMap((p) => [p.tokenXMint, p.tokenYMint]), ...posns.flatMap((p) => [p.token_x?.address, p.token_y?.address, p.reward_token_x?.address, p.reward_token_y?.address])]);
  const trustedPair = (a, b) => [a, b].every((m) => jup.get(m)?.verified);
  const thinPair = (a, b, usd) => [a, b].some((m) => { const l = jup.get(m)?.liquidity; return l != null && l < usd * 2; });
  const items = [];
  for (const p of pools) {
    const pair = `${p.tokenX || jup.get(p.tokenXMint)?.symbol || p.tokenXMint.slice(0, 6)}-${p.tokenY || jup.get(p.tokenYMint)?.symbol || p.tokenYMint.slice(0, 6)}`;
    const ok = trustedPair(p.tokenXMint, p.tokenYMint), bal = num(p.balances) ?? 0, fee = num(p.unclaimedFees) ?? 0;
    const where = `Meteora DLMM ${pair} pool ${p.poolAddress}, ${p.openPositionCount} position${p.openPositionCount > 1 ? "s" : ""} (${(p.listPositions || []).join(", ")})`;
    if (bal > 0) items.push({ kind: "position", protocol: "Meteora DLMM", asset: `${pair} LP ${p.poolAddress.slice(0, 4)}`, amount: p.openPositionCount, usd: round(bal, 2), verified: ok && !thinPair(p.tokenXMint, p.tokenYMint, bal), pool: p.poolAddress, legs: [p.tokenXMint, p.tokenYMint].map((m) => ({ token: m, asset: jup.get(m)?.symbol || m })), detail: `${where}${p.outOfRange ? " (out of range)" : ""}; value as priced by Meteora${ok ? "" : "; a token Jupiter does not verify"}` });
    if (fee >= 0.01) items.push({
      category: "reward", protocol: "Meteora DLMM", asset: `${pair} fees`, amount: round(fee, 2), usd: ok ? round(fee, 2) : null, price: ok ? 1 : null, verified: ok, liquidity: Math.min(...[p.tokenXMint, p.tokenYMint].map((m) => jup.get(m)?.liquidity ?? Infinity)), status: "ready", confidence: "medium", usd_only: true,
      action: `claim the swap fees of the Meteora DLMM ${pair} position${p.openPositionCount > 1 ? "s" : ""}`, how_to_claim: METEORA_UI, pool: p.poolAddress,
      detail: `${where}: unclaimed swap fees worth $${round(fee, 2)} at Meteora's prices (amount in USD: Meteora gives no per-token split)`,
    });
  }
  for (const p of posns) {
    const x = p.token_x || {}, y = p.token_y || {}, cur = p.current_position || {}, pair = p.pool_name || `${x.symbol}-${y.symbol}`;
    const dep = cur.current_deposits || {}, bal = (num(dep.amount_x_usd) ?? 0) + (num(dep.amount_y_usd) ?? 0), ok = trustedPair(x.address, y.address);
    const where = `Meteora DAMM v2 ${pair} position ${p.position_address}`;
    // a locked or vesting share of the liquidity cannot be withdrawn now: a locked holding, the rest a position
    const lk = cur.locked_liquidity?.has_locked_liquidity ? Math.min(100, (num(cur.locked_liquidity.vesting_pct) ?? 0) + (num(cur.locked_liquidity.permanent_locked_pct) ?? 0)) / 100 : 0;
    const legs = [[x, dep.amount_x, dep.amount_x_usd], [y, dep.amount_y, dep.amount_y_usd]].map(([t, a, u]) => ({ token: t.address, asset: t.symbol, amount: round(num(a) ?? 0), usd: round(num(u) ?? 0, 2) }));
    for (const [kind, share] of [["position", 1 - lk], ["locked", lk]]) {
      if (!(bal * share > 0)) continue;
      items.push({ kind, protocol: "Meteora DAMM v2", asset: `${pair} LP ${String(p.position_address).slice(0, 4)}`, amount: round(share, 4), usd: round(bal * share, 2), verified: ok && !thinPair(x.address, y.address, bal), pool: p.pool_address, position: p.position_address, legs, detail: `${where}${kind === "locked" ? `: the locked or vesting ${round(lk * 100, 1)}% of the liquidity` : lk > 0 ? `: the unlocked ${round((1 - lk) * 100, 1)}%` : ""}; value as priced by Meteora${ok ? "" : "; a token Jupiter does not verify"}` });
    }
    const fees = cur.unclaimed_fees || {}, rw = cur.unclaimed_rewards || {};
    const parts = [[x, fees.amount_x, "fees"], [y, fees.amount_y, "fees"], [p.reward_token_x, rw.reward_amount_x, "rewards"], [p.reward_token_y, rw.reward_amount_y, "rewards"]];
    for (const [t, a, part] of parts) {
      const amount = num(a);
      if (!t?.address || !(amount > 0)) continue;
      const j = jup.get(t.address);
      items.push({
        category: "reward", protocol: "Meteora DAMM v2", asset: j?.symbol || t.symbol || t.address, token: t.address, amount, usd: usdOf(j, amount), ...px(j), status: "ready", confidence: "medium",
        action: `claim the ${part} of the Meteora DAMM v2 ${pair} position`, how_to_claim: METEORA_UI, position: p.position_address, pool: p.pool_address,
        detail: `${where}: unclaimed ${part === "fees" ? "swap fees" : "rewards"} as read by Meteora`,
      });
    }
  }
  return items;
}

// Jupiter first (verification, price, liquidity); a mint Jupiter has no row for (unknown, or the call was rate limited)
// falls back to DefiLlama at confidence >= 0.9, as in forgotten/soldead.mjs. A mint Jupiter lists as unverified stays unpriced
// Jupiter gets JUP_WAIT_MS: in a busy scan its free API answers 429 and the retries can take 20 s+, so past that the
// whole lookup falls back to DefiLlama (the Jupiter call still finishes and fills the cache)
const JUP_WAIT_MS = 3000;
async function pricesFor(ctx, mints) {
  let timer;
  const late = new Promise((ok) => { timer = setTimeout(() => ok(new Map()), JUP_WAIT_MS); timer.unref?.(); });
  const jup = await Promise.race([jupiter(ctx, mints), late]);
  clearTimeout(timer);
  const miss = [...new Set(mints.filter(Boolean))].filter((m) => !jup.has(m));
  if (!miss.length) return jup;
  const llama = await prices(ctx, miss.map((m) => `solana:${m}`));
  for (const m of miss) { const c = trusted(llama.get(`solana:${m}`.toLowerCase())); if (c) jup.set(m, { symbol: c.symbol, price: c.price, verified: true, liquidity: null }); }
  return jup;
}

// one Jupiter lookup for all parts: Jupiter's free API rate limits a busy scan, so each part asks for its mints once
// and the call goes when every part still running has asked (a part that ends without asking is let go)
function pricer(ctx, parts) {
  let waiting = [], open = parts;
  const flush = () => {
    if (!waiting.length || waiting.length < open) return;
    const batch = waiting;
    waiting = [];
    // sorted: the parts ask in any order, the call (and its cache key) stays the same
    pricesFor(ctx, [...new Set(batch.flatMap((w) => w.mints).filter(Boolean))].sort()).then((m) => batch.forEach((w) => w.ok(m)), (e) => batch.forEach((w) => w.no(e)));
  };
  return (fn) => async () => {
    let asked = false;
    const price = (mints) => { asked = true; return new Promise((ok, no) => { waiting.push({ mints, ok, no }); flush(); }); };
    try { return await fn(price); } finally { if (!asked) { open--; flush(); } }
  };
}

export async function solDefi(p, ctx) {
  if (!isSolAddr(p?.address)) throw { status: 400, error: "address must be a Solana address" };
  const owner = p.address, part = pricer(ctx, 5);
  const out = await each({ kamino: part((price) => kamino(ctx, owner, price)), marginfi: part((price) => marginfi(ctx, owner, price)), save: part((price) => save(ctx, owner, price)), clmm: part((price) => clmm(ctx, owner, price)), meteora: part((price) => meteora(ctx, owner, price)) });
  const hints = out.items.filter((i) => i.hint).map((i) => i.hint);
  const coverage = out.items.find((i) => i.coverage)?.coverage;
  const items = out.items.filter((i) => !i.hint && !i.coverage).map((i) => ({ chain: "solana", ...i }));
  return { items, errors: out.errors, ...(coverage && { coverage }), ...(hints.length && { notes: [...new Set(hints)] }) };
}
