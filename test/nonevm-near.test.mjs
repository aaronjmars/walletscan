// nonevm-near.test.mjs - NEAR staking pools and lockups (nonevm/near.mjs): compose functions replayed on real answers
// captured 2026-10-22 (test/fixtures/nonevm-near-*, validators answers cut to the account ids), then hfClaims, and
// scan.near on replayed source routes
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { COMPOSE as NEAR, lockupOf, ROUTES, SCAN } from "../nonevm/near.mjs";
import { COMPOSE } from "../compose.mjs";

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
const sum = (xs) => xs.reduce((t, x) => t + x.amount, 0);

// ---- near.staking ----
test("near staking: unstaked NEAR past its wait in two pools are high unstake_ready rows (withdraw_all)", async () => {
  const d = await NEAR.nearStaking({ address: "35bdd7062b7c60f8a5dad756943a42b0f52b43e79ac0a04faf79bc38b0366a82" }, replay("nonevm-near-ready"));
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.pools, ["ledgerbyfigment.poolv1.near", "astro-stakers.poolv1.near"]);
  const out = F.hfClaims(d, { source: "near.staking" });
  assert.equal(out.length, 2);
  for (const f of out) {
    assert.equal(f.category, "unstake_ready");
    assert.equal(f.chain, "near");
    assert.equal(f.asset, "NEAR");
    assert.equal(f.confidence, "high");
    assert.match(f.action, /call withdraw_all on \S+\.poolv1\.near/);
    assert.equal(f.how_to_claim, "https://app.mynearwallet.com/staking");
  }
  assert.ok(Math.abs(sum(out) - 25685.7) < 1, `amount ${sum(out)}`);
  assert.ok(out[0].usd > 50000, `usd ${out[0].usd}`);
  assert.deepEqual(d.holdings.map((h) => `${h.kind}:${h.asset}`), ["token:NEAR"]);
});

test("near staking: unstaked NEAR still in its 4-epoch wait is a medium pending row", async () => {
  const d = await NEAR.nearStaking({ address: "1906fc9b56b7e5d05a0868d6d2ee47f405ab4cbc61a24800235e7e4c13caadf4" }, replay("nonevm-near-pending"));
  const [f] = F.hfClaims(d, { source: "near.staking" });
  assert.equal(f.confidence, "medium");
  assert.equal(f.amount, 70.1846);
  assert.match(f.action, /wait for the unstaking to finish \(4 epochs/);
});

test("near staking: stake left in a pool outside the validator set is a medium row to unstake", async () => {
  const d = await NEAR.nearStaking({ address: "liangjianhua.near" }, replay("nonevm-near-inactive"));
  const [f] = F.hfClaims(d, { source: "near.staking" });
  assert.equal(f.protocol, "NEAR staking (dokiacapital.poolv1.near)");
  assert.equal(f.amount, 125.6006);
  assert.equal(f.confidence, "medium");
  assert.match(f.action, /not a validator now, so this stake earns nothing: call unstake_all on dokiacapital\.poolv1\.near/);
  assert.equal(d.holdings.filter((h) => h.kind === "staked").length, 0);
});

test("near staking: stake in an active pool is a holding, not a finding", async () => {
  const d = await NEAR.nearStaking({ address: "root.near" }, replay("nonevm-near-active"));
  assert.deepEqual(d.items, []);
  const st = d.holdings.find((h) => h.kind === "staked");
  assert.equal(st.protocol, "NEAR staking (shitzu.pool.near)");
  assert.ok(st.amount > 5000 && st.verified);
  assert.ok(d.holdings.find((h) => h.kind === "token").amount > 1000);
});

test("near staking: an account with no pools and no balance has no rows; a bad address is a 400", async () => {
  const d = await NEAR.nearStaking({ address: "nobody-here-wallet-scanner-test.near" }, replay("nonevm-near-empty"));
  assert.deepEqual({ items: d.items, holdings: d.holdings, errors: d.errors }, { items: [], holdings: [], errors: [] });
  for (const a of ["vitalik.eth", "hello", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", ""]) {
    await assert.rejects(NEAR.nearStaking({ address: a }, replay("nonevm-near-empty")), (e) => e.status === 400);
    await assert.rejects(NEAR.nearLockup({ address: a }, replay("nonevm-near-empty")), (e) => e.status === 400);
  }
});

// ---- near.lockup ----
test("near lockup: the lockup id is sha256(owner) cut to 20 bytes + .lockup.near", () => {
  assert.equal(lockupOf("rimrim.near"), "7b21ed994e0f46d28700024b914ce67a3a29131b.lockup.near");
  assert.equal(lockupOf("themoon.near"), "b2297dad72252db841d1fb655778cc0d78496583.lockup.near");
});

test("near lockup: the lockup's unstaked NEAR past its wait is a high row (withdraw_all_from_staking_pool)", async () => {
  const d = await NEAR.nearLockup({ address: "rimrim.near" }, replay("nonevm-near-lockup-rimrim"));
  assert.equal(d.lockup, "7b21ed994e0f46d28700024b914ce67a3a29131b.lockup.near");
  assert.equal(d.transfers_enabled, true);
  const [f] = F.hfClaims(d, { source: "near.lockup" });
  assert.equal(f.amount, 2965);
  assert.equal(f.confidence, "high");
  assert.match(f.action, /on the lockup 7b21ed99\S+: call withdraw_all_from_staking_pool, then transfer it out/);
});

test("near lockup: a 2020 lockup whose transfers were never enabled is a medium vesting row for all it holds", async () => {
  const d = await NEAR.nearLockup({ address: "themoon.near" }, replay("nonevm-near-lockup-themoon"));
  assert.equal(d.transfers_enabled, false);
  const [f] = F.hfClaims(d, { source: "near.lockup" });
  assert.equal(f.category, "vesting");
  assert.equal(f.confidence, "medium");
  assert.equal(f.amount, 3395.0913); // the pool's unstaked NEAR with rewards, more than get_balance's 3000
  assert.match(f.action, /call check_transfers_vote on the lockup b2297dad\S+ .+withdraw_all_from_staking_pool/);
  // still staked in a pool that stopped validating: unstake first
  const b = F.hfClaims(await NEAR.nearLockup({ address: "bucca.near" }, replay("nonevm-near-lockup-bucca")), { source: "near.lockup" });
  assert.equal(b.length, 1);
  assert.equal(b[0].amount, 12166.315);
  assert.match(b[0].action, /unstake_all from dokiacapital\.poolv1\.near through the lockup/);
  const big = F.hfClaims(await NEAR.nearLockup({ address: "af8fd7c28e133a1fb2080bc5f579d8fa159eed49d873870eb291bea1c1d7940a" }, replay("nonevm-near-lockup-af8fd7c28e13")), { source: "near.lockup" });
  assert.equal(big.length, 1);
  assert.ok(big[0].amount > 80000, `amount ${big[0].amount}`);
});

test("near lockup: unlocked NEAR sitting on the lockup is a high vesting row; its active stake a holding", async () => {
  const d = await NEAR.nearLockup({ address: "4d8013d157eaf3f7e53ae3c3fd8302fcfe6caf49296ccca0742a02726b680097" }, replay("nonevm-near-lockup-4d8013d157ea"));
  const [f] = F.hfClaims(d, { source: "near.lockup" });
  assert.equal(f.category, "vesting");
  assert.equal(f.amount, 65.004);
  assert.equal(f.confidence, "high");
  assert.match(f.action, /transfer the unlocked NEAR out of the lockup c7e9e9ea\S+ to 4d8013d1/);
  const st = d.holdings.find((h) => h.kind === "staked");
  assert.ok(st.amount > 1e6 && /through the lockup/.test(st.detail));
});

test("near lockup: an account with no lockup answers lockup null", async () => {
  const d = await NEAR.nearLockup({ address: "root.near" }, replay("nonevm-near-lockup-root"));
  assert.deepEqual(d, { lockup: null, items: [], holdings: [], errors: [] });
});

// ---- scan.near ----
test("scan.near: the source routes join into the scan.all answer shape", async () => {
  assert.deepEqual(SCAN.sources, ["near.staking", "near.lockup"]);
  for (const id of SCAN.sources) assert.ok(ROUTES.some((r) => r.id === id && r.group === "near" && r.example && r.check));
  const d = await COMPOSE.scanNear({ address: "rimrim.near" }, replay("nonevm-near-scan-rimrim"));
  assert.equal(d.kind, "near");
  assert.equal(d.partial, false);
  assert.deepEqual(d.sources, { "near.staking": "ok", "near.lockup": "ok" });
  assert.equal(d.findings.length, 1);
  assert.equal(d.findings[0].source, "near.lockup");
  assert.equal(d.findings[0].bucket, "you_can_claim");
  assert.ok(d.totals.claimable_usd > 5000, `claimable ${d.totals.claimable_usd}`);
  assert.equal(d.holdings[0].source, "near.staking");
  await assert.rejects(COMPOSE.scanNear({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("nonevm-near-scan-rimrim")), (e) => e.status === 400);
});
