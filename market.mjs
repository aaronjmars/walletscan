// Public market evidence for gaps in the primary prices. A spot quote is never proof that a token is safe
// or that the entire balance can be sold. Provider rows describing the same pool are counted once.
const num = (v) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const lower = (s) => String(s || "").toLowerCase();
const addr = (s) => /^0x/i.test(s) ? lower(s) : String(s || "");
const NETWORKS = {
  ethereum: ["ethereum", "eth"], optimism: ["optimism", "optimism"], arbitrum: ["arbitrum", "arbitrum"],
  base: ["base", "base"], polygon: ["polygon", "polygon_pos"], bsc: ["bsc", "bsc"], avalanche: ["avalanche", "avax"],
  gnosis: ["gnosischain", "xdai"], blast: ["blast", "blast"], mantle: ["mantle", "mantle"], linea: ["linea", "linea"],
  scroll: ["scroll", "scroll"], zksync: ["zksync", "zksync"], era: ["zksync", "zksync"], sonic: ["sonic", "sonic"],
  solana: ["solana", "solana"], robinhood: ["robinhood", "robinhood"], hyperevm: ["hyperevm", "hyperevm"],
  sei: ["seiv2", "sei-network"], monad: ["monad", "monad"], unichain: ["unichain", "unichain"],
};
const ALIASES = { eth: "ethereum", avax: "avalanche", "arbitrum-one": "arbitrum", "polygon-bor": "polygon", binance: "bsc", xdai: "gnosis" };
export const marketNetwork = (chain) => NETWORKS[ALIASES[chain] || chain];

export function dexPools(data, token, chain) {
  return (Array.isArray(data) ? data : data?.pairs || []).flatMap((p) => {
    // DEX Screener's priceUsd is the BASE token price. Do not apply it to a quote-token holding.
    if (p.chainId !== chain || addr(p.baseToken?.address) !== addr(token) || !p.pairAddress) return [];
    return [{ pool: addr(p.pairAddress), dex: p.dexId, price: num(p.priceUsd), liquidity: num(p.liquidity?.usd),
      volume_24h: num(p.volume?.h24), symbol: p.baseToken?.symbol, provider: "dexscreener", url: p.url }];
  });
}
export function geckoPools(data, token, network) {
  const included = new Map((data?.included || []).map((x) => [x.id, x.attributes]));
  return (data?.data || []).flatMap((p) => {
    const a = p.attributes || {}, rel = p.relationships || {};
    const base = rel.base_token?.data?.id, quote = rel.quote_token?.data?.id;
    const is = (id) => id && (!network || id.startsWith(`${network}_`)) && addr(id.slice(id.indexOf("_") + 1)) === addr(token);
    const side = is(base) ? "base" : is(quote) ? "quote" : null;
    if (!side || !a.address) return [];
    return [{ pool: addr(a.address), dex: rel.dex?.data?.id, price: num(a[`${side}_token_price_usd`]),
      liquidity: num(a.reserve_in_usd), volume_24h: num(a.volume_usd?.h24),
      symbol: included.get(side === "base" ? base : quote)?.symbol, provider: "geckoterminal" }];
  });
}

export function selectMarketQuote(pools, { valueUsd = 0 } = {}) {
  const uniq = new Map();
  for (const p of pools) {
    if (!(Number.isFinite(p.price) && p.price > 0 && Number.isFinite(p.liquidity) && p.liquidity >= Math.max(50000, Number(valueUsd || 0) * 2) && Number.isFinite(p.volume_24h) && p.volume_24h >= 1000)) continue;
    // Prefer the deepest observation, not the highest token price.
    if (!uniq.has(p.pool) || uniq.get(p.pool).liquidity < p.liquidity) uniq.set(p.pool, p);
  }
  const good = [...uniq.values()].sort((a, b) => b.liquidity - a.liquidity);
  if (!good.length) return { price: null, pools: [], reason: "no active pool with enough liquidity" };
  const best = good[0];
  if (good.some((p) => p.liquidity >= best.liquidity / 4 && Math.abs(p.price / best.price - 1) > 0.2)) {
    return { price: null, pools: good, reason: "deep pools disagree on the token price" };
  }
  return { price: best.price, symbol: best.symbol, liquidity: best.liquidity, pools: good, price_from: best.provider,
    observed_at: new Date().toISOString(), warning: "spot market estimate; not an executable sale quote" };
}

export async function marketQuote(p, ctx) {
  const net = marketNetwork(p.chain);
  const token = p.token || p.mint;
  if (!net || !token) throw { status: 400, error: "supported chain and token are required" };
  const errors = [], pools = [];
  const read = async (id, params, parse) => {
    try {
      const r = await ctx.call(id, params);
      if (!r.ok && id === "token.gecko_pools" && r.status === 404) return;
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      pools.push(...parse(r.data));
    } catch (e) { errors.push({ id, reason: String(e.error || e.message || e).slice(0, 100) }); }
  };
  await read("token.dexscreener_pairs", { chain: net[0], tokens: token }, (d) => dexPools(d, token, net[0]));
  // Keep GeckoTerminal's much smaller public quota for gaps and conflicting quotes.
  let quote = selectMarketQuote(pools, { valueUsd: p.value_usd });
  if (quote.price == null && p.gecko !== "0") {
    await read("token.gecko_pools", { network: net[1], token }, (d) => geckoPools(d, token, net[1]));
    quote = selectMarketQuote(pools, { valueUsd: p.value_usd });
  }
  return { chain: p.chain, token, ...quote, errors };
}

// Only a bounded number of missing prices per scan. Keep all remaining rows and make the budget visible.
export async function fillMarketGaps(ctx, run, { max = 8 } = {}) {
  const candidates = new Map();
  for (const row of [...run.findings, ...run.holdings]) {
    const token = row.mint || row.token;
    if (row.usd != null || !(num(row.amount) > 0) || !token || token === "native" || /^0x0{40}$/.test(token) || !marketNetwork(row.chain)) continue;
    const key = `${row.chain}:${addr(token)}`;
    if (!candidates.has(key)) candidates.set(key, []);
    candidates.get(key).push(row);
  }
  const selected = [...candidates.values()].slice(0, max);
  let priced = 0, checked = 0;
  const until = Date.now() + 12000, errors = [];
  for (const rows of selected) {
    if (Date.now() >= until) break;
    checked++;
    const row = rows[0], token = row.mint || row.token;
    try {
      const r = await ctx.call("token.market_quote", { chain: row.chain, token, gecko: checked <= 2 ? "1" : "0" });
      const q = r.ok ? r.data : null;
      if (!q) throw new Error(`upstream ${r.status}`);
      errors.push(...(q.errors || []));
      if (!(q.price > 0)) continue;
      let applied = false;
      for (const x of rows) {
        const usd = Number(x.amount) * q.price;
        if (!Number.isFinite(usd) || q.liquidity < usd * 2) continue;
        applied = true;
        x.usd = Math.round(usd * 100) / 100;
        x.price_from = q.price_from;
        x.price_observed_at = q.observed_at;
        if (x.asset === token && q.symbol) x.asset = q.symbol;
        if (x.category) { if (x.confidence === "high") x.confidence = "medium"; }
        else x.verified = false;
        x.detail = [x.detail, `${q.price_from} spot price, $${Math.round(q.liquidity)} pool liquidity; check the sale route before claiming`].filter(Boolean).join("; ");
      }
      if (applied) priced++;
    } catch (e) { errors.push({ id: "token.market_quote", reason: String(e.error || e.message || e).slice(0, 100) }); }
  }
  return { candidates: candidates.size, checked, priced, unchecked: Math.max(0, candidates.size - checked), errors };
}

export function rugcheckVerdict(data) {
  if (!data || !Array.isArray(data.risks)) return null;
  const risks = data.risks.filter((r) => r && typeof r.name === "string");
  return { risks: risks.map((r) => ({ name: r.name, level: r.level, description: r.description })),
    danger: risks.some((r) => lower(r.level) === "danger"), score: num(data.score_normalised) };
}
export async function rugcheckRows(ctx, run, { max = 8 } = {}) {
  const byMint = new Map();
  for (const row of [...run.findings, ...run.holdings].sort((a, b) => (b.usd || 0) - (a.usd || 0))) {
    const mint = row.mint || row.token;
    if (row.chain !== "solana" || !mint || (row.category ? row.confidence === "high" : row.verified || !(row.usd > 0))) continue;
    if (!byMint.has(mint)) byMint.set(mint, []);
    byMint.get(mint).push(row);
  }
  let checked = 0;
  const until = Date.now() + 10000, errors = [];
  for (const [mint, rows] of [...byMint].slice(0, max)) {
    if (Date.now() >= until) break;
    try {
      const r = await ctx.call("token.rugcheck", { mint });
      const v = r.ok ? rugcheckVerdict(r.data) : null;
      if (!v) throw new Error(`no report (upstream ${r.status})`);
      checked++;
      for (const row of rows) {
        row.risk_flags = v.risks;
        if (v.danger) { if (row.category) row.confidence = "low"; else row.verified = false; }
        if (v.risks.length) row.detail = [row.detail, `Rugcheck: ${v.risks.map((r) => r.name).join(", ")}`].filter(Boolean).join("; ");
      }
    } catch (e) { errors.push({ mint, reason: String(e.error || e.message || e).slice(0, 100) }); }
  }
  return { candidates: byMint.size, checked, unchecked: byMint.size - checked, errors };
}
