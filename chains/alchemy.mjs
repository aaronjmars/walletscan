// chains/alchemy.mjs - ERC-20 balances on every network Alchemy's Portfolio API covers (34 EVM mainnets, 2026-10-15),
// with Alchemy's DEX price as the last-resort price. Rows go through chains/index.mjs's addToken, so dedupe,
// DefiLlama pricing and the balanceOf re-read work unchanged. The other ~70 Alchemy networks answer plain RPC only
// (no token API), so the RPC sweep already covers them. Limits measured 2026-10-15: 3 addresses x 20 networks per
// call, 100 rows per page.
// Portfolio network slug -> chain id. Polygon answers come back labelled matic-mainnet.
export const ALCHEMY_PORTFOLIO = {
  "eth-mainnet": 1, "base-mainnet": 8453, "matic-mainnet": 137, "polygon-mainnet": 137, "bnb-mainnet": 56, "arb-mainnet": 42161,
  "opt-mainnet": 10, "avax-mainnet": 43114, "gnosis-mainnet": 100, "berachain-mainnet": 80094, "blast-mainnet": 81457,
  "celo-mainnet": 42220, "monad-mainnet": 143, "linea-mainnet": 59144, "zksync-mainnet": 324, "scroll-mainnet": 534352,
  "zora-mainnet": 7777777, "unichain-mainnet": 130, "hyperliquid-mainnet": 999, "robinhood-mainnet": 4663, "lens-mainnet": 232,
  "shape-mainnet": 360, "soneium-mainnet": 1868, "story-mainnet": 1514, "abstract-mainnet": 2741, "apechain-mainnet": 33139,
  "anime-mainnet": 69000, "arc-mainnet": 5042, "ink-mainnet": 57073, "mythos-mainnet": 42018, "ronin-mainnet": 2020,
  "rootstock-mainnet": 30, "settlus-mainnet": 5371, "worldchain-mainnet": 480, "zetachain-mainnet": 7000,
};
export const ALCHEMY_IDS = new Set(Object.values(ALCHEMY_PORTFOLIO));
// heavy networks first, one per group, so no group pages much longer than the others
const NETS = ["base-mainnet", "polygon-mainnet", "eth-mainnet", "bnb-mainnet", ...Object.keys(ALCHEMY_PORTFOLIO).filter((n) => !/^(base|polygon|matic|eth|bnb)-mainnet$/.test(n))];
const GROUPS = 4; // 34 networks -> 4 calls of <= 9 (the API takes 20 unique networks; the docs say 5, so keep slack)
// airdropped scam tokens put a link or a claim call in the name; Alchemy prices almost none of them (3 of 807 here)
export const SPAMMY = /(https?:|www\.|\.(com|io|xyz|org|net|app|site|lat|lol|world|vip|top|fi|cc|gift|link)\b|t\.me|claim|visit|reward|airdrop|voucher)/i;
const HOUR = 3600000;

async function postJson(url, body, ms) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`http ${r.status} from alchemy portfolio`);
  return r.json();
}

// tokens: the shared Map(chain id -> Map(token -> row)); addToken is chains/index.mjs's (first source wins per key)
export async function alchemyTokens(address, tokens, until, { addToken, key = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY, maxPages = 20 } = {}) {
  if (!key) return { skipped: "no key" };
  const url = `https://api.g.alchemy.com/data/v1/${key}/assets/tokens/by-address`;
  const groups = Array.from({ length: GROUPS }, (_, g) => NETS.filter((_, i) => i % GROUPS === g));
  const stats = { calls: 0, rows: 0, kept: 0, spam: 0, failed: [] };
  await Promise.all(groups.map(async (networks) => {
    let pageKey;
    for (let page = 0; page < maxPages; page++) {
      const ms = Math.min(7000, until - Date.now() - 1500);
      if (ms < 1000) { stats.failed.push(`${networks[0]}+: out of time on page ${page}`); return; }
      const r = await postJson(url, { addresses: [{ address, networks }], withMetadata: true, withPrices: true, includeNativeTokens: false, includeErc20Tokens: true, ...(pageKey && { pageKey }) }, ms);
      stats.calls++;
      for (const e of r.error?.partialErrors || []) stats.failed.push(`${e.network}: ${String(e.message).slice(0, 60)}`);
      for (const t of r.data?.tokens || []) {
        stats.rows++;
        const id = ALCHEMY_PORTFOLIO[t.network], m = t.tokenMetadata || {};
        if (!id || !t.tokenAddress || m.decimals == null || !/^0x0*[1-9a-f]/i.test(t.tokenBalance || "0x0")) continue; // native, zero, or no metadata
        const p = (t.tokenPrices || []).find((x) => x.currency === "usd");
        if (!p && SPAMMY.test(`${m.symbol || ""} ${m.name || ""}`)) { stats.spam++; continue; } // a price keeps ether.fi & co
        const age = p ? Date.now() - Date.parse(p.lastUpdatedAt) : null;
        addToken(tokens, id, {
          token: t.tokenAddress, symbol: m.symbol, decimals: m.decimals, raw: BigInt(t.tokenBalance).toString(),
          explorer_price: null, alchemy_price: p && age < 72 * HOUR ? Number(p.value) : null, alchemy_price_age_h: age == null ? null : Math.round(age / HOUR), source: "alchemy",
        });
        stats.kept++;
      }
      pageKey = r.data?.pageKey;
      if (!pageKey) return;
    }
    stats.failed.push(`${networks[0]}+: stopped after ${maxPages} pages`);
  }));
  return stats;
}
