// forgotten/soldefi-findings.mjs - normalizers for sol.defi (forgotten/soldefi.mjs), re-exported by findings.mjs. Pure:
// raw compose answer in, findings / holdings out. A row with `category` is money to collect (a finding), a row with
// `kind` a live position (a holding).
import { thinMarket } from "../findings.mjs";

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// findings: high when the reader says it is claimable now with a trusted price (Kamino farm rewards, Orca / Raydium
// fees and rewards from the pool's own accounts, a reduce-only MarginFi deposit with no loan); medium when the amount is
// an indexer's read (Meteora) or an estimate (MarginFi emissions as of the last update); low = no trusted price (a
// token Jupiter does not verify) or a thin market (Jupiter liquidity under twice the row's value)
export function solDefiFindings(data) {
  return (data?.items || []).filter((i) => i.category && num(i.amount) > 0).map((i) => {
    const usd = num(i.usd), thin = usd != null && thinMarket(i.liquidity, usd);
    const confidence = usd == null || thin ? "low" : i.confidence || "high";
    return {
      category: i.category, chain: "solana", asset: i.asset, ...(i.token && { token: i.token }), amount: num(i.amount), usd, protocol: i.protocol,
      action: i.action, how_to_claim: i.how_to_claim, deadline: i.deadline || null, confidence, source: "sol.defi",
      detail: [i.detail, usd == null && "no trusted price: likely a spam or untradeable token", thin && `thin market (about $${Math.round(i.liquidity)} liquidity): this price cannot be sold into`].filter(Boolean).join("; "),
    };
  });
}

// holdings: deposits, LP positions, staked KMNO, locked liquidity and loans (usd negative); a position whose value
// has no trusted price for every token stays unverified (out of holdings_usd), an unpriced one is left out
export function solDefiHoldings(data, { minUsd = 1 } = {}) {
  return (data?.items || []).filter((i) => i.kind && num(i.usd) != null && Math.abs(num(i.usd)) >= minUsd).map((i) => ({
    kind: i.kind, chain: "solana", asset: i.asset, amount: round(num(i.amount), 6), usd: round(num(i.usd)), protocol: i.protocol,
    ...(i.mint && { mint: i.mint }), ...(i.receipt && { receipt: true }), ...(i.legs && { legs: i.legs }),
    verified: !!i.verified, source: "sol.defi", detail: i.detail,
  }));
}

// a Kamino vault share token (kVault liquidity shares, Earn vault shares) held in the wallet is the same money as its
// sol.defi position: the plain token row of that mint goes
export function dropSolDefiTwins(run) {
  const mints = new Set(run.holdings.filter((h) => h.source === "sol.defi" && h.receipt && h.mint).map((h) => h.mint));
  if (!mints.size) return run;
  return { ...run, holdings: run.holdings.filter((h) => !(h.source == null && h.chain === "solana" && h.kind === "token" && mints.has(h.mint))) };
}
