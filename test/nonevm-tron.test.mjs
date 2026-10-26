// nonevm-tron.test.mjs - TRON sources (nonevm/tron.mjs) replayed on real TronGrid + DefiLlama answers captured
// 2026-10-22 (test/fixtures/nonevm-tron-*), then hfClaims, and scan.tron on the replayed source answers
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { COMPOSE as TRON, SCAN, ROUTES, OLD_USDC } from "../nonevm/tron.mjs";
import { COMPOSE } from "../compose.mjs";
import { addressKind } from "../nonevm/address.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const sha = (b) => createHash("sha1").update(JSON.stringify(b)).digest("hex");
// a recorded call is matched by route id + params + body sha
const replay = (name) => {
  const k = (id, p, sh) => `${id}|${JSON.stringify(p || {})}|${sh || ""}`;
  const m = new Map(fx(name).map((r) => [k(r.id, r.params, r.body_sha), r]));
  return {
    live: () => true, local: () => [],
    call: async (id, p, over = {}) => { const r = m.get(k(id, p, over.body == null ? "" : sha(over.body))); if (!r) throw { error: `no fixture for ${id} ${JSON.stringify(p)}` }; return { status: r.status, ok: r.status >= 200 && r.status < 300 && !r.data?.error, data: r.data }; },
  };
};

test("tron routes: group tron, every raw route has a health example; the scan spec names its sources", () => {
  for (const r of ROUTES) { assert.equal(r.group, "tron"); assert.ok(r.example, r.id); }
  assert.deepEqual(SCAN.sources, ["tron.staking", "tron.tokens"]);
  assert.equal(addressKind(SCAN.example).kind, "tron");
});

test("tron staking: Stake 1.0 bandwidth and energy stakes past their lock are high unstake_ready rows, rewards listed first", async () => {
  const d = await TRON.tronStaking({ address: "TMwe5ctHQGPw7GSimLZPooc7SrfsWafHvM" }, replay("nonevm-tron-stake1"));
  assert.deepEqual(d.errors, []);
  const out = F.hfClaims(d, { source: "tron.staking", minUsd: 0 });
  const v1 = out.filter((f) => f.category === "unstake_ready");
  assert.deepEqual(v1.map((f) => f.amount), [2019, 54233]);
  for (const f of v1) {
    assert.equal(f.confidence, "high");
    assert.equal(f.chain, "tron");
    assert.equal(f.asset, "TRX");
    assert.match(f.action, /UnfreezeBalance, resource (BANDWIDTH|ENERGY)/);
    assert.equal(f.how_to_claim, "https://tronscan.org/#/wallet/resources");
  }
  assert.match(v1[1].detail, /lock over since 2023-04-09, never unfrozen/);
  assert.ok(v1[1].usd > 10000 && v1[1].usd < 30000, `usd ${v1[1].usd}`);
  const rw = out.find((f) => f.category === "reward");
  assert.equal(rw.amount, 1.511934);
  assert.match(rw.detail, /claim these before unfreezing/);
  // Stake 2.0 still staked is a holding, never a finding
  assert.deepEqual(d.holdings.map((h) => `${h.kind}:${h.amount}`), ["token:0.081359", "staked:8633"]);
});

test("tron staking: unclaimed voting rewards (SR allowance included) are one high reward row", async () => {
  const d = await TRON.tronStaking({ address: "TBA6CypYJizwA9XdC7Ubgc5F1bxrQ7SqPt" }, replay("nonevm-tron-rewards"));
  const [f] = F.hfClaims(d, { source: "tron.staking" });
  assert.equal(f.category, "reward");
  assert.equal(f.amount, 929816.558499);
  assert.equal(f.confidence, "high");
  assert.match(f.action, /WithdrawBalance/);
  assert.match(f.detail, /3987\.6542 TRX of it is the account's own SR allowance; last withdrawn 2026-05-28/);
  assert.ok(f.usd > 200000, `usd ${f.usd}`);
});

test("tron staking: a Stake 2.0 unstake past its wait is a withdraw row", async () => {
  const d = await TRON.tronStaking({ address: "TFYoetKBaRoocjCMzyCDQS43wjufzevqjp" }, replay("nonevm-tron-v2"));
  const out = F.hfClaims(d, { source: "tron.staking" });
  const f = out.find((x) => x.category === "unstake_ready");
  assert.equal(f.amount, 400);
  assert.match(f.action, /WithdrawExpireUnfreeze/);
  assert.match(f.detail, /wait over since 2026-09-09 \(1 unstake\)/);
  assert.equal(out.find((x) => x.category === "reward").amount, 13.941313);
});

test("tron staking: Stake 1.0 delegated to other accounts lists each receiver", async () => {
  const d = await TRON.tronStaking({ address: "TMPRAmXYchgMvKK5JLiuLKrpcbGo2GsBdM" }, replay("nonevm-tron-delegated"));
  const [f] = F.hfClaims(d, { source: "tron.staking" });
  assert.equal(f.category, "unstake_ready");
  assert.equal(f.amount, 104);
  assert.match(f.action, /receiver_address/);
  assert.match(f.detail, /99 TRX energy to TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G \(lock over 2021-10-31\); 5 TRX energy to TGeHJXWYRbRogg2obVcpCPMRrqAMjUvbEy/);
});

test("tron staking: an account never activated has nothing; a bad address is a 400", async () => {
  assert.deepEqual(await TRON.tronStaking({ address: "TJBaTFzqhYDijCEuktqKo6HgBxBdjRd4UN" }, replay("nonevm-tron-empty")), { items: [], holdings: [], errors: [] });
  await assert.rejects(TRON.tronStaking({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("nonevm-tron-empty")), (e) => e.status === 400);
  await assert.rejects(TRON.tronTokens({ address: "nope" }, replay("nonevm-tron-empty")), (e) => e.status === 400);
});

test("tron tokens: the old Circle USDC is a medium token_migration row Circle must act on; known TRC20 are verified holdings", async () => {
  const d = await TRON.tronTokens({ address: "TYDzsYUEpvnYmQk4zGP9sWWcTEd2MiAtW6" }, replay("nonevm-tron-usdc"));
  const [f] = F.hfClaims(d, { source: "tron.tokens" });
  assert.equal(f.category, "token_migration");
  assert.equal(f.token, OLD_USDC);
  assert.equal(f.amount, 10.730696);
  assert.equal(f.confidence, "medium");
  assert.equal(F.bucketOf(f), "team_must_release");
  const usdt = d.holdings.find((h) => h.asset === "USDT");
  assert.equal(usdt.amount, 559.87);
  assert.equal(usdt.verified, true);
  assert.equal(d.holdings.find((h) => h.asset === "JFI").verified, false);
});

test("tron tokens: a big wallet prices its TRC20 list, unknown tokens stay unverified", async () => {
  const d = await TRON.tronTokens({ address: "TBA6CypYJizwA9XdC7Ubgc5F1bxrQ7SqPt" }, replay("nonevm-tron-tokens"));
  const usdt = d.holdings.find((h) => h.asset === "USDT");
  assert.ok(usdt.usd > 40e6, `usd ${usdt.usd}`);
  assert.ok(d.holdings.every((h) => h.chain === "tron" && h.token && h.usd != null));
  assert.equal(d.holdings.find((h) => h.asset === "HTX").verified, false);
  assert.equal(d.items.length, 1);
});

// nonevm-tron-scan.json keeps the TRX holdings of tron.tokens and drops its TRC20 rows: a base58 contract under "token"
// trips GitGuardian's high-entropy detector (the TRC20 path is covered by nonevm-tron-tokens.json)
test("scan.tron: one answer in the scan.all shape from the replayed sources", async () => {
  const d = await COMPOSE.scanTron({ address: "TMwe5ctHQGPw7GSimLZPooc7SrfsWafHvM" }, replay("nonevm-tron-scan"));
  assert.equal(d.kind, "tron");
  assert.deepEqual(d.sources, { "tron.staking": "ok", "tron.tokens": "ok" });
  assert.equal(d.partial, false);
  assert.deepEqual(d.chains, ["tron"]);
  // the two Stake 1.0 rows are claimable; the 0.5 USD reward is under min_usd
  assert.equal(d.findings.length, 2);
  assert.ok(d.totals.claimable_usd > 15000 && d.totals.claimable_usd < 25000, `claimable ${d.totals.claimable_usd}`);
  assert.equal(d.findings[0].amount, 54233);
  assert.equal(d.findings[0].source, "tron.staking");
  assert.ok(d.holdings.some((h) => h.kind === "staked" && h.source === "tron.staking"));
  await assert.rejects(COMPOSE.scanTron({ address: "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq" }, replay("nonevm-tron-scan")), (e) => e.status === 400);
});
