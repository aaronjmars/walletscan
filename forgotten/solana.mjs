// forgotten/solana.mjs - Solana program accounts a wallet forgot: Serum v3 OpenOrders (tokens left after Serum
// died + account rent), Marinade delayed-unstake tickets never claimed, BPF upgradeable-loader buffers from failed
// deploys (sol.leftovers), and Streamflow vesting / lock streams where the wallet is the recipient
// (sol.vesting_streams). Reads are getProgramAccounts with a memcmp on the wallet (base64, decoded here), then
// getMultipleAccounts for markets, mints and vaults, and Jupiter for verification + price. Facts only: the
// readiness that depends on the epoch or the clock is decided again in the normalizers.
import { base58 } from "@scure/base";
import { isSolAddr, WSOL } from "../solana.mjs";
import { each } from "./evm.mjs";
import { noteKey } from "../keyless.mjs";

const rpc = (method, params = []) => ({ jsonrpc: "2.0", id: 1, method, params });
export const b64 = (acc) => Buffer.from(acc?.data?.[0] || "", "base64");
export const u64 = (buf, o) => (buf.length >= o + 8 ? buf.readBigUInt64LE(o) : 0n);
export const key = (buf, o) => base58.encode(buf.subarray(o, o + 32));
const iso = (s) => (s > 0n ? new Date(Number(s) * 1000).toISOString() : null);
export const scale = (raw, dec) => Number(raw) / 10 ** Number(dec || 0);
export const round = (v, d = 6) => Math.round(v * 10 ** d) / 10 ** d;

export async function result(ctx, id, params, over) {
  const r = await ctx.call(id, params, over);
  if (!r.ok) throw { status: 502, error: `step ${id} failed (upstream ${r.status})`, detail: r.data };
  if (r.data?.error) throw { status: 502, error: `${id} failed`, detail: r.data.error };
  return r.data?.result;
}
// getMultipleAccounts (jsonParsed) in chunks of 100 -> Map(pubkey -> account | null)
export async function accounts(ctx, keys) {
  const uniq = [...new Set(keys.filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < uniq.length; i += 100) {
    const part = uniq.slice(i, i + 100);
    const v = (await result(ctx, "sol.accounts", { pubkeys: part.join(",") }))?.value || [];
    part.forEach((k, j) => out.set(k, v[j] ?? null));
  }
  return out;
}
// Jupiter token rows by mint; verified = Jupiter's own check (isVerified or the verified / strict tag)
export async function jupiter(ctx, mints) {
  const uniq = [...new Set(mints.filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < uniq.length; i += 100) {
    const r = await ctx.call("token.jup_info", { query: uniq.slice(i, i + 100).join(",") }).catch(() => null);
    for (const t of r?.ok && Array.isArray(r.data) ? r.data : []) out.set(t.id, { symbol: t.symbol, price: t.usdPrice ?? null, verified: !!(t.isVerified || (t.tags || []).some((x) => x === "verified" || x === "strict")), liquidity: t.liquidity ?? null });
  }
  return out;
}
export const tokenAmount = (acc) => { try { return BigInt(acc?.data?.parsed?.info?.tokenAmount?.amount ?? 0); } catch { return 0n; } };
export const decimalsOf = (acc) => acc?.data?.parsed?.info?.decimals ?? null;
export const priced = (t) => !!(t && t.verified && t.price != null);

const SERUM = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const MARINADE_TICKET = "854d1262d301e703"; // anchor discriminator of TicketAccountData
const OO_OPEN_ORDERS = 4n; // Serum AccountFlag bits: 1 initialized, 4 open orders, 8 closed

// Serum v3: OpenOrders of the owner, then their markets (mints + vaults), then mints (decimals) and vault balances
async function serum(ctx, owner) {
  const rows = (await result(ctx, "sol.serum_open_orders", { owner })) || [];
  const oo = [];
  for (const r of rows) {
    const d = b64(r.account);
    if (d.subarray(0, 5).toString() !== "serum" || !(u64(d, 5) & OO_OPEN_ORDERS) || key(d, 45) !== owner) continue;
    oo.push({ pubkey: r.pubkey, lamports: Number(r.account.lamports || 0), market: key(d, 13), baseFree: u64(d, 77), baseTotal: u64(d, 85), quoteFree: u64(d, 93), quoteTotal: u64(d, 101) });
  }
  if (!oo.length) return [];
  const funded = oo.filter((o) => o.baseTotal > 0n || o.quoteTotal > 0n);
  const mk = await accounts(ctx, funded.map((o) => o.market));
  const market = new Map();
  for (const [k, a] of mk) { const d = b64(a); if (d.length >= 197) market.set(k, { base: key(d, 53), quote: key(d, 85), baseVault: key(d, 117), quoteVault: key(d, 165) }); }
  const ms = [...market.values()];
  const [acc, jup] = await Promise.all([accounts(ctx, ms.flatMap((m) => [m.base, m.quote, m.baseVault, m.quoteVault])), jupiter(ctx, [WSOL, ...ms.flatMap((m) => [m.base, m.quote])])]);
  const sol = jup.get(WSOL)?.price ?? null;
  const items = [];
  for (const o of funded) {
    const m = market.get(o.market);
    if (!m) { items.push({ category: "unstake_ready", chain: "solana", protocol: "Serum", asset: null, token: null, amount: null, usd: null, status: "unknown_market", account: o.pubkey, market: o.market, detail: `OpenOrders ${o.pubkey} holds funds of market ${o.market}, which could not be read` }); continue; }
    for (const [side, mint, vault, free, total] of [["base", m.base, m.baseVault, o.baseFree, o.baseTotal], ["quote", m.quote, m.quoteVault, o.quoteFree, o.quoteTotal]]) {
      if (total <= 0n) continue;
      const dec = decimalsOf(acc.get(mint)), t = jup.get(mint);
      if (dec == null) continue;
      const amount = scale(total, dec), vaultRaw = tokenAmount(acc.get(vault));
      items.push({
        category: "unstake_ready", chain: "solana", protocol: "Serum", asset: t?.symbol || mint, token: mint, side, amount, free: scale(free, dec), in_orders: scale(total - free, dec),
        usd: priced(t) ? round(amount * t.price, 2) : null, price: t?.price ?? null, verified: !!t?.verified, liquidity: t?.liquidity ?? null,
        status: free === total ? "ready" : "in_orders", vault, vault_covers: vaultRaw >= total, account: o.pubkey, market: o.market,
        action: free === total ? "settle the Serum OpenOrders funds to the wallet (SettleFunds)" : "cancel the resting Serum orders, crank the market, then settle the funds (SettleFunds)",
        how_to_claim: `https://solscan.io/account/${o.pubkey}`,
        detail: `Serum v3 OpenOrders ${o.pubkey} on market ${o.market}: ${side} ${scale(free, dec)} free, ${scale(total - free, dec)} in resting orders; market vault ${vault} ${vaultRaw >= total ? "still holds it" : "holds less than this"}`,
      });
    }
  }
  // rent: CloseOpenOrders gives the account's lamports back once both sides are settled
  const idle = (o) => o.baseFree === o.baseTotal && o.quoteFree === o.quoteTotal;
  const ready = oo.filter(idle), blocked = oo.filter((o) => !idle(o));
  const rentItem = (list, status) => {
    const amount = list.reduce((t, o) => t + o.lamports, 0) / 1e9;
    return {
      category: "solana_rent", chain: "solana", protocol: "Serum", asset: "SOL", token: WSOL, amount, usd: sol == null ? null : round(amount * sol, 2), status, accounts: list.map((o) => o.pubkey), count: list.length,
      action: `close ${list.length} Serum OpenOrders account${list.length > 1 ? "s" : ""} (CloseOpenOrders${status === "ready" ? ", after SettleFunds where funds are left" : ", after cancelling resting orders and settling"})`,
      how_to_claim: `https://solscan.io/account/${list[0].pubkey}`,
      detail: `${list.length} Serum v3 OpenOrders account${list.length > 1 ? "s hold" : " holds"} a rent deposit; the Serum apps are gone but the program still runs (serum-ts SDK or a script: SettleFunds, then CloseOpenOrders)`,
    };
  };
  if (ready.length) items.push(rentItem(ready, "ready"));
  if (blocked.length) items.push(rentItem(blocked, "in_orders"));
  return items;
}

// Marinade delayed unstake: TicketAccountData {state, beneficiary @40, lamports_amount @72, created_epoch @80};
// claim pays lamports_amount + the ticket's own rent, from epoch created_epoch + 1 (and 30 min into it)
async function marinade(ctx, owner) {
  const [rows, info] = await Promise.all([
    result(ctx, "sol.marinade_tickets", { owner }),
    result(ctx, "sol.rent_minimum", {}, { body: rpc("getEpochInfo") }).catch(() => null),
  ]);
  const tickets = (rows || []).map((r) => ({ r, d: b64(r.account) })).filter(({ d }) => d.subarray(0, 8).toString("hex") === MARINADE_TICKET && key(d, 40) === owner && u64(d, 72) > 0n);
  if (!tickets.length) return [];
  const sol = (await jupiter(ctx, [WSOL])).get(WSOL)?.price ?? null;
  const epoch = info?.epoch ?? null;
  return tickets.map(({ r, d }) => {
    const created = Number(u64(d, 80)), stake = Number(u64(d, 72)), rent = Number(r.account.lamports || 0), amount = (stake + rent) / 1e9;
    return {
      category: "unstake_ready", chain: "solana", protocol: "Marinade", asset: "SOL", token: WSOL, amount, usd: sol == null ? null : round(amount * sol, 2),
      status: epoch == null ? "unknown" : epoch > created + 1 ? "ready" : epoch === created + 1 ? "ready_after_30min" : "pending",
      ticket: r.pubkey, created_epoch: created, epoch, unstaked_sol: stake / 1e9, rent_sol: rent / 1e9,
      action: "claim the Marinade delayed-unstake ticket", how_to_claim: "https://app.marinade.finance/unstake",
      detail: `ticket ${r.pubkey}: ${stake / 1e9} SOL unstaked in epoch ${created} + ${rent / 1e9} SOL ticket rent, both paid on claim; claimable from epoch ${created + 1}`,
    };
  });
}

// BPF upgradeable loader buffers (tag 1) whose authority is the wallet: `solana program close` returns every lamport
async function buffers(ctx, owner) {
  const rows = (await result(ctx, "sol.program_buffers", { owner })) || [];
  const list = rows.filter((r) => { const d = b64(r.account); return d.length >= 37 && d.readUInt32LE(0) === 1 && d[4] === 1 && key(d, 5) === owner; });
  if (!list.length) return [];
  const sol = (await jupiter(ctx, [WSOL])).get(WSOL)?.price ?? null;
  return list.map((r) => {
    const amount = Number(r.account.lamports || 0) / 1e9;
    return {
      category: "solana_rent", chain: "solana", protocol: "Solana program buffer", asset: "SOL", token: WSOL, amount, usd: sol == null ? null : round(amount * sol, 2), status: "ready",
      buffer: r.pubkey, bytes: r.account.space ?? null,
      action: `close the leftover program buffer: solana program close ${r.pubkey} --recipient <your wallet>`, how_to_claim: `https://solscan.io/account/${r.pubkey}`,
      detail: `upgradeable-loader buffer ${r.pubkey} (${r.account.space ?? "?"} bytes) left by a failed or unfinished program deploy; the wallet is its authority, so closing it returns all its SOL`,
    };
  });
}

export async function solLeftovers(p, ctx) {
  if (!isSolAddr(p?.address)) throw { status: 400, error: "address must be a Solana address" };
  const owner = p.address;
  // the public Solana RPC does not index the Serum program: without HELIUS_API_KEY that part is skipped and noted
  const serumLive = !ctx.live || ctx.live("sol.serum_open_orders");
  if (!serumLive) noteKey("HELIUS_API_KEY", "Serum v3 OpenOrders rent deposits (the public Solana RPC does not index the Serum program)");
  const out = await each({ serum: async () => (serumLive ? serum(ctx, owner) : []), marinade: () => marinade(ctx, owner), buffers: () => buffers(ctx, owner) });
  return { ...out, epoch: out.items.find((i) => i.protocol === "Marinade")?.epoch ?? null };
}

// ---- Streamflow ----------------------------------------------------------------------------------------------
const STREAM = { withdrawn: 17, canceled: 25, end: 33, sender: 49, recipient: 113, mint: 177, escrow: 209, start: 409, deposited: 417, period: 425, perPeriod: 433, cliff: 441, cliffAmount: 449, name: 463, closed: 671, pauseStart: 672, lastRate: 688, unlockedAtRate: 696 };

async function streamflowStreams(ctx, owner) {
  const rows = (await result(ctx, "sol.streamflow_streams", { owner })) || [];
  const streams = [];
  for (const r of rows) {
    const d = b64(r.account);
    if (d.length < 704 || key(d, STREAM.recipient) !== owner || d[STREAM.closed] === 1) continue;
    const s = {
      stream: r.pubkey, sender: key(d, STREAM.sender), mint: key(d, STREAM.mint), escrow: key(d, STREAM.escrow),
      name: d.subarray(STREAM.name, STREAM.name + 64).toString("utf8").replace(/\0+$/g, "").trim() || null,
      withdrawn: u64(d, STREAM.withdrawn), canceled_at: u64(d, STREAM.canceled), end: u64(d, STREAM.end), start: u64(d, STREAM.start), deposited: u64(d, STREAM.deposited),
      period: u64(d, STREAM.period), amount_per_period: u64(d, STREAM.perPeriod), cliff: u64(d, STREAM.cliff), cliff_amount: u64(d, STREAM.cliffAmount),
      paused_at: u64(d, STREAM.pauseStart), last_rate_change_time: u64(d, STREAM.lastRate), funds_unlocked_at_last_rate_change: u64(d, STREAM.unlockedAtRate),
    };
    if (s.deposited <= s.withdrawn) continue; // fully withdrawn
    streams.push(s);
  }
  if (!streams.length) return [];
  const [acc, jup] = await Promise.all([accounts(ctx, streams.flatMap((s) => [s.mint, s.escrow])), jupiter(ctx, streams.map((s) => s.mint))]);
  const out = [];
  for (const s of streams) {
    const dec = decimalsOf(acc.get(s.mint)), escrow = acc.get(s.escrow), t = jup.get(s.mint);
    if (dec == null || !escrow) continue; // escrow gone = nothing left to take
    const escrowRaw = tokenAmount(escrow);
    const raw = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]));
    out.push({
      category: "vesting", chain: "solana", protocol: "Streamflow", asset: t?.symbol || s.mint, token: s.mint, decimals: dec,
      amount: scale(s.deposited - s.withdrawn, dec), usd: priced(t) ? round(scale(s.deposited - s.withdrawn, dec) * t.price, 2) : null,
      price: t?.price ?? null, verified: !!t?.verified, liquidity: t?.liquidity ?? null, escrow_raw: escrowRaw.toString(),
      status: s.canceled_at > 0n ? "canceled" : s.paused_at > 0n ? "paused" : "active",
      starts: iso(s.start), cliff_at: iso(s.cliff), ends: iso(s.end),
      action: "withdraw the unlocked part of the Streamflow stream", how_to_claim: `https://app.streamflow.finance/contract/solana/mainnet/${s.stream}`,
      detail: `Streamflow stream ${s.stream}${s.name ? ` "${s.name}"` : ""} from ${s.sender}; amount = deposited - withdrawn, still in the stream (unlocked now + locked)`,
      ...raw,
    });
  }
  return out;
}

export async function solStreams(p, ctx) {
  if (!isSolAddr(p?.address)) throw { status: 400, error: "address must be a Solana address" };
  return each({ streamflow: () => streamflowStreams(ctx, p.address) });
}
