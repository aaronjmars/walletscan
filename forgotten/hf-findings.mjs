// forgotten/hf-findings.mjs - normalizers for the hiddenfunds-gap sources (Blur Pool, Plasma vault shares, Zora and
// 0xSplits balances, dead DEX LPs, Blast USDB claims, Balancer rescue claims, Agglayer exits, Nucleus vault shares,
// Mooniswap LPs, Karak queue, K2 claims, Polkadot sale claims), re-exported by findings.mjs. Pure: raw compose answer
// in, findings out.
import { sameChain } from "../findings.mjs";
import { SKIPPED_ROUTES } from "./skipped.mjs";

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

// confidence: high only when the contract says it is claimable now (status ready) and every part has a trusted
// price; medium when part of it is unpriced, it waits on a queue, or the price is missing; low = a hint (no
// readable amount or claim state). Priced dust under minUsd is dropped unless a deadline keeps it on show
export function hfClaims(data, { source, minUsd = 1 } = {}) {
  return (data?.items || []).filter((i) => num(i.amount) > 0 && (i.usd == null || num(i.usd) >= minUsd || i.deadline)).map((i) => {
    const legs = (i.legs || []).filter((l) => num(l.amount) > 0);
    const confidence = i.status === "hint" ? "low" : i.status === "ready" && i.usd != null && !(i.unpriced > 0) ? "high" : "medium";
    return {
      // 0x addresses go lowercase; a Solana mint is base58, where case is part of the address
      category: i.category, chain: i.chain, asset: i.asset, ...(i.token && { token: /^0x/i.test(i.token) ? String(i.token).toLowerCase() : String(i.token) }), amount: num(i.amount), usd: i.usd == null ? null : num(i.usd), protocol: i.protocol,
      action: i.deadline && !/before \d{4}-/.test(i.action || "") ? `${i.action} before ${i.deadline}` : i.action, how_to_claim: i.how_to_claim, deadline: i.deadline || null, confidence, source,
      ...(legs.length && { legs: legs.map((l) => ({ token: l.token, asset: l.asset, amount: num(l.amount), usd: num(l.usd) })) }),
      ...(num(i.cost_usd) != null && { cost_usd: num(i.cost_usd) }), // the claim cost when it is not the flat estimate (withNet reads it)
      detail: [i.detail, i.unpriced > 0 && `${i.unpriced} leg${i.unpriced === 1 ? "" : "s"} without a trusted price (left out of usd)`].filter(Boolean).join("; "),
    };
  });
}

// Zerion and the every-chain sweep can list the same money: Zerion as a deposit / staked / reward row of the
// protocol (one row per underlying token for an LP), the sweep as the receipt token. Once one of these sources
// answered, a Zerion row on the same chain whose protocol matches and whose amount matches the finding or one of its
// legs (within 3%) goes, and so does any holding of the very token a receipt finding represents (Blur Pool: the
// wallet holds the pool token; a token_migration row is left to summarize(), which keeps it out of the totals when a
// priced holding has its token). The other sources' token is what the claim pays (USDC, DAI, weETH...), which the
// wallet may hold too: those holdings stay
export const HF_SOURCES = new Set(["rewards.pons", "rewards.blur_pool", "rewards.plasma_vault", "rewards.creator_rewards", "rewards.dead_dexes", "bridge.blast_usdb", "rewards.balancer_rescue", "bridge.agglayer", "rewards.karak_queue", "bridge.k2_claims", "rewards.dot_sale", "rewards.nucleus_vaults", "rewards.mooniswap"]);
for (const id of Object.keys(SKIPPED_ROUTES)) HF_SOURCES.add(id); // the skipped-round sources (forgotten/skipped.mjs) replace Zerion's rows too
const RECEIPT = new Set(["rewards.blur_pool"]);
const TWIN = (f) => String(f.protocol || "").toLowerCase().replace(/^0x/, "").split(/[\s(]/)[0];
export function dropHfTwins(run) {
  const ours = run.findings.filter((f) => HF_SOURCES.has(f.source));
  if (!ours.length) return run;
  const near = (a, b) => a != null && b != null && b !== 0 && Math.abs(a - b) / Math.abs(b) <= 0.03;
  const twinOf = (x) => x.protocol && ours.find((f) => sameChain(x.chain) === sameChain(f.chain) && String(x.protocol).toLowerCase().includes(TWIN(f))
    && (near(x.amount, f.amount) || near(x.usd, f.usd) || (f.legs || []).some((l) => near(x.amount, l.amount))));
  const tokens = new Set(ours.filter((f) => f.token && RECEIPT.has(f.source)).map((f) => `${sameChain(f.chain)}:${f.token}`));
  return {
    ...run,
    holdings: run.holdings.filter((h) => !(h.token && tokens.has(`${sameChain(h.chain)}:${String(h.token).toLowerCase()}`)) && !(!h.source && ["deposit", "staked", "locked", "reward"].includes(h.kind) && twinOf(h))),
    findings: run.findings.filter((f) => !(f.source === "rewards.zerion" && twinOf(f))),
  };
}
