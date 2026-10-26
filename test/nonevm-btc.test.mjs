// nonevm-btc.test.mjs - Bitcoin sources (nonevm/btc.mjs): Omni USDT, Babylon stakes (API + phase-1 from the chain), BTC
// balance, and scan.btc, replayed on real answers captured 2026-10-22 (test/fixtures/nonevm-btc-*)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { COMPOSE } from "../compose.mjs";
import { phase1Stake } from "../nonevm/btc.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const sha = (b) => createHash("sha1").update(JSON.stringify(b)).digest("hex");
const replay = (name) => {
  const k = (id, p, sh) => `${id}|${JSON.stringify(p || {})}|${sh || ""}`;
  const m = new Map(fx(name).map((r) => [k(r.id, r.params, r.body_sha), r]));
  return {
    live: () => true, local: () => [],
    call: async (id, p, over = {}) => { const r = m.get(k(id, p, over.body == null ? "" : sha(over.body))); if (!r) throw { error: `no fixture for ${id} ${JSON.stringify(p)}` }; return { status: r.status, ok: r.status >= 200 && r.status < 300 && !r.data?.error, data: r.data }; },
  };
};
const STAKER = "bc1ptpd8h6hmk60khjr8cg3538zmxsxvpqcvjq0y6gq3y0nwp3pvk05s97lf38";

test("omni usdt: property 31 on the address is a team_must_release token_migration row with no price", async () => {
  const d = await COMPOSE.btcOmniUsdt({ address: "39pTGXmaYu44LGXpjKEztY9SSdmyGdxMgr" }, replay("nonevm-btc-omni"));
  const [f] = F.hfClaims(d, { source: "btc.omni_usdt" });
  assert.equal(f.category, "token_migration");
  assert.equal(f.chain, "bitcoin");
  assert.equal(f.asset, "USDT");
  assert.equal(f.token, "omni:31");
  assert.ok(Math.abs(f.amount - 49.135569) < 1e-6);
  assert.equal(f.usd, null);
  assert.equal(f.confidence, "medium");
  assert.equal(F.bucketOf(f), "team_must_release");
  assert.match(f.detail, /face value \$49\.14/);
  // a token_migration row with a token no holding lists stays in the answer (unpriced), not dropped as a twin
  const s = F.summarize([F.withNet(f, {})], []);
  assert.equal(s.findings.length, 1);
  assert.equal(s.totals.by_bucket.team_must_release.unpriced, 1);
});

test("omni usdt: an address holding only other Omni properties (some named TetherUS) has no row", async () => {
  const d = await COMPOSE.btcOmniUsdt({ address: "1KYiKJEfdJtap9QX2v9BXJMpz2SfU4pgZw" }, replay("nonevm-btc-omni-empty"));
  assert.deepEqual(d.items, []);
});

test("babylon: a TIMELOCK_WITHDRAWABLE delegation and a phase-1 stake never registered are both high unstake_ready rows", async () => {
  const d = await COMPOSE.btcBabylon({ address: STAKER }, replay("nonevm-btc-babylon"));
  assert.deepEqual(d.errors, []);
  const out = F.hfClaims(d, { source: "btc.babylon" });
  assert.equal(out.length, 2);
  const v2 = out.find((f) => f.protocol === "Babylon"), p1 = out.find((f) => f.protocol === "Babylon (phase 1)");
  assert.equal(v2.category, "unstake_ready");
  assert.equal(v2.amount, 0.083);
  assert.equal(v2.confidence, "high");
  assert.equal(v2.how_to_claim, "https://btcstaking.babylonlabs.io");
  assert.match(v2.detail, /ca86351d5d1a42a98ea597d8ecefdffb221db6fbdf8b22d31e682e18581a17e7/);
  assert.equal(p1.amount, 0.03972);
  assert.equal(p1.confidence, "high");
  assert.match(p1.detail, /202fc2f5bdfd2c7bba5f5f7ed420f65708662ff3919967aa5c609b3bf56333b5:0 .* still unspent; its 64000-block timelock ended at block 938096/);
  // the claim cost is the Bitcoin fee estimate, not the flat L2 one
  assert.ok(v2.cost_usd > 0 && v2.cost_usd < 5);
  const n = F.withNet(v2, {});
  assert.equal(n.claim_cost_usd, Math.round(v2.cost_usd * 1e4) / 1e4);
  assert.equal(n.cost_usd, undefined);
});

test("babylon: an address with no stake has no row; a legacy address is skipped without a call; a bad address is a 400", async () => {
  const d = await COMPOSE.btcBabylon({ address: "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr" }, replay("nonevm-btc-babylon-empty"));
  assert.deepEqual(d, { items: [], holdings: [], errors: [] });
  const legacy = await COMPOSE.btcBabylon({ address: "1KYiKJEfdJtap9QX2v9BXJMpz2SfU4pgZw" }, { call: () => assert.fail("no call") });
  assert.match(legacy.status, /^skipped/);
  await assert.rejects(COMPOSE.btcBabylon({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, {}), (e) => e.status === 400);
});

test("babylon phase 1: the staking transaction parser reads the OP_RETURN and finds the staking output", () => {
  const txs = fx("nonevm-btc-babylon").filter((r) => r.id === "btc.address_txs").flatMap((r) => r.data);
  const stakes = txs.map((t) => phase1Stake(t, STAKER)).filter(Boolean);
  const s = stakes.find((x) => x.txid === "202fc2f5bdfd2c7bba5f5f7ed420f65708662ff3919967aa5c609b3bf56333b5");
  assert.equal(s.vout, 0);
  assert.equal(s.value, 3972000);
  assert.equal(s.timelock, 64000);
  assert.equal(s.staker_pk, "39741a6f3e52e718aed94c25cd9bd8d4262f39fd421f6d3313cf2883ba5f3c42");
  // the registered one (v2 API) parses too: scan dedupes it by staking tx hash
  assert.ok(stakes.some((x) => x.txid === "ca86351d5d1a42a98ea597d8ecefdffb221db6fbdf8b22d31e682e18581a17e7"));
  // a transaction not sent by the address is not its stake
  assert.equal(phase1Stake(txs.find((t) => t.txid === s.txid), "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr"), null);
});

test("balance: the address's BTC is a verified holding", async () => {
  const d = await COMPOSE.btcBalance({ address: "1KYiKJEfdJtap9QX2v9BXJMpz2SfU4pgZw" }, replay("nonevm-btc-balance"));
  const [h] = d.holdings;
  assert.equal(h.asset, "BTC");
  assert.ok(Math.abs(h.amount - 11.20888082) < 1e-8);
  assert.ok(h.usd > 100000, `usd ${h.usd}`);
  assert.equal(h.verified, true);
});

test("scan.btc: the normalized answer (totals, findings, holdings, sources) from replayed source routes", async () => {
  const d = await COMPOSE.scanBtc({ address: STAKER }, replay("nonevm-btc-scan"));
  assert.equal(d.kind, "bitcoin");
  assert.equal(d.partial, false);
  assert.deepEqual(d.sources, { "btc.omni_usdt": "ok", "btc.babylon": "ok", "btc.balance": "ok" });
  assert.equal(d.findings.length, 2);
  assert.ok(d.totals.claimable_usd > 1000);
  assert.ok(d.findings.every((f) => f.bucket === "you_can_claim" && f.net_after_fees_usd < f.usd));
  await assert.rejects(COMPOSE.scanBtc({ address: "TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G" }, replay("nonevm-btc-scan")), (e) => e.status === 400);
});
