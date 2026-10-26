// perps/rest.mjs - perp venues read from their own keyless REST APIs (routes holdings.<venue>_* in apis.mjs).
// Every venue here still trades, so balances are status live; ApeX Pro and edgeX only say an account exists (hint).
// Endpoints and positive wallets re-proven 2026-10-20.

const num = (x) => Number(x) || 0;
const fmt = (x) => (Math.abs(num(x)) < 0.01 && num(x) ? num(x).toPrecision(2) : num(x).toLocaleString("en-US", { maximumFractionDigits: 2 }));
const sum = (rows, f) => rows.reduce((s, r) => s + f(r), 0);

// Aster margin assets priced at 1 USD; the rest from Aster's own futures tickers (<ASSET>USDT)
const ASTER_STABLES = new Set(["USDT", "USDC", "USD1", "USDF", "FDUSD", "BUSD"]);
// ApeX Pro (StarkEx) shut down 2025-04-14; the forced withdrawal flow is live since 2025-07-30
const APEX_PRO_GUIDE = "https://www.apex.exchange/blog/detail/ApeX-Pro-Forced-Withdrawal-Process-Begins-on-July-11";
const DERIVE_CAP = 20; // subaccounts read per wallet (one margin_watch call each)
const ETHEREAL_SEED = 1e-6; // every new Ethereal subaccount holds a 0.0000001 USDe seed

const live = (protocol, chain, rest) => ({ protocol, chain, status: "live", ...rest });
const hint = (protocol, chain, asset, action, how_to_claim, detail) => ({
  protocol, chain, asset, amount: null, usd: null, kind: "deposit", status: "hint", confidence: "low", action, how_to_claim, deadline: null, detail,
});

async function aster(address, io) {
  const r = await io.call("holdings.aster", { address });
  // a JSON-RPC error makes the engine mark the call failed (ok false): "does not exist" = no Aster account
  if (/does not exist/i.test(r.data?.error?.message || "")) return [];
  if (!r.ok || r.data?.error) throw { error: `aster ${r.status}: ${JSON.stringify(r.data?.error || r.data).slice(0, 120)}` };
  const a = r.data?.result;
  // privacy on hides everything, and never-used addresses answer the same "enabled": it tells us nothing
  if (!a || a.accountPrivacy === "enabled") return [];
  const perp = (a.perpAssets || []).filter((x) => num(x.walletBalance) !== 0);
  const spot = (a.spotAssets || []).filter((x) => num(x.walletBalance) > 0);
  const pos = (a.positions || []).flatMap((g) => g.positions || []).filter((p) => num(p.positionAmount) !== 0);
  const st = a.staking || {};
  // staked, still waiting to stake, or unstaking: all of it is the wallet's ASTER
  const staked = num(st.totalStakedAmount) + num(st.totalPendingStakeAmount) + num(st.totalPendingUnstakeAmount), rewards = num(st.totalUnclaimedRewards);
  const need = [...perp, ...spot].map((x) => x.asset).filter((s) => !ASTER_STABLES.has(s));
  if (staked + rewards > 0) need.push("ASTER");
  const px = new Map();
  if (need.length) for (const t of (await io.get("holdings.aster_prices", {})) || []) if (t.symbol?.endsWith("USDT")) px.set(t.symbol.slice(0, -4), num(t.price));
  const price = (s) => (ASTER_STABLES.has(s) ? 1 : px.get(s) ?? null);
  const out = [];
  // perp margin nets per asset (USDT can sit negative against USDC collateral), so it is one equity row
  const upnl = sum(pos, (p) => num(p.unrealizedProfit));
  const unpriced = perp.filter((x) => price(x.asset) == null).map((x) => x.asset);
  const equity = sum(perp, (x) => num(x.walletBalance) * (price(x.asset) ?? 0)) + upnl;
  if (perp.length || pos.length) {
    const one = perp.length === 1 && ASTER_STABLES.has(perp[0].asset) ? perp[0].asset : "USD";
    const what = perp.map((x) => `${fmt(x.walletBalance)} ${x.asset}`).join(", ");
    const open = pos.length ? `, ${pos.length} open position${pos.length > 1 ? "s" : ""} (${pos.slice(0, 3).map((p) => p.symbol).join(", ")}${pos.length > 3 ? "..." : ""}) with ${fmt(upnl)} USD unrealized PnL` : "";
    if (equity > 0) out.push(live("Aster", "aster", {
      asset: one, amount: equity, usd: equity, kind: pos.length ? "position" : "deposit",
      detail: `Aster perps account equity: ${what || "no margin"}${open}${unpriced.length ? `; ${unpriced.join(", ")} not priced` : ""}.`,
    }));
  }
  for (const x of spot) out.push(live("Aster", "aster", {
    asset: x.asset, amount: num(x.walletBalance), usd: price(x.asset) == null ? null : num(x.walletBalance) * price(x.asset), kind: "deposit",
    detail: `Aster spot wallet balance.`,
  }));
  if (staked + rewards > 0) out.push(live("Aster", "aster", {
    asset: "ASTER", amount: staked + rewards, usd: price("ASTER") == null ? null : (staked + rewards) * price("ASTER"), kind: "deposit",
    detail: `Aster staking: ${fmt(staked)} ASTER staked (incl. pending stake or unstake), ${fmt(rewards)} ASTER unclaimed rewards.`,
  }));
  return out;
}

async function ostium(address, io) {
  const [t, l] = await Promise.all([io.get("holdings.ostium_trades", { address }), io.get("holdings.ostium_limits", { address })]);
  const trades = (t?.trades || []).filter((x) => x.isOpen !== false), limits = (l?.limits || []).filter((x) => x.isActive !== false);
  const out = [];
  // netValue = collateral + PnL - fees; a trade past liquidation is worth 0, not a debt
  const value = sum(trades, (x) => Math.max(0, x.netValue ?? num(x.collateral)));
  const pairs = (rows) => [...new Set(rows.map((x) => `${x.pair?.from}-${x.pair?.to}`))].slice(0, 4).join(", ");
  if (value > 0) out.push(live("Ostium", "arbitrum", {
    asset: "USDC", amount: value, usd: value, kind: "position",
    detail: `Ostium: ${trades.length} open trade${trades.length > 1 ? "s" : ""} (${pairs(trades)}), ${fmt(sum(trades, (x) => num(x.collateral)))} USDC collateral, net value after PnL and fees.`,
  }));
  const held = sum(limits, (x) => num(x.collateral));
  if (held > 0) out.push(live("Ostium", "arbitrum", {
    asset: "USDC", amount: held, usd: held, kind: "deposit",
    detail: `Ostium: ${limits.length} resting limit order${limits.length > 1 ? "s" : ""} (${pairs(limits)}) holding USDC collateral.`,
  }));
  return out;
}

async function veranta(address, io) {
  const d = await io.get("holdings.veranta", { address });
  const pos = d?.positions || [], lim = d?.limitOrders || [];
  const usdc = (rows) => sum(rows, (x) => num(x.collateral)) / 1e6; // raw USDC, 6 decimals
  const out = [];
  if (usdc(pos) > 0) out.push(live("Veranta", "base", {
    asset: "USDC", amount: usdc(pos), usd: usdc(pos), kind: "position",
    detail: `Veranta (ex Avantis): ${pos.length} open position${pos.length > 1 ? "s" : ""}, collateral only (PnL not included).`,
  }));
  if (usdc(lim) > 0) out.push(live("Veranta", "base", {
    asset: "USDC", amount: usdc(lim), usd: usdc(lim), kind: "deposit",
    detail: `Veranta (ex Avantis): ${lim.length} resting limit order${lim.length > 1 ? "s" : ""} holding USDC collateral.`,
  }));
  return out;
}

async function reya(address, io) {
  const r = await io.call("holdings.reya_balances", { address });
  if (!r.ok) {
    if (/NO_ACCOUNTS_FOUND/.test(JSON.stringify(r.data))) return [];
    throw { error: `reya ${r.status}: ${JSON.stringify(r.data).slice(0, 120)}` };
  }
  const per = new Map();
  for (const b of Array.isArray(r.data) ? r.data : []) {
    const p = per.get(b.asset) || per.set(b.asset, { amount: 0, accounts: new Set() }).get(b.asset);
    p.amount += num(b.realBalance); // balanceDEPRECATED is the old figure
    if (num(b.realBalance)) p.accounts.add(b.accountId);
  }
  const rows = [...per].filter(([, p]) => p.amount > 1e-9);
  if (!rows.length) return [];
  const px = new Map([["RUSD", 1], ["USDC", 1]]);
  if (rows.some(([s]) => !px.has(s))) for (const o of (await io.get("holdings.reya_prices", {})) || []) if (!px.has(o.asset)) px.set(o.asset, num(o.oraclePrice));
  return rows.map(([asset, p]) => live("Reya", "reya", {
    asset, amount: p.amount, usd: px.has(asset) ? p.amount * px.get(asset) : null, kind: "deposit",
    detail: `Reya margin account${p.accounts.size > 1 ? "s" : ""} ${[...p.accounts].join(", ")}: ${asset} balance (open position PnL not included).`,
  }));
}

async function nado(address, io) {
  const subs = (await io.get("holdings.nado_subaccounts", { address }))?.subaccounts || [];
  const out = [];
  for (const s of subs) {
    const d = (await io.get("holdings.nado_info", { subaccount: s.subaccount }))?.data;
    // healths[2] = unweighted net value (assets - liabilities at oracle prices), x18
    const usd = Number(BigInt(d?.healths?.[2]?.health || "0")) / 1e18;
    if (usd <= 0) continue;
    const perps = (d.perp_balances || []).filter((b) => num(b.balance?.amount) !== 0).length;
    out.push(live("Nado", "ink", {
      asset: "USD", amount: usd, usd, kind: perps ? "position" : "deposit",
      detail: `Nado subaccount "${s.subaccount_name}"${s.isolated ? " (isolated)" : ""}: net value${perps ? ` incl. ${perps} open perp position${perps > 1 ? "s" : ""}` : ""}.`,
    }));
  }
  return out;
}

async function risex(address, io) {
  const d = (await io.get("holdings.risex", { address }))?.data;
  const s = d?.summary || {}, usd = num(s.total_account_value);
  if (usd <= 0) return [];
  const open = (d.positions || []).filter((p) => num(p.size) !== 0);
  return [live("RISEx", "rise", {
    asset: "USDC", amount: usd, usd, kind: open.length ? "position" : "deposit",
    detail: `RISEx account value: ${fmt(s.usdc_balance)} USDC balance${open.length ? `, ${open.length} open position${open.length > 1 ? "s" : ""} with ${fmt(s.total_unrealized_pnl)} USD unrealized PnL` : ""}.`,
  })];
}

const bytes32Name = (h) => (/^0x[0-9a-f]{64}$/i.test(h || "") ? Buffer.from(h.slice(2), "hex").toString("utf8").replace(/\0+$/, "") : h);

async function ethereal(address, io) {
  const subs = (await io.get("holdings.ethereal_subaccounts", { address }))?.data || [];
  const out = [];
  for (const s of subs) {
    const bal = (await io.get("holdings.ethereal_balance", { id: s.id }))?.data || [];
    const amount = sum(bal, (b) => num(b.amount)); // tokenName USD = USDe collateral
    if (amount <= ETHEREAL_SEED) continue;
    out.push(live("Ethereal", "ethereal", {
      asset: "USDe", amount, usd: amount, kind: "deposit",
      detail: `Ethereal subaccount "${bytes32Name(s.name)}": USDe balance (open position PnL not included).`,
    }));
  }
  return out;
}

async function derive(address, io) {
  const ids = (await io.get("holdings.derive_subaccounts", { address }))?.result?.subaccount_ids || [];
  const read = ids.slice(0, DERIVE_CAP), capped = ids.length > read.length;
  const out = [];
  for (const id of read) { // one at a time: the API rate limits bursts
    const m = (await io.get("holdings.derive_margin", { id }))?.result;
    const usd = num(m?.subaccount_value); // mark to market, positions included
    if (usd <= 0.01) continue;
    const n = (m.positions || []).length;
    out.push(live("Derive", "derive", {
      asset: "USD", amount: usd, usd, kind: n ? "position" : "deposit",
      detail: `Derive subaccount ${id}: value${n ? ` incl. ${n} open position${n > 1 ? "s" : ""}` : ""}${capped ? ` (first ${DERIVE_CAP} of ${ids.length} subaccounts read)` : ""}.`,
    }));
  }
  return out;
}

async function apexPro(address, io) {
  if ((await io.get("holdings.apex_pro_exists", { address }))?.data !== true) return [];
  return [hint("ApeX Pro", "ethereum", "USDC",
    "ApeX Pro shut down in April 2025: follow the StarkEx forced withdrawal guide to pull any leftover USDC on Ethereum.",
    APEX_PRO_GUIDE, "ApeX Pro account registered, open the app to check the balance (some registrations never deposited).")];
}

async function edgex(address, io) {
  if ((await io.get("holdings.edgex_exists", { address }))?.data?.isUserExist !== true) return [];
  return [hint("edgeX", "edgex", "USDC", "Open edgeX and check the account balance.", "https://pro.edgex.exchange/",
    "edgeX account registered, open the app to check the balance.")];
}

export const EVM = { aster, ostium, veranta, reya, nado, risex, ethereal, derive, "apex-pro": apexPro, edgex };
