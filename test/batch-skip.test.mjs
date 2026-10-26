// batch-skip.test.mjs - the sources earlier rounds skipped for want of a proof wallet (forgotten/skipped.mjs): compose
// functions replayed on real answers captured 2026-10-22 (test/fixtures/skip-*.json, recorded with test/skip-io.mjs),
// then the normalizer, the bucket, the GoPlus thin-market rule and the Zerion twin filter
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { FORGOTTEN } from "../forgotten/index.mjs";
import { SKIPPED_ROUTES, SKIPPED_GOPLUS } from "../forgotten/skipped.mjs";
import { HF_SOURCES } from "../forgotten/hf-findings.mjs";
import { REGISTRY } from "../apis.mjs";

// unlock dates and the 3-day stale-quote rule read the clock: pin it just after the capture
mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-22T21:00:00Z") });

const V = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"; // vitalik.eth: the empty wallet
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
const run = async (fn, address, fixture) => {
  const id = Object.keys(SKIPPED_ROUTES).find((k) => SKIPPED_ROUTES[k] === fn);
  const d = await FORGOTTEN[fn]({ address }, replay(fixture));
  return { d, f: F.hfClaims(d, { source: id }).map((x) => ({ ...x, bucket: F.bucketOf(x) })) };
};
const near = (a, b, tol = 0.02) => Math.abs(a - b) <= Math.abs(b) * tol;

// ---- wiring ----
test("skipped sources: every one has a compose route, is a scan source and replaces Zerion's twin rows", () => {
  const byId = new Map(REGISTRY.map((e) => [e.id, e]));
  for (const [id, fn] of Object.entries(SKIPPED_ROUTES)) {
    assert.equal(byId.get(id)?.compose, fn, id);
    assert.equal(typeof FORGOTTEN[fn], "function", fn);
    assert.ok(HF_SOURCES.has(id), id);
    assert.ok(byId.get(id).example?.address, `${id} has a health-sweep example`);
  }
  for (const id of SKIPPED_GOPLUS) assert.ok(SKIPPED_ROUTES[id], id);
});

test("skipped sources: a non-EVM address is a 400", async () => {
  for (const fn of Object.values(SKIPPED_ROUTES)) await assert.rejects(FORGOTTEN[fn]({ address: "nope" }, replay("skip-aave-empty")), (e) => e.status === 400, fn);
});

// ---- Aave incentives ----
test("aave: WAVAX left in the V3 RewardsController and the V2 IncentivesController on Avalanche, both funded = high", async () => {
  const { f } = await run("aaveIncentives", "0x63ea1e234fff29ce8210bbc96d4e0092cf6b7e3c", "skip-aave");
  assert.equal(f.length, 2);
  const v3 = f.find((x) => x.protocol === "Aave V3"), v2 = f.find((x) => x.protocol === "Aave V2");
  assert.equal(v3.amount, 4139.858137); // getUserAccruedRewards on 0x929EC64c
  assert.equal(v2.amount, 7100.248345); // getUserUnclaimedRewards on 0x01D83Fe6
  for (const x of [v3, v2]) {
    assert.equal(x.chain, "avalanche");
    assert.equal(x.asset, "WAVAX");
    assert.equal(x.category, "reward");
    assert.equal(x.confidence, "high");
    assert.equal(x.bucket, "you_can_claim");
    assert.ok(x.usd > x.amount * 3 && x.usd < x.amount * 30, `usd ${x.usd}`);
    assert.match(x.detail, /can pay it now/);
  }
  assert.match(v3.how_to_claim, /marketName=proto_avalanche_v3/);
});

test("aave: dust on vitalik.eth (0.0002 stkAAVE) is dropped by the normalizer", async () => {
  const { d, f } = await run("aaveIncentives", V, "skip-aave-empty");
  assert.ok(d.items.every((i) => i.usd < 1));
  assert.deepEqual(f, []);
  assert.deepEqual(d.errors, []);
});

test("aave: a reward the vault cannot pay is medium and the team must refill it", () => {
  const [f] = F.hfClaims({ items: [{ category: "reward", chain: "polygon", protocol: "Aave V3", asset: "SD", amount: 2692, usd: 900, status: "unfunded", action: "claim SD in the Aave app (Aave V3 on polygon: Dashboard, Claim) once Aave refills the rewards vault: the claim reverts until the Aave team acts", how_to_claim: "https://app.aave.com", detail: "d" }] }, { source: "rewards.aave_incentives" });
  assert.equal(f.confidence, "medium");
  assert.equal(F.bucketOf(f), "team_must_release");
});

// ---- Compound III ----
test("compound: 817 COMP owed on cUSDCv3, CometRewards on Ethereum is empty = medium, team must refill", async () => {
  const { f } = await run("compoundRewards", "0x7f714b13249bed8fde2ef3fbdfb18ed525544b03", "skip-compound");
  assert.equal(f.length, 1);
  assert.equal(f[0].protocol, "Compound III");
  assert.equal(f[0].asset, "COMP");
  assert.equal(f[0].amount, 817.096808); // getRewardOwed(cUSDCv3, wallet)
  assert.equal(f[0].confidence, "medium");
  assert.equal(f[0].bucket, "team_must_release");
  assert.match(f[0].detail, /CometRewards holds 0 COMP now/);
});

test("compound: nothing owed on vitalik.eth", async () => {
  const { d } = await run("compoundRewards", V, "skip-compound-empty");
  assert.deepEqual(d.items, []);
});

// ---- Sablier Flow ----
test("sablier flow: an unwithdrawn USDC payment stream is a high vesting row, read onchain", async () => {
  const { f } = await run("sablierFlow", "0xbb225f9236370878e512d458c7790307bd203616", "skip-flow");
  assert.equal(f.length, 1);
  assert.equal(f[0].category, "vesting");
  assert.equal(f[0].protocol, "Sablier Flow");
  assert.equal(f[0].amount, 262.180781); // withdrawableAmountOf(37)
  assert.equal(f[0].confidence, "high");
  assert.equal(f[0].how_to_claim, "https://app.sablier.com/payments/stream/FL2-1-37");
});

test("sablier flow: no stream on vitalik.eth", async () => {
  const { d } = await run("sablierFlow", V, "skip-flow-empty");
  assert.deepEqual(d.items, []);
});

// ---- LlamaPay ----
test("llamapay: a stream whose payer ran dry still pays what it earned before", async () => {
  const { f, d } = await run("llamaPay", "0x96584f1c9f9a69a65ab5264a8384c28c94a3539a", "skip-llamapay");
  assert.deepEqual(d.errors, []);
  assert.equal(f.length, 1);
  assert.equal(f[0].chain, "ethereum");
  assert.equal(f[0].asset, "USDC");
  assert.equal(f[0].amount, 1672.243055); // withdrawable(payer, payee, amountPerSec)
  assert.equal(f[0].confidence, "high");
  assert.match(f[0].detail, /ran out on 2026-02-08/);
});

test("llamapay: no stream on vitalik.eth", async () => {
  const { d } = await run("llamaPay", V, "skip-llamapay-empty");
  assert.deepEqual(d.items, []);
});

// ---- Authereum ----
test("authereum: ETH in an old Authereum account the wallet is still a key of", async () => {
  const { f } = await run("authereum", "0xab2716dd6cea3486f90483809f69fc5c9e51ba5d", "skip-authereum");
  assert.equal(f.length, 1);
  assert.equal(f[0].asset, "ETH");
  assert.equal(f[0].amount, 1.94567183);
  assert.equal(f[0].confidence, "high");
  assert.match(f[0].detail, /0x05cefcb9471605380c1750874ec652e3f0609856/);
  assert.equal(f[0].how_to_claim, "https://github.com/authereum/direct");
});

test("authereum: no account on vitalik.eth", async () => {
  const { d } = await run("authereum", V, "skip-authereum-empty");
  assert.deepEqual(d.items, []);
});

// ---- PinkLock ----
test("pinklock: a fully vested KEKE lock never unlocked, priced", async () => {
  const { f } = await run("pinkLocks", "0xcA3748DBe42B4E380221F62841441Fd35EABce9D", "skip-pinklock");
  assert.equal(f.length, 1);
  assert.equal(f[0].asset, "KEKE");
  assert.equal(f[0].chain, "ethereum");
  assert.ok(near(f[0].amount, 1341801617916.34), `amount ${f[0].amount}`); // withdrawableTokens(1004944), 7 decimals
  assert.equal(f[0].confidence, "high");
  assert.match(f[0].action, /unlock\(1004944\)/);
});

test("pinklock: the BRX locks are priced by DefiLlama but GoPlus liquidity is thin, so the scan turns them low", async () => {
  const { f, d } = await run("pinkLocks", "0x8c93a690470a1Ea22519412ce1C1E0C7076324Be", "skip-pinklock-bsc");
  assert.equal(f.length, 2);
  assert.equal(d.running_locks, 7);
  assert.ok(f.every((x) => x.asset === "BRX" && x.confidence === "high"));
  assert.ok(SKIPPED_GOPLUS.includes("rewards.pink_locks"));
  const row = { ...f[0] };
  F.applyGoplus(row, F.goplusVerdict({ dex: [{ liquidity: "969000" }] }));
  assert.equal(row.confidence, "low");
  assert.match(row.detail, /thin market/);
});

test("pinklock: no lock on vitalik.eth", async () => {
  const { d } = await run("pinkLocks", V, "skip-pinklock-empty");
  assert.deepEqual(d.items, []);
});

// ---- HoodLock ----
test("hoodlock: two LOCK token locks past their unlock time on Robinhood Chain", async () => {
  const { f } = await run("hoodLocks", "0xBaAbE72573778f34D201733B0735718be9076614", "skip-hoodlock");
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.chain === "robinhood" && x.asset === "LOCK" && x.category === "unstake_ready" && x.confidence === "high"));
  assert.ok(near(f.reduce((s, x) => s + x.amount, 0), 36356241.56, 0.001));
});

test("hoodlock: nothing on vitalik.eth", async () => {
  const { d } = await run("hoodLocks", V, "skip-hoodlock-empty");
  assert.deepEqual(d.items, []);
});

// ---- Klik ----
test("klik: creator fees in ETH on Robinhood Chain and Base, read by simulating collectFees", async () => {
  const { f } = await run("klikFees", "0xE5BB87716C2C6D98AB5814A44abCEC859b1EF3De", "skip-klik");
  assert.equal(f.length, 3);
  assert.ok(f.every((x) => x.category === "creator_fees" && x.asset === "ETH" && x.confidence === "high"));
  const ily = f.find((x) => x.amount === 0.95667271);
  assert.equal(ily.chain, "robinhood");
  assert.match(ily.action, /collectFees\(0x691e88fd50ce00d468db840454abb69764db3cc7\)/);
});

test("klik: nothing on vitalik.eth", async () => {
  const { d } = await run("klikFees", V, "skip-klik-empty");
  assert.deepEqual(d.items, []);
});

// ---- Bankr ----
test("bankr: 13.76 WETH of creator fees plus the unpriced launched token = medium", async () => {
  const { f } = await run("bankrFees", "0x3bd9db0207b3efccb2e208630b5643af2e1d73bf", "skip-bankr");
  assert.equal(f.length, 1);
  assert.equal(f[0].category, "creator_fees");
  assert.equal(f[0].amount, 13.763256);
  const weth = f[0].legs.find((l) => l.asset === "WETH");
  assert.equal(weth.amount, 13.763256);
  assert.equal(f[0].usd, weth.usd); // the launched token has no trusted price: left out of usd
  assert.equal(f[0].confidence, "medium");
  assert.match(f[0].detail, /1 leg without a trusted price/);
});

test("bankr: vitalik.eth is the fee receiver of a test launch; an unknown wallet has nothing", async () => {
  const { f } = await run("bankrFees", V, "skip-bankr-vitalik");
  assert.equal(f.length, 1);
  assert.ok(f[0].usd > 10 && f[0].usd < 200);
  const { d } = await run("bankrFees", "0x00000000000000000000000000000000deadbeef", "skip-bankr-empty");
  assert.deepEqual(d.items, []);
});

// ---- Alpaca 2.0 ----
test("alpaca 2.0: ETH lent through MiniFL and USDT collateral, both payable from the market's cash", async () => {
  const lent = (await run("alpaca2", "0x83021ee8114e5ad59fcebbcc93c59aa4bdc870b9", "skip-alpaca2")).f;
  assert.equal(lent.length, 1);
  assert.equal(lent[0].category, "exchange_balance");
  assert.equal(lent[0].asset, "ETH");
  assert.equal(lent[0].amount, 0.26555322);
  assert.equal(lent[0].confidence, "high");
  const coll = (await run("alpaca2", "0xb549d7f751699a4d4413275955babccb539e5079", "skip-alpaca2-collat")).f;
  assert.equal(coll.length, 1);
  assert.equal(coll[0].asset, "USDT");
  assert.ok(near(coll[0].amount, 315.68), `amount ${coll[0].amount}`);
});

test("alpaca 2.0: nothing on vitalik.eth", async () => {
  const { d } = await run("alpaca2", V, "skip-alpaca2-empty");
  assert.deepEqual(d.items, []);
});

// ---- MM Finance ----
test("mm finance: LP staked in the Cronos chef, valued from the pair reserves, exits by emergencyWithdraw", async () => {
  const { f } = await run("mmFinance", "0x28d373684f3fda793cd7294a48604e7b3b9094ef", "skip-mm-finance");
  const lp = f.find((x) => x.asset === "WCRO-USDC LP");
  assert.ok(lp);
  assert.equal(lp.chain, "cronos");
  assert.equal(lp.category, "token_migration");
  assert.ok(near(lp.usd, 1432.23), `usd ${lp.usd}`);
  assert.equal(lp.legs.length, 2);
  assert.match(lp.action, /emergencyWithdraw/);
});

test("mm finance: LP staked in the Polygon chef; nothing on vitalik.eth", async () => {
  const { f } = await run("mmFinance", "0xb5e6e3dce27d953be2ce3d01afd507da9ae7c7e9", "skip-mm-finance-polygon");
  assert.equal(f.length, 1);
  assert.equal(f[0].chain, "polygon");
  assert.ok(near(f[0].usd, 257.6), `usd ${f[0].usd}`);
  const { d } = await run("mmFinance", V, "skip-mm-finance-empty");
  assert.deepEqual(d.items, []);
});

// ---- double counting ----
test("twins: Zerion's Aave and Compound reward rows of the same amount go once our reads answered", () => {
  const ours = [
    { source: "rewards.aave_incentives", category: "reward", chain: "avalanche", protocol: "Aave V3", asset: "WAVAX", amount: 4139.858137, usd: 37664.91 },
    { source: "rewards.compound_rewards", category: "reward", chain: "ethereum", protocol: "Compound III", asset: "COMP", amount: 817.096808, usd: 19916.88 },
  ];
  const zerion = [
    { source: "rewards.zerion", category: "reward", chain: "avalanche", protocol: "Aave V3", asset: "WAVAX", amount: 4139.8, usd: 37660 },
    { source: "rewards.zerion", category: "reward", chain: "ethereum", protocol: "Compound V3", asset: "COMP", amount: 817.1, usd: 19917 },
    { source: "rewards.zerion", category: "reward", chain: "base", protocol: "Aave V3", asset: "USDC", amount: 50, usd: 50 },
  ];
  const out = F.dropHfTwins({ findings: [...ours, ...zerion], holdings: [] });
  assert.equal(out.findings.length, 3);
  assert.equal(out.findings.filter((x) => x.source === "rewards.zerion").length, 1);
  assert.equal(out.findings.find((x) => x.source === "rewards.zerion").chain, "base");
});
