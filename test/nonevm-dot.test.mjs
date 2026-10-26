// nonevm-dot.test.mjs - Polkadot / Kusama sources (nonevm/dot.mjs) replayed on real Asset Hub answers captured
// 2026-10-22 (test/fixtures/nonevm-dot-*), then hfClaims, plus one scan.dot run on replayed source routes
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { COMPOSE } from "../compose.mjs";
import { dotStaking, dotBalances, SCAN, ROUTES } from "../nonevm/dot.mjs";
import { twox128, twox64Concat, decodeLedger } from "../nonevm/dot-scale.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const sha = (b) => createHash("sha1").update(JSON.stringify(b)).digest("hex");
// a recorded call is matched by route id + params + body sha
const replay = (name) => {
  const k = (id, p, sh) => `${id}|${JSON.stringify(p || {})}|${sh || ""}`;
  const m = new Map(fx(name).map((r) => [k(r.id, r.params, r.body_sha), r]));
  const st = { calls: 0 };
  return {
    st, live: () => true, local: () => [],
    call: async (id, p, over = {}) => { st.calls++; const r = m.get(k(id, p, over.body == null ? "" : sha(over.body))); if (!r) throw { error: `no fixture for ${id}` }; return { status: r.status, ok: r.status >= 200 && r.status < 300 && !r.data?.error, data: r.data }; },
  };
};

test("dot-scale: twox128 prefixes and Twox64Concat match the runtime's keys", () => {
  assert.equal(twox128("System"), "26aa394eea5630e07c48ae0c9558cef7");
  assert.equal(twox128("Staking"), "5f3e4907f716ac89b6347d15ececedca");
  assert.match(twox64Concat("0x00000000"), /^[0-9a-f]{16}00000000$/); // the real hashes are proven by the replayed reads below
  const l = decodeLedger("0x" + "11".repeat(32) + "0b00407a10f35a" + "0b00407a10f35a" + "04" + "0b00407a10f35a" + "0d0c");
  assert.equal(l.unlocking.length, 1);
  assert.equal(l.unlocking[0].era, 771);
});

test("dot staking: an unbonded chunk never withdrawn is a high unstake_ready DOT row", async () => {
  const d = await dotStaking({ address: "15yiZ3kjLHbM4ffUy9AP9snzVMtQi9hmoJih6QL8otCZ3hFZ" }, replay("nonevm-dot-staking-ledger"));
  assert.deepEqual(d.errors, []);
  const [f] = F.hfClaims(d, { source: "dot.staking" });
  assert.equal(f.category, "unstake_ready");
  assert.equal(f.chain, "polkadot");
  assert.equal(f.asset, "DOT");
  assert.equal(f.amount, 160192.253607);
  assert.equal(f.confidence, "high");
  assert.ok(f.usd > 50000, `usd ${f.usd}`);
  assert.match(f.action, /staking\.withdrawUnbonded on Polkadot Asset Hub/);
  assert.equal(f.how_to_claim, "https://staking.polkadot.cloud");
  assert.match(f.detail, /unlock era 769, active era 2331/);
  assert.equal(F.bucketOf(f), "you_can_claim");
});

test("dot staking: a ready nomination pool unbond is converted from points and named by pool", async () => {
  const d = await dotStaking({ address: "16bVRopp1ZMZY2aXzU4Wo8s4mPkXUdGnxrvTyqkMeSVaKAQz" }, replay("nonevm-dot-staking-pool"));
  const [f] = F.hfClaims(d, { source: "dot.staking" });
  assert.equal(f.protocol, "Polkadot nomination pool 19");
  assert.equal(f.amount, 33216.966647);
  assert.equal(f.confidence, "high");
  assert.match(f.action, /nominationPools\.withdrawUnbonded/);
  assert.doesNotMatch(f.detail, /1:1/); // SubPoolsStorage answered
});

test("dot staking: a stash with a separate controller reads the controller's ledger and says who signs", async () => {
  const d = await dotStaking({ address: "13uao54DTGFCdsAi37bBSTzJPbuDXTsCS69yPnXFuVHiEeAh" }, replay("nonevm-dot-staking-controller"));
  const [f] = F.hfClaims(d, { source: "dot.staking" });
  assert.equal(f.amount, 16929);
  assert.match(f.action, /signed by the controller account/);
  assert.deepEqual(d.holdings.map((h) => `${h.kind}:${h.amount}`), ["staked:49.933"]);
});

test("dot staking: bonded stake is a staked holding next to the ready chunk; a chunk still unbonding is locked", async () => {
  const mixed = await dotStaking({ address: "149WxA5MegHNCHtDzfAGJAqbVeMuN31Vts3HBX6jF96LfHLC" }, replay("nonevm-dot-staking-mixed"));
  assert.equal(mixed.items[0].amount, 23761);
  assert.deepEqual(mixed.holdings.map((h) => `${h.kind}:${h.amount}`), ["staked:4372"]);
  const wait = await dotStaking({ address: "1ftAoZBjwNsW5gne2HFncNk3Co8EzMT6hp8TiYZEbyUsLYY" }, replay("nonevm-dot-staking-waiting"));
  assert.deepEqual(wait.items, []);
  assert.deepEqual(wait.holdings.map((h) => `${h.kind}:${h.amount}`), ["staked:14000", "locked:674.819281"]);
  assert.match(wait.holdings[1].detail, /unbonding until era 2333 \(active era 2331\)/);
});

test("dot staking: Kusama ledgers and pools give KSM rows", async () => {
  const l = F.hfClaims(await dotStaking({ address: "GYg6bmsWQRGiGicpq4NP5FYNwH5j3HwUPwkgvU3SYwTRJSH" }, replay("nonevm-dot-staking-kusama")), { source: "dot.staking" });
  assert.deepEqual(l.map((f) => `${f.chain}:${f.asset}:${f.amount}:${f.confidence}`), ["kusama:KSM:17722.996991:high"]);
  const pd = await dotStaking({ address: "DQXxLNEQ5sXAWJMZQXnK7hdJkHfEcpMLP8KSuteCoaLeAPT" }, replay("nonevm-dot-staking-kusama-pool"));
  const [p] = F.hfClaims(pd, { source: "dot.staking" });
  assert.equal(p.protocol, "Kusama nomination pool 82");
  assert.equal(p.amount, 626.61905);
  assert.deepEqual(pd.holdings.map((h) => `${h.kind}:${h.chain}:${h.amount}`), ["staked:kusama:79.001667"]);
});

test("dot staking: an account with no stake reads both networks once each and has no row, whatever prefix was pasted", async () => {
  for (const a of ["13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB", "F3opxRbN5ZbjJNU511Kj2TLuzFcDq9BGduA9TgiECafpg29"]) {
    const ctx = replay("nonevm-dot-staking-empty");
    assert.deepEqual(await dotStaking({ address: a }, ctx), { items: [], holdings: [], errors: [] });
    assert.equal(ctx.st.calls, 2);
  }
});

test("dot balances: transferable DOT is a holding; Kusama Asset Hub USDT is a team-gated row without a price", async () => {
  const b = await dotBalances({ address: "15yiZ3kjLHbM4ffUy9AP9snzVMtQi9hmoJih6QL8otCZ3hFZ" }, replay("nonevm-dot-balances"));
  assert.deepEqual(b.items, []);
  assert.deepEqual(b.holdings.map((h) => `${h.kind}:${h.chain}:${h.asset}:${h.amount}:${h.verified}`), ["token:polkadot:DOT:74422.4091:true"]);
  const u = await dotBalances({ address: "ED53MNSH3LQSScnT9SXzwKZg2weC8yds5X5G97Yvk3M5jFX" }, replay("nonevm-dot-balances-usdt"));
  const [f] = F.hfClaims(u, { source: "dot.balances" });
  assert.equal(f.category, "token_migration");
  assert.equal(f.asset, "USDT");
  assert.equal(f.amount, 42895.081218);
  assert.equal(f.usd, null);
  assert.equal(f.confidence, "medium");
  assert.equal(F.bucketOf(f), "team_must_release");
  assert.match(f.detail, /face value 42895\.08 USD/);
  assert.deepEqual(u.holdings.map((h) => `${h.chain}:${h.asset}`), ["kusama:KSM"]);
});

test("dot sources: a non-SS58 address is a 400 before any call", async () => {
  for (const fn of [dotStaking, dotBalances]) {
    const ctx = replay("nonevm-dot-staking-empty");
    await assert.rejects(fn({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, ctx), (e) => e.status === 400);
    assert.equal(ctx.st.calls, 0);
  }
});

test("scan.dot: the sources run as one scan with the scan.all answer shape", async () => {
  assert.equal(SCAN.id, "scan.dot");
  assert.deepEqual(SCAN.sources, ROUTES.map((r) => r.id));
  const d = await COMPOSE.scanDot({ address: "15yiZ3kjLHbM4ffUy9AP9snzVMtQi9hmoJih6QL8otCZ3hFZ" }, replay("nonevm-dot-scan"));
  assert.equal(d.kind, "polkadot");
  assert.equal(d.partial, false);
  assert.deepEqual(d.sources, { "dot.staking": "ok", "dot.balances": "ok" });
  assert.equal(d.findings.length, 1);
  assert.equal(d.findings[0].source, "dot.staking");
  assert.equal(d.totals.claimable_usd, d.findings[0].usd);
  assert.ok(d.totals.holdings_usd > 0);
  assert.match(d.account, /^0x[0-9a-f]{64}$/);
  await assert.rejects(COMPOSE.scanDot({ address: "TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G" }, replay("nonevm-dot-scan")), (e) => e.status === 400);
});
