// nonevm-sui.test.mjs - Sui sources (nonevm/sui.mjs): Bucket Farm stakes, native stakes with a validator that left the
// set, priced balances, and scan.sui, replayed on real Sui GraphQL + DefiLlama answers captured 2026-10-22
// (test/fixtures/nonevm-sui-*)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { COMPOSE as SUI, SCAN, fullType } from "../nonevm/sui.mjs";
import { COMPOSE } from "../compose.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/nonevm-sui-${name}.json`, import.meta.url), "utf8"));
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
const MULTI = "0x59057410e07217fe199446db5aa6b87c646cfbb50fe3a5fd8c38167b21146b1d";
const EMPTY = "0x1111111111111111111111111111111111111111111111111111111111111111";

// ---- sui.bucket_farm ----
test("bucket farm: a stake in a pool that holds enough is a high unstake_ready row", async () => {
  const d = await SUI.bucketFarm({ address: "0xaea5314c57d52c811441b0ab6cd570d8656f86f8060d0ba0f27eaac27cf038c7" }, replay("farm-buck"));
  const [f] = F.hfClaims(d, { source: "sui.bucket_farm" });
  assert.equal(f.category, "unstake_ready");
  assert.equal(f.chain, "sui");
  assert.equal(f.protocol, "Bucket Farm");
  assert.equal(f.asset, "BUCK");
  assert.equal(f.amount, 809.710236);
  assert.equal(f.confidence, "high");
  assert.ok(f.usd > 790 && f.usd < 830, `usd ${f.usd}`);
  assert.equal(f.how_to_claim, "https://farm.bucketprotocol.io");
  assert.match(f.action, /unstake it on https:\/\/farm\.bucketprotocol\.io/);
  assert.equal(F.bucketOf(f), "you_can_claim");
});

test("bucket farm: a stake bigger than what the pool holds (the rest lent to NAVI) waits on the Bucket team", async () => {
  const d = await SUI.bucketFarm({ address: "0x7797f5950124799e01b37f8fb9a22b5c26f78014b12d9a53612c11abaf2c230c" }, replay("farm-sui"));
  const [f] = F.hfClaims(d, { source: "sui.bucket_farm" });
  assert.equal(f.asset, "SUI");
  assert.equal(f.amount, 1269.781697);
  assert.equal(f.confidence, "medium");
  assert.match(f.action, /the rest is lent to NAVI and waits until the Bucket team acts/);
  assert.match(f.detail, /the pool holds 261\.7404 SUI of its own now/);
  assert.equal(F.bucketOf(f), "team_must_release");
});

test("bucket farm: every pool of a multi-asset staker, priced per coin; an empty wallet has none", async () => {
  const d = await SUI.bucketFarm({ address: MULTI }, replay("farm-multi"));
  assert.deepEqual(d.items.map((i) => i.asset), ["SUI", "haSUI", "mSUI", "sSUI", "BLUE", "TYPUS", "NS"]);
  const out = F.hfClaims(d, { source: "sui.bucket_farm" });
  assert.ok(out.every((f) => f.chain === "sui" && f.usd >= 1));
  assert.equal(out.find((f) => f.asset === "mSUI").amount, 24.798637);
  assert.deepEqual(await SUI.bucketFarm({ address: EMPTY }, replay("farm-empty")), { items: [], holdings: [], errors: [] });
});

// ---- sui.staking ----
test("staking: stakes with a validator that left the set are one high row per pool, named", async () => {
  const d = await SUI.suiStaking({ address: "0x184fbf9d6c2d2d3f27e27fe3ca2d3b4080bd406221e345e2d36633e638e988e1" }, replay("stake-cosmostation"));
  const [f] = F.hfClaims(d, { source: "sui.staking" });
  assert.equal(f.protocol, "Sui staking (Cosmostation)");
  assert.equal(f.amount, 13.656048);
  assert.equal(f.confidence, "high");
  assert.match(f.detail, /left the validator set at epoch 1195/);
  assert.equal(d.holdings.length, 0);
});

test("staking: over 200 stake objects reads 200 and says so (the scan marks the source partial)", async () => {
  const d = await SUI.suiStaking({ address: "0x9cc48fe04bfcd7661caf127909020e9474fc91c1e92531c882e52a40f4710e3f" }, replay("stake-doubleup"));
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].protocol, "Sui staking (DoubleUp)");
  assert.ok(d.items[0].amount > 13000, `amount ${d.items[0].amount}`);
  assert.match(d.errors[0], /only the first 200 were read/);
});

test("staking: stakes with active validators are staked holdings; an empty wallet has none", async () => {
  const d = await SUI.suiStaking({ address: MULTI }, replay("stake-multi"));
  assert.equal(d.items.length, 0);
  assert.equal(d.holdings.length, 3);
  assert.ok(d.holdings.every((h) => h.kind === "staked" && h.asset === "SUI" && h.verified));
  assert.equal(d.holdings.reduce((s, h) => s + h.amount, 0), 4);
  assert.deepEqual(await SUI.suiStaking({ address: EMPTY }, replay("stake-empty")), { items: [], holdings: [], errors: [] });
});

// ---- sui.balances ----
test("balances: only coins with a trusted price, decimals from DefiLlama", async () => {
  const d = await SUI.suiBalances({ address: MULTI }, replay("bal-multi"));
  assert.equal(d.unpriced, 22);
  const usdc = d.holdings.find((h) => h.asset === "USDC");
  assert.equal(usdc.amount, 8.583153);
  assert.ok(d.holdings.every((h) => h.kind === "token" && h.verified && h.usd != null));
  const e = await SUI.suiBalances({ address: EMPTY }, replay("bal-empty"));
  assert.deepEqual(e.holdings.map((h) => h.asset), ["SUI"]);
});

test("a bad address is a 400; coin types are padded to the 64 hex form", async () => {
  for (const fn of Object.values(SUI)) await assert.rejects(fn({ address: "0x12" }, replay("bal-empty")), (e) => e.status === 400);
  await assert.rejects(SUI.suiBalances({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("bal-empty")), (e) => e.status === 400);
  assert.equal(fullType("0x2::sui::SUI"), "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI");
});

// ---- scan.sui ----
test("scan.sui: the three sources in one answer, farm stakes in the totals, stakes and coins as holdings", async () => {
  assert.equal(SCAN.id, "scan.sui");
  const d = await COMPOSE.scanSui({ address: MULTI.toUpperCase().replace("0X", "0x") }, replay("scan-multi"));
  assert.equal(d.kind, "sui");
  assert.equal(d.address, MULTI);
  assert.deepEqual(d.sources, { "sui.bucket_farm": "ok", "sui.staking": "ok", "sui.balances": "ok" });
  assert.equal(d.partial, false);
  assert.ok(d.findings.length >= 6 && d.findings.every((f) => f.source === "sui.bucket_farm"));
  assert.ok(d.totals.claimable_usd > 60, `claimable ${d.totals.claimable_usd}`);
  assert.ok(d.holdings.some((h) => h.kind === "staked" && h.source === "sui.staking"));
  assert.ok(d.holdings.some((h) => h.asset === "USDC" && h.source === "sui.balances"));
  await assert.rejects(COMPOSE.scanSui({ address: "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq" }, replay("scan-multi")), (e) => e.status === 400);
});
