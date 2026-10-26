// batch-h-d.test.mjs - dead Solana apps (rewards.sol_dead_apps, forgotten/soldead.mjs): Sunny vaults, Friktion volts,
// Francium lending, replayed on real Helius + Jupiter answers captured 2026-10-21 (test/fixtures/soldead-*.json)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { FORGOTTEN } from "../forgotten/index.mjs";
import { SOL_DEAD } from "../forgotten/soldead.mjs";
import { findPda, seed } from "../solana.mjs";
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
const ALL = "54hjqySrj2kWEYdFZHx9QQTannnecYK4Cx9uWUWGYoKa", SUNNY = "2gYRGDXVVYvwKtS6C7znjZ6qso2XTDXkZEdkycHDxmfd";
const FRIKTION = "GFpNdXho1pkJFn1xiH3nXKLY5LqUq5T27b9ZY8dKkNRg", FRANCIUM = "5QsSGbvXMSDPTTNWuTviPQStH32mXyDR23TQBwmoE9wG";

test("sol dead apps: one wallet with Sunny vaults, Friktion volt tokens + pending deposits and Francium stakes", async () => {
  const d = await FORGOTTEN.solDeadApps({ address: ALL }, replay("soldead-all"));
  assert.deepEqual(d.errors, []);
  const by = (p) => d.items.filter((i) => i.protocol === p);
  assert.equal(by("Sunny Aggregator").length, 5);
  assert.equal(by("Friktion").length, 8);
  assert.equal(by("Francium").length, 3);
  const jsol = by("Sunny Aggregator").find((i) => i.asset === "JSOL-SOL Saber LP");
  assert.equal(jsol.vault, "DuSi1uHiAqxx7aNNEKd3pEqFMRsKpiwhEnaLtb1MnhqN");
  assert.equal(jsol.amount, 29.22934781);
  assert.equal(jsol.unpriced, 0);
  assert.equal(jsol.usd, jsol.legs[0].usd + jsol.legs[1].usd);
  assert.equal(jsol.how_to_claim, "https://claim.saberdao.so/");
  const usdc = by("Friktion").find((i) => i.asset === "USDC");
  assert.equal(usdc.part, "volt_tokens");
  assert.equal(usdc.category, "token_migration");
  assert.equal(usdc.volt, "2evPXRLaTZj92DM93sdryeszwqoC9C6DoWa1TKHn1AzU");
  assert.equal(usdc.amount, 335.6662);
  assert.match(usdc.how_to_claim, /github\.com\/Friktion-Labs\/sdk\/blob\/master\/examples\/instructions\/withdraw\.ts/);
  const ftt = by("Friktion").find((i) => i.part === "pending_deposit" && i.asset === "FTX Token");
  assert.equal(ftt.category, "unstake_ready");
  assert.match(ftt.action, /claimPendingDeposit/);
  assert.match(ftt.detail, /volt tokens waiting in the round account/);
  const ray = by("Francium").find((i) => i.asset === "RAY");
  assert.equal(ray.part, "staked");
  assert.equal(ray.status, "ready");
  assert.equal(ray.amount, ray.owed); // the pool holds enough to pay it all
  assert.match(ray.action, /unstake the fTokens/);
  const fs = F.hfClaims(d, { source: "rewards.sol_dead_apps" });
  assert.ok(fs.every((f) => f.chain === "solana" && f.source === "rewards.sol_dead_apps"));
  assert.equal(fs.find((f) => f.asset === "JSOL-SOL Saber LP").confidence, "high");
  assert.equal(fs.find((f) => f.asset === "ASoLXb-SOL Saber LP").confidence, "medium"); // one leg without a trusted price
  const total = fs.reduce((t, f) => t + (f.usd ?? 0), 0);
  assert.ok(total > 10000 && total < 25000, `usd ${total}`);
});

test("sol dead apps: big Sunny vaults are valued at the wallet's share of each Saber swap, both legs counted", async () => {
  const d = await FORGOTTEN.solDeadApps({ address: SUNNY }, replay("soldead-sunny"));
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.items.map((i) => i.asset), ["prtSOL-SOL Saber LP", "mSOL-SOL Saber LP"]);
  const [prt, msol] = d.items;
  assert.equal(msol.staked, 2000.975456612);
  assert.equal(msol.swap, "Lee1XZJfJ9Hm2K1qTyeCz1LXNc1YBZaKZszvNY4KCDw");
  assert.equal(msol.token, "SoLEao8wTzSfqhuou8rcYsVoLjthVmiXuEjzdNPMnCz");
  assert.ok(msol.usd > 150000 && msol.usd < 350000, `usd ${msol.usd}`); // lopsided drained pool: both legs still pay
  assert.equal(prt.unpriced, 1); // prtSOL has no trusted price: only the SOL leg counts
  const fs = F.hfClaims(d, { source: "rewards.sol_dead_apps" });
  assert.deepEqual(fs.map((f) => f.confidence), ["medium", "high"]);
  assert.match(fs[0].detail, /1 leg without a trusted price/);
});

test("sol dead apps: Friktion withdrawals of past rounds are the wallet's share of the round's own account", async () => {
  const d = await FORGOTTEN.solDeadApps({ address: FRIKTION }, replay("soldead-friktion"));
  assert.deepEqual(d.errors, []);
  const sol = d.items.find((i) => i.asset === "SOL");
  assert.equal(sol.part, "pending_withdrawal");
  assert.equal(sol.volt, "CbPemKEEe7Y7YgBmYtFaZiECrVTP5sGrYzrrrviSewKY");
  assert.equal(sol.amount, 4401.746116628); // 3829790859989 / 3846101673842 of the 4420.492848281 SOL in the round account
  assert.match(sol.action, /claimPendingWithdrawal/);
  assert.match(sol.detail, /round 31, paid from the round's account 8P1ykqKZEv8dHrsyNpuFDTBoor4QjkW3odgUCXKSzafF/);
  const fs = F.hfClaims(d, { source: "rewards.sol_dead_apps" });
  assert.equal(fs.length, 2);
  assert.ok(fs.every((f) => f.confidence === "high" && f.category === "unstake_ready"));
});

test("sol dead apps: when Jupiter is rate limited, prices fall back to DefiLlama (recorded with Jupiter answering 429)", async () => {
  const d = await FORGOTTEN.solDeadApps({ address: FRIKTION }, replay("soldead-friktion-nojup"));
  assert.deepEqual(d.errors, []);
  const sol = d.items.find((i) => i.token === "So11111111111111111111111111111111111111112");
  assert.equal(sol.amount, 4401.746116628);
  assert.equal(sol.asset, "SOL");
  assert.ok(sol.usd > 200000, `usd ${sol.usd}`);
  assert.ok(F.hfClaims(d, { source: "rewards.sol_dead_apps" }).every((f) => f.confidence === "high"));
});

test("sol dead apps: a Francium pool short of liquidity pays only what it holds (partial, medium); dust is dropped", async () => {
  const d = await FORGOTTEN.solDeadApps({ address: FRANCIUM }, replay("soldead-francium"));
  assert.deepEqual(d.errors, []);
  const usdc = d.items.find((i) => i.asset === "USDC");
  assert.equal(usdc.status, "partial");
  assert.equal(usdc.amount, 224399.278196); // the pool's available liquidity
  assert.ok(usdc.owed > 2.8e6, `owed ${usdc.owed}`);
  assert.match(usdc.detail, /first come, first served/);
  const fs = F.hfClaims(d, { source: "rewards.sol_dead_apps" });
  assert.equal(fs.length, 1); // the USDT dust stake is below min_usd
  assert.equal(fs[0].confidence, "medium");
  assert.equal(fs[0].how_to_claim, "https://www.npmjs.com/package/francium-sdk");
});

test("sol dead apps: a wallet with none of these has no row; a non-Solana address is a 400", async () => {
  const d = await FORGOTTEN.solDeadApps({ address: "FdtiepBtP98oU2uPNgAzUoGwggUDdRXwJH2KJo3oUaix" }, replay("soldead-empty"));
  assert.deepEqual(d, { items: [], errors: [] });
  await assert.rejects(FORGOTTEN.solDeadApps({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("soldead-empty")), (e) => e.status === 400);
});

test("sol dead apps: a failed upstream lands in errors[], the other apps still answer", async () => {
  const ctx = replay("soldead-sunny");
  const call = ctx.call;
  ctx.call = (id, p, o) => (id === "sol.francium_lend_stakes" ? Promise.resolve({ status: 429, ok: false, data: {} }) : call(id, p, o));
  const d = await FORGOTTEN.solDeadApps({ address: SUNNY }, ctx);
  assert.equal(d.items.length, 2);
  assert.deepEqual(d.errors, ["francium: step sol.francium_lend_stakes failed (upstream 429)"]);
});

test("sol dead apps: data file covers every Sunny pool with its Saber swap, every Friktion volt, Francium pools and reward pools", () => {
  assert.equal(SOL_DEAD.sunny.pools.length, 91);
  assert.ok(SOL_DEAD.sunny.pools.every((p) => p.swap && p.a.length === 2 && p.b.length === 2));
  assert.equal(SOL_DEAD.friktion.volts.length, 104);
  const shares = new Set(SOL_DEAD.francium.pools.map((p) => p.share));
  assert.equal(SOL_DEAD.francium.pools.length, 87);
  assert.ok(SOL_DEAD.francium.farms.length > 50 && SOL_DEAD.francium.farms.every((f) => shares.has(f.share)));
});

test("sol dead apps: findings keep the Solana mint's case; a volt-token row is not counted twice when a priced holding has the mint", async () => {
  const d = await FORGOTTEN.solDeadApps({ address: ALL }, replay("soldead-all"));
  const fs = F.hfClaims(d, { source: "rewards.sol_dead_apps" });
  const usdc = fs.find((f) => f.protocol === "Friktion" && f.asset === "USDC");
  assert.ok(SOL_DEAD.friktion.volts.some((v) => v.vault_mint === usdc.token) && usdc.token !== usdc.token.toLowerCase());
  const alone = F.summarize([usdc], []);
  const held = F.summarize([usdc], [{ kind: "token", chain: "solana", asset: "USDC volt", token: usdc.token, amount: 600, usd: 335, verified: true }]);
  assert.equal(alone.totals.claimable_usd, usdc.usd);
  assert.equal(held.totals.claimable_usd, 0); // the balance is already in holdings
});

test("findPda takes raw byte seeds: Friktion's round accounts derive from a u64 LE round number", () => {
  const le = Buffer.alloc(8); le.writeBigUInt64LE(31n);
  assert.equal(findPda(["CbPemKEEe7Y7YgBmYtFaZiECrVTP5sGrYzrrrviSewKY", le, seed("roundUlPending")], "VoLT1mJz1sbnxwq5Fv2SXjdVDgPXrb9tJyC8WpMDkSp").address, "8P1ykqKZEv8dHrsyNpuFDTBoor4QjkW3odgUCXKSzafF");
});

test("sol dead apps: route rows and the scan.sol wiring", () => {
  const ids = new Map(REGISTRY.map((e) => [e.id, e]));
  const r = ids.get("rewards.sol_dead_apps");
  assert.equal(r.compose, "solDeadApps");
  assert.ok(r.uses.every((u) => ids.has(u)));
  assert.equal(r.example.address, ALL);
  for (const id of ["sol.sunny_vaults", "sol.francium_lend_stakes"]) assert.equal(ids.get(id).auth, "HELIUS_API_KEY");
  assert.match(readFileSync(new URL("../compose.mjs", import.meta.url), "utf8"), /id: "rewards\.sol_dead_apps", run: async \(\) => \(\{ findings: F\.hfClaims\(await get\(ctx, "rewards\.sol_dead_apps"/);
});
