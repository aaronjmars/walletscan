// soldefi.test.mjs - live Solana DeFi positions (sol.defi, forgotten/soldefi.mjs): Kamino, MarginFi, Save, Orca,
// Raydium CLMM, Meteora DLMM + DAMM v2, replayed on real Helius, Kamino, Meteora and Jupiter answers captured
// 2026-10-22 (test/fixtures/soldefi-*.json). Orca and Raydium fees were checked the same day against a simulated
// update_fees_and_rewards (Orca) and decrease_liquidity_v2 with 0 liquidity (Raydium): equal to the raw unit
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { FORGOTTEN } from "../forgotten/index.mjs";
import { REGISTRY } from "../apis.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const sha = (b) => createHash("sha1").update(JSON.stringify(b)).digest("hex");
// a recorded call is matched by route id + params + body sha
const replay = (name) => {
  const k = (id, p, sh) => `${id}|${JSON.stringify(p || {})}|${sh || ""}`;
  const m = new Map(fx(name).map((r) => [k(r.id, r.params, r.body_sha), r]));
  return {
    live: () => true, local: () => [],
    call: async (id, p, over = {}) => { const r = m.get(k(id, p, over.body == null ? "" : sha(over.body))); if (!r) throw { error: `no fixture for ${id}` }; return { status: r.status, ok: r.status >= 200 && r.status < 300 && !r.data?.error, data: r.data }; },
  };
};
const run = (name, address) => FORGOTTEN.solDefi({ address }, replay(name));
const by = (d, p) => d.items.filter((i) => i.protocol === p);

test("sol.defi Kamino: lending, multiply, liquidity and earn vaults, KMNO staking are holdings; pending farm rewards are findings", async () => {
  const d = await run("soldefi-kamino", "2urPgrX1EheTHmE53rChpc4UeZvxKLM7B8rPy1njDBjq");
  assert.deepEqual(d.errors, []);
  const lend = by(d, "Kamino Lend");
  assert.ok(lend.some((i) => i.kind === "loan" && i.usd < 0 && /Multiply loan/.test(i.detail)));
  assert.ok(lend.some((i) => i.kind === "deposit" && i.asset === "JLP" && /Multiply deposit/.test(i.detail)));
  const earn = by(d, "Kamino Earn");
  assert.equal(earn.length, 3);
  assert.ok(earn.every((i) => i.receipt && i.mint && i.token === "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")); // share mint from the vault account
  const liq = by(d, "Kamino Liquidity")[0];
  assert.equal(liq.kind, "position");
  assert.equal(liq.legs.length, 2);
  assert.equal(by(d, "Kamino").find((i) => i.kind === "staked").asset, "KMNO");
  const rewards = d.items.filter((i) => i.category === "reward" && i.protocol === "Kamino");
  const usdc = rewards.find((i) => i.asset === "USDC");
  assert.ok(usdc.amount > 20 && usdc.usd > 20, `usdc ${usdc.amount}`);
  assert.match(usdc.detail, /pending rewards of 6 Kamino farms/);
  assert.equal(usdc.how_to_claim, "https://kamino.com/portfolio");
  const fs = F.solDefiFindings(d), hs = F.solDefiHoldings(d);
  assert.equal(fs.find((f) => f.asset === "USDC" && f.protocol === "Kamino").confidence, "high");
  assert.equal(fs.find((f) => f.asset === "nOPAL").confidence, "low"); // Jupiter does not verify it: no price
  assert.ok(fs.every((f) => f.source === "sol.defi" && f.chain === "solana"));
  assert.ok(hs.every((h) => h.source === "sol.defi" && h.chain === "solana" && Math.abs(h.usd) >= 1));
  // the same wallet has Meteora DLMM pools: a verified pair's fees are medium, an unverified pair's are a low hint
  const vine = fs.filter((f) => f.protocol === "Meteora DLMM" && f.asset === "VINE-SOL fees");
  assert.equal(vine.length, 2);
  assert.ok(vine.every((f) => f.confidence === "medium" && f.usd > 100));
  assert.equal(fs.find((f) => f.asset === "Willy-SOL fees").confidence, "low");
  assert.equal(hs.find((h) => h.asset.startsWith("Willy-SOL LP")).verified, false);
});

test("sol.defi MarginFi: a paused bank's deposits are findings the team must release, not claimable now", async () => {
  const d = await run("soldefi-marginfi", "61UMyVBuFfpwgo7d2NV5qZyxsfk4Aggg5yfd1DVhUD5j");
  assert.deepEqual(d.errors, []);
  const rows = by(d, "MarginFi");
  assert.equal(rows.length, 2);
  assert.ok(rows.every((i) => i.category === "unstake_ready" && i.status === "paused" && i.asset === "USDC"));
  assert.equal(rows.find((i) => i.bank === "9yNnhJ8c1vGbu3DMf6eeeUi6TDJ2ddGgaRA88rL2R3rP").amount, 9117.50189);
  const fs = F.solDefiFindings(d);
  assert.ok(fs.every((f) => f.confidence === "medium" && F.bucketOf(f) === "team_must_release"));
  const t = F.summarize(fs, []).totals;
  assert.equal(t.claimable_usd, 0);
  assert.ok(t.by_bucket.team_must_release.usd > 16000);
});

test("sol.defi Kamino + MarginFi: deposits and loans of an operational bank are holdings, loans negative", async () => {
  const d = await run("soldefi-mixed", "6SBqrHdDnSeZwQ58xP2WCihBNNzyJdfkVVUxP2sdhBhd");
  assert.deepEqual(d.errors, []);
  const m = by(d, "MarginFi");
  const sol = m.find((i) => i.kind === "deposit");
  assert.equal(sol.asset, "SOL");
  assert.equal(sol.amount, 40.970544929); // asset shares x the bank's asset share value
  const loan = m.find((i) => i.kind === "loan");
  assert.equal(loan.asset, "mSOL");
  assert.ok(loan.usd < -1000);
  const hs = F.solDefiHoldings(d);
  const t = F.summarize([], hs).totals;
  assert.ok(t.debt_usd < -1200 && t.holdings_usd > 6000, JSON.stringify(t));
});

test("sol.defi: with Jupiter rate limited, mints are priced on DefiLlama (recorded with Jupiter answering 429)", async () => {
  const d = await run("soldefi-mixed-nojup", "6SBqrHdDnSeZwQ58xP2WCihBNNzyJdfkVVUxP2sdhBhd");
  assert.deepEqual(d.errors, []);
  const sol = by(d, "MarginFi").find((i) => i.kind === "deposit");
  assert.ok(sol.usd > 3000 && sol.verified, `usd ${sol.usd}`);
});

test("sol.defi Orca: position NFTs in the wallet give the principal (holding) and uncollected fees (findings, exact)", async () => {
  const d = await run("soldefi-orca", "NXqR9fn56jaGwzSDKDo2rp7w58LQgm1vDe5ckKt2FSL");
  assert.deepEqual(d.errors, []);
  const pos = by(d, "Orca").filter((i) => i.kind === "position");
  assert.equal(pos.length, 7);
  assert.ok(new Set(pos.map((p) => p.asset)).size === pos.length); // one row per position: never merged as twins
  const usdc = pos.find((p) => p.asset === "SOL-USDC LP BapW");
  assert.equal(usdc.legs[1].asset, "USDC");
  // fees of position BapWd8...: a simulated update_fees_and_rewards right after the recording gave 26533790 raw SOL and 2766575 raw USDC
  const fee = by(d, "Orca").find((i) => i.category === "reward" && i.position === "BapWd8CJPDT7g9Ao6ByZFgEHXkYUTH7249cipRhsZhko" && i.asset === "USDC");
  assert.equal(fee.amount, 2.766575);
  assert.equal(by(d, "Orca").find((i) => i.category === "reward" && i.position === fee.position && i.asset === "SOL").amount, 0.02653379);
  assert.match(fee.detail, /fee growth since the last collect x liquidity/);
  const out = pos.filter((p) => p.in_range === false);
  assert.ok(out.length >= 3 && out.every((p) => /out of range/.test(p.detail)));
  const fs = F.solDefiFindings(d);
  assert.ok(fs.filter((f) => f.protocol === "Orca").every((f) => f.confidence === "high" && f.category === "reward"));
});

test("sol.defi Orca: positions whose tick arrays are DynamicTickArray accounts read the same way (no fees, like the simulation)", async () => {
  const name = "soldefi-orca-dynamic";
  const dyn = createHash("sha256").update("account:DynamicTickArray").digest().subarray(0, 8).toString("hex");
  const arrays = fx(name).filter((r) => r.id === "sol.accounts").flatMap((r) => r.data.result.value || []).filter((a) => a?.data?.[0] && Buffer.from(a.data[0], "base64").subarray(0, 8).toString("hex") === dyn);
  assert.equal(arrays.length, 2); // the two positions share their range-end arrays
  const d = await run(name, "7ZHBQEQb4YjzQ8JxwD86c9tcyzGCQSfKdbWPFN7entAU");
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.items.map((i) => i.kind || i.category), ["position", "position"]); // update_fees_and_rewards simulated: 0 owed on both
  assert.ok(d.items.every((i) => i.protocol === "Orca" && i.in_range === false));
});

test("sol.defi Raydium CLMM: fees and RAY rewards match a simulated decrease_liquidity_v2 to the raw unit", async () => {
  const d = await run("soldefi-raydium", "J7FtNip63FZ5yJhUgjr7XzQmnZd19MhESZ5YWfp1dEDn");
  assert.deepEqual(d.errors, []);
  const r = by(d, "Raydium CLMM");
  const amt = (a) => r.find((i) => i.category === "reward" && i.asset === a).amount;
  assert.equal(amt("SOL"), 0.254719611); // simulated fee_amount_0 254719611
  assert.equal(amt("USDC"), 38.765418); // fee_amount_1 38765418
  assert.equal(amt("RAY"), 0.600396); // reward_amounts[0] 600396
  assert.match(r.find((i) => i.asset === "RAY").detail, /liquidity rewards/);
  const pos = r.find((i) => i.kind === "position");
  assert.equal(pos.in_range, false);
  assert.equal(pos.legs[1].amount, 0); // out of range above: all SOL
  const fs = F.solDefiFindings(d);
  assert.ok(fs.reduce((t, f) => t + f.usd, 0) > 60);
});

test("sol.defi Save: obligations valued from the reserves (cToken rate, borrow rate growth)", async () => {
  const d = await run("soldefi-save", "Cm6XVosKjtpR5s7ktiyD74KRoo7QDEx4JaHMiG4aBQX6");
  assert.deepEqual(d.errors, []);
  const s = by(d, "Save");
  assert.deepEqual(s.map((i) => `${i.kind}:${i.asset}`), ["deposit:JitoSOL", "deposit:USDC", "deposit:JupSOL", "loan:USDC", "loan:SOL"]);
  assert.equal(s.find((i) => i.asset === "JupSOL").amount, 13.801815062);
  assert.equal(s.find((i) => i.kind === "loan" && i.asset === "SOL").amount, 10.15992239);
  assert.ok(s.every((i) => i.obligation === "AWvr6NJgDg8g4Rz9XRCeYQZXN7LurqhSHwtDGHBJ2whe"));
});

test("sol.defi Meteora: DLMM fees in USD (medium), DAMM v2 locked liquidity is a locked holding", async () => {
  const d = await run("soldefi-dlmm", "9bqb9nwj2QL7TovMxBdiw2VQSYHm269GfJBQFmKSGhqD");
  assert.deepEqual(d.errors, []);
  const [pos, fee] = by(d, "Meteora DLMM");
  assert.equal(pos.kind, "position");
  assert.equal(fee.usd, 10.28);
  assert.equal(F.solDefiFindings(d)[0].confidence, "medium");
  const m = await run("soldefi-damm", "Dc85YcHkAWs62ndssWcGN5V4xYaQzPzgUDiRGtvnZas6");
  assert.deepEqual(m.errors, []);
  const locked = by(m, "Meteora DAMM v2").find((i) => i.position === "81zmCSTUYS1sGMTzMLfMQxM671ApcdpFoLN6WERzZZGV");
  assert.equal(locked.kind, "locked");
  assert.equal(locked.verified, false); // tOpenAI / TFBASE: Jupiter does not verify them
  const split = by(m, "Meteora DAMM v2").filter((i) => i.position === "FhQgXHJG196KFQQB9YPXHSuvFnfWvC5XYfygRFcHNRxd" && i.kind);
  assert.deepEqual(split.map((i) => i.kind).sort(), ["locked", "position"]); // 99% unlocked + 1% locked
  const t = F.summarize([], F.solDefiHoldings(m)).totals;
  assert.ok(t.locked_usd > 0 && t.holdings_usd < t.locked_usd + t.unverified_holdings_usd);
});

test("sol.defi: a wallet with none of these has no row; a failed upstream lands in errors[], the rest answers", async () => {
  const d = await run("soldefi-empty", "FdtiepBtP98oU2uPNgAzUoGwggUDdRXwJH2KJo3oUaix");
  assert.deepEqual(d, { items: [], errors: [], coverage: { status: "complete", checked: 0, total: 0, bundles: 0 } });
  await assert.rejects(FORGOTTEN.solDefi({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("soldefi-empty")), (e) => e.status === 400);
  const ctx = replay("soldefi-raydium");
  const call = ctx.call;
  ctx.call = (id, p, o) => (id === "sol.kamino_portfolio" ? Promise.resolve({ status: 503, ok: false, data: {} }) : call(id, p, o));
  const e = await FORGOTTEN.solDefi({ address: "J7FtNip63FZ5yJhUgjr7XzQmnZd19MhESZ5YWfp1dEDn" }, ctx);
  assert.deepEqual(e.errors, ["kamino: step sol.kamino_portfolio failed (upstream 503)"]);
  assert.ok(e.items.some((i) => i.protocol === "Raydium CLMM"));
});

test("sol.defi normalizers: thin market and no price make a finding low; dust and unpriced holdings are dropped", () => {
  const data = { items: [
    { category: "reward", protocol: "Orca", asset: "MEME", token: "m1", amount: 10, usd: 50, liquidity: 60, action: "collect", how_to_claim: "x", detail: "d" },
    { category: "reward", protocol: "Orca", asset: "SPAM", token: "m2", amount: 10, usd: null, liquidity: null, action: "collect", how_to_claim: "x", detail: "d" },
    { category: "reward", protocol: "Kamino", asset: "USDC", token: "m3", amount: 5, usd: 5, liquidity: 1e8, action: "claim", how_to_claim: "x", detail: "d" },
    { kind: "deposit", protocol: "MarginFi", asset: "X", amount: 1, usd: null, verified: false, detail: "d" },
    { kind: "deposit", protocol: "MarginFi", asset: "Y", amount: 1, usd: 0.4, verified: true, detail: "d" },
    { kind: "loan", protocol: "Save", asset: "SOL", amount: 1, usd: -100, verified: true, detail: "d" },
  ] };
  const fs = F.solDefiFindings(data);
  assert.deepEqual(fs.map((f) => f.confidence), ["low", "low", "high"]);
  assert.match(fs[0].detail, /thin market/);
  assert.match(fs[1].detail, /no trusted price/);
  const hs = F.solDefiHoldings(data);
  assert.deepEqual(hs.map((h) => `${h.kind}:${h.asset}:${h.usd}`), ["loan:SOL:-100"]);
});

test("sol.defi: a Kamino vault share token in the wallet is dropped from the plain token holdings", () => {
  const run = { findings: [], holdings: [
    { kind: "position", chain: "solana", asset: "SOL-JitoSOL kVault", mint: "Dk2X", receipt: true, usd: 700, verified: true, source: "sol.defi" },
    { kind: "token", chain: "solana", asset: "kSOLJitoSOL", mint: "Dk2X", usd: 700, verified: true },
    { kind: "staked", chain: "solana", asset: "KMNO", mint: "KMNo", usd: 70, verified: true, source: "sol.defi" },
    { kind: "token", chain: "solana", asset: "KMNO", mint: "KMNo", usd: 10, verified: true },
  ] };
  const out = F.dropSolDefiTwins(run);
  assert.deepEqual(out.holdings.map((h) => h.asset), ["SOL-JitoSOL kVault", "KMNO", "KMNO"]); // KMNO in the wallet is not the staked KMNO
});

test("sol.defi routes: registered with their uses, the compose route is in scan.sol", () => {
  const ids = new Set(REGISTRY.map((e) => e.id));
  const defi = REGISTRY.find((e) => e.id === "sol.defi");
  assert.equal(defi.compose, "solDefi");
  assert.ok(defi.uses.every((u) => ids.has(u)), defi.uses.join());
  for (const id of ["sol.kamino_portfolio", "sol.kamino_rewards", "sol.kamino_vault", "sol.meteora_dlmm", "sol.meteora_damm_v2"]) assert.equal(REGISTRY.find((e) => e.id === id).auth, null, id);
  for (const id of ["sol.marginfi_accounts", "sol.save_obligations"]) assert.equal(REGISTRY.find((e) => e.id === id).auth, "HELIUS_API_KEY", id);
  assert.match(readFileSync(new URL("../compose.mjs", import.meta.url), "utf8"), /id: "sol\.defi", run:/);
});
