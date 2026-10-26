// batch-e.test.mjs - forgotten-money sources (forgotten/): compose functions replayed on real answers captured
// 2026-10-20 (test/fixtures/batch-e-*.json: every ctx.call with its params and body), then the normalizers
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { FORGOTTEN } from "../forgotten/index.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name.endsWith(".json") ? name : `${name}.json`}`, import.meta.url), "utf8"));
// a recorded call is matched by route id + params + body (bodies are stored as their sha1 to keep fixtures small)
const sha = (b) => createHash("sha1").update(JSON.stringify(b)).digest("hex");
const replay = (name) => {
  const k = (id, p, b) => `${id}|${JSON.stringify(p || {})}|${b == null ? "" : sha(b)}`;
  const m = new Map(fx(name).map((r) => [r.body_sha ? `${r.id}|${JSON.stringify(r.params || {})}|${r.body_sha}` : k(r.id, r.params, r.body), r]));
  return { live: () => true, local: () => [], call: async (id, p, over = {}) => { const r = m.get(k(id, p, over.body)); if (!r) throw { error: `no fixture for ${id}` }; return { status: r.status, ok: r.status >= 200 && r.status < 300, data: r.data }; } };
};
const NOW = Date.parse("2026-10-20T12:00:00Z");
// public Solana mint addresses the fixtures hold
const MINTS = { whEth: "7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs", bonk: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263" };

// ---- rewards.lrt_withdrawals ----
const LRT_KELP = "0x22de0b5c40f012782a667ccdaa15406ba1201246", LRT_PUFFER = "0xD0c68e2201ed447C6eAba68774F9a2F54a880475", LRT_RENZO = "0x0eacbaa94aecc4e51d299a99915f64ee96f3b468";

test("lrt withdrawals: an unlocked Kelp request is a high finding in ETH", async () => {
  const data = await FORGOTTEN.lrtWithdrawals({ address: LRT_KELP }, replay("batch-e-lrt.json"));
  assert.deepEqual(data.errors, []);
  const kelp = data.items.filter((i) => i.protocol === "Kelp");
  assert.equal(kelp.length, 1);
  assert.equal(kelp[0].status, "ready");
  assert.ok(Math.abs(kelp[0].amount - 5090.085357) < 1e-5, `amount scaled from wei: ${kelp[0].amount}`);
  const f = F.lrtWithdrawals(data, { ethUsd: 2500, now: Date.parse("2026-10-20T12:00:00Z") });
  assert.equal(f.length, 1);
  assert.equal(f[0].category, "unstake_ready");
  assert.equal(f[0].confidence, "high");
  assert.equal(f[0].source, "rewards.lrt_withdrawals");
  assert.equal(f[0].how_to_claim, "https://kerneldao.com/kelp/withdraw");
  assert.ok(f[0].usd > 1e6);
});

test("lrt withdrawals: Puffer requests in an unfinalized batch are one medium finding with the count", async () => {
  const data = await FORGOTTEN.lrtWithdrawals({ address: LRT_PUFFER }, replay("batch-e-lrt.json"));
  const puffer = data.items.filter((i) => i.protocol === "Puffer");
  assert.equal(puffer.length, 3);
  assert.ok(puffer.every((i) => i.status === "pending"));
  const f = F.lrtWithdrawals(data, { ethUsd: 2500, now: Date.parse("2026-10-20T12:00:00Z") });
  assert.equal(f.length, 1);
  assert.equal(f[0].confidence, "medium");
  assert.match(f[0].action, /^3 Puffer withdrawals still in the queue/);
  assert.ok(Math.abs(f[0].amount - puffer.reduce((t, i) => t + i.amount, 0)) < 1e-5);
});

test("lrt withdrawals: Renzo turns ready once its cooldown (ready_at) has passed", async () => {
  const data = await FORGOTTEN.lrtWithdrawals({ address: LRT_RENZO }, replay("batch-e-lrt.json"));
  const renzo = data.items.find((i) => i.protocol === "Renzo");
  assert.equal(renzo.status, "pending");
  assert.ok(renzo.ready_at);
  const before = F.lrtWithdrawals(data, { now: Date.parse(renzo.ready_at) - 3600e3 });
  const after = F.lrtWithdrawals(data, { now: Date.parse(renzo.ready_at) + 3600e3 });
  assert.equal(before[0].confidence, "medium");
  assert.match(before[0].action, new RegExp(`expected about ${renzo.ready_at.slice(0, 10)}`));
  assert.equal(after[0].confidence, "high");
  assert.match(after[0].action, /^claim 1 finished Renzo withdrawal$/);
});

test("lrt withdrawals: claimed, zero and dust rows are dropped; groups split by protocol and state; ETH priced from ethUsd", () => {
  const items = [
    { protocol: "Stader", asset: "ETH", amount: 2, usd: null, status: "ready", id: "1", how_to_claim: "https://www.staderlabs.com/eth/" },
    { protocol: "Stader", asset: "ETH", amount: 1, usd: null, status: "ready", id: "2", how_to_claim: "https://www.staderlabs.com/eth/" },
    { protocol: "Stader", asset: "ETH", amount: 3, usd: null, status: "pending", id: "3", how_to_claim: "https://www.staderlabs.com/eth/" },
    { protocol: "Swell", asset: "ETH", amount: 5, usd: 1, status: "claimed", id: "4" },
    { protocol: "Swell", asset: "ETH", amount: 0, usd: 0, status: "ready", id: "5" },
    { protocol: "Swell", asset: "ETH", amount: 1e-9, usd: 0, status: "ready", id: "6" },
    { protocol: "Liquid Collective", asset: "LsETH", amount: 1, usd: null, status: "pending", id: "7" },
  ];
  const f = F.lrtWithdrawals({ items }, { ethUsd: 2000, now: 0 });
  assert.equal(f.length, 3);
  const ready = f.find((x) => x.protocol === "Stader" && x.confidence === "high");
  assert.equal(ready.amount, 3);
  assert.equal(ready.usd, 6000);
  assert.equal(ready.action, "claim 2 finished Stader withdrawals");
  assert.equal(f.find((x) => x.protocol === "Stader" && x.confidence === "medium").amount, 3);
  assert.equal(f.find((x) => x.protocol === "Liquid Collective").usd, null);
  assert.ok(!f.some((x) => x.protocol === "Swell"));
});

test("lrt withdrawals: a non-EVM address is a 400", async () => {
  await assert.rejects(FORGOTTEN.lrtWithdrawals({ address: "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq" }, replay("batch-e-lrt.json")), (e) => e.status === 400);
});

// ---- rewards.dead_defi ----
test("rewards.dead_defi: dForce iwstETH valued by its exchange rate, loan taken off usd", async () => {
  const r = await FORGOTTEN.deadDefi({ address: "0x6c413690c19cfc80c3db3211c80993bf642c6456" }, replay("batch-e-deaddefi"));
  assert.deepEqual(r.errors, []);
  assert.equal(r.items.length, 1);
  const [i] = r.items;
  assert.equal(i.asset, "iwstETH");
  assert.equal(i.category, "token_migration");
  assert.ok(Math.abs(i.amount - 300.0011) < 0.001, `iwstETH ${i.amount}`); // 300001133868688282513 raw, 18 dp
  assert.equal(i.outputs[0].symbol, "wstETH");
  assert.ok(i.outputs[0].amount >= 300 && i.outputs[0].amount < 301);
  assert.equal(i.valued_by, "contract");
  assert.equal(i.liquidity, "covers"); // getCash 303.26 wstETH
  assert.ok(i.debt_usd > 400000); // iUSDT borrowed against it
  const [f] = F.deadDefi(r);
  assert.equal(f.source, "rewards.dead_defi");
  assert.equal(f.confidence, "medium"); // a loan sits on it
  assert.ok(Math.abs(f.usd - (i.usd - i.debt_usd)) < 0.01);
  assert.match(f.detail, /loan/);
  assert.equal(f.how_to_claim, "https://deaddefi.com");
});

test("rewards.dead_defi: Pickle USDC merkle payout, 6 decimals, unclaimed = high airdrop", async () => {
  const r = await FORGOTTEN.deadDefi({ address: "0x5b56df91f22e913911a7e33832cd6ac129d3b127" }, replay("batch-e-deaddefi"));
  assert.deepEqual(r.errors, []);
  assert.equal(r.items.length, 1); // holds none of the 46 catalog tokens
  const [f] = F.deadDefi(r);
  assert.equal(f.category, "airdrop");
  assert.equal(f.asset, "USDC");
  assert.equal(f.amount, 3501.190886);
  assert.ok(f.usd > 3400 && f.usd < 3600);
  assert.equal(f.confidence, "high");
  assert.equal(f.how_to_claim, "https://deaddefi.com/pickle");
});

test("rewards.dead_defi: rejects a non-EVM address", async () => {
  await assert.rejects(FORGOTTEN.deadDefi({ address: "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq" }, replay("batch-e-deaddefi")), (e) => e.status === 400);
});

test("deadDefi normalizer: confidence, claimed, zero, dust and loan-eaten rows", () => {
  const row = (o) => ({ category: "token_migration", chain: "ethereum", protocol: "P", asset: "X", amount: 10, usd: 100, status: "redeemable", valued_by: "contract", liquidity: "covers", unpriced: 0, market_price: null, action: "a", how_to_claim: "https://deaddefi.com", detail: "d", ...o });
  const out = F.deadDefi({ items: [
    row({ asset: "HIGH" }),
    row({ asset: "PRICEONLY", valued_by: "price", market_price: 10 }),
    row({ asset: "LIMITED", status: "limited" }),
    row({ asset: "STRATEGY", liquidity: "strategy" }),
    row({ asset: "PARTPRICED", unpriced: 2 }),
    row({ asset: "NOPRICE", usd: null, valued_by: null }),
    row({ asset: "DRY", liquidity: "none" }),
    row({ asset: "PAUSED", status: "unreadable", valued_by: null, usd: null, liquidity: null }),
    row({ asset: "ZERO", amount: 0 }),
    row({ asset: "DUST", usd: 0.001 }),
    row({ asset: "UNDERWATER", debt_usd: 150 }),
    { category: "airdrop", chain: "ethereum", protocol: "Pickle Finance", asset: "USDC", amount: 5, usd: 5, status: "claimed", action: "c", how_to_claim: "https://deaddefi.com/pickle", detail: "d" },
  ] });
  const by = Object.fromEntries(out.map((f) => [f.asset, f]));
  assert.deepEqual(Object.keys(by).sort(), ["DRY", "HIGH", "LIMITED", "NOPRICE", "PARTPRICED", "PAUSED", "PRICEONLY", "STRATEGY"]);
  assert.equal(by.HIGH.confidence, "high");
  assert.equal(by.PRICEONLY.confidence, "medium");
  for (const a of ["LIMITED", "STRATEGY", "PARTPRICED"]) assert.equal(by[a].confidence, "medium", a);
  for (const a of ["NOPRICE", "DRY", "PAUSED"]) assert.equal(by[a].confidence, "low", a);
  assert.equal(by.NOPRICE.usd, null);
  assert.ok(out.every((f) => f.source === "rewards.dead_defi" && f.deadline === null));
});

// ---- solana slice: sol.leftovers (Serum OpenOrders, Marinade tickets, program buffers) + sol.vesting_streams (Streamflow)
test("sol.leftovers: Serum OpenOrders funds + rent are decoded and scaled by the mint decimals", async () => {
  const d = await FORGOTTEN.solLeftovers({ address: "DLWPRzPY2bRu97y2BSbh8WehQMcs5knLnuJ8cdYYCRYp" }, replay("batch-e-sol-leftovers"));
  assert.deepEqual(d.errors, []);
  const eth = d.items.find((i) => i.protocol === "Serum" && i.category === "unstake_ready");
  assert.equal(eth.token, MINTS.whEth); // Wormhole ETH, 8 decimals
  assert.equal(eth.amount, 820.3802); // baseTotal 82,038,020,000 raw
  assert.equal(eth.status, "ready");
  assert.equal(eth.vault_covers, true);
  const f = F.solLeftovers(d, { solUsd: 150 });
  const fe = f.find((x) => x.category === "unstake_ready");
  assert.equal(fe.confidence, "high");
  assert.ok(fe.usd > 1e6);
  const rent = f.find((x) => x.category === "solana_rent");
  assert.equal(rent.confidence, "high");
  assert.equal(rent.amount, 0.233578); // 10 accounts x 0.02335776 SOL
  assert.equal(rent.usd, 0.2335776 * 150);
});

test("sol.leftovers: Serum funds in resting orders are medium, unverified mints a low hint without usd, dust dropped", () => {
  const base = { category: "unstake_ready", chain: "solana", protocol: "Serum", asset: "X", token: "m", amount: 5, usd: 10, price: 2, verified: true, status: "ready", vault_covers: true, detail: "d" };
  const [orders, spam] = F.solLeftovers({ items: [{ ...base, status: "in_orders" }, { ...base, verified: false }, { ...base, amount: 1, usd: 0.001 }] });
  assert.equal(orders.confidence, "medium");
  assert.equal(spam.confidence, "low");
  assert.equal(spam.usd, null);
  assert.equal(F.solLeftovers({ items: [{ ...base, amount: 1, usd: 0.001 }, { ...base, amount: 0 }] }).length, 0);
});

test("sol.leftovers: Marinade ticket pays stake + ticket rent; ready after its epoch, pending before", async () => {
  const d = await FORGOTTEN.solLeftovers({ address: "CuzppSsNv5GTpjgeQJyziKgTjED2ZdmuFh63RmZNbsdY" }, replay("batch-e-sol-leftovers"));
  const t = d.items.find((i) => i.protocol === "Marinade");
  assert.equal(t.created_epoch, 370);
  assert.equal(t.unstaked_sol, 128.213808034);
  assert.equal(t.amount, 128.215311394); // + 0.00150336 SOL rent, both paid on claim
  const ready = F.solLeftovers(d, { solUsd: 100 }).find((x) => x.protocol === "Marinade");
  assert.equal(ready.category, "unstake_ready");
  assert.equal(ready.confidence, "high");
  assert.equal(ready.amount, 128.215311);
  const due = F.solLeftovers(d, { solUsd: 100, epoch: 371 }).find((x) => x.protocol === "Marinade");
  assert.equal(due.confidence, "medium");
  const pending = F.solLeftovers(d, { solUsd: 100, epoch: 370 }).find((x) => x.protocol === "Marinade");
  assert.equal(pending.confidence, "medium");
  assert.match(pending.action, /claimable from epoch 371/);
});

test("sol.leftovers: program buffers the wallet is authority of become one solana_rent finding", async () => {
  const d = await FORGOTTEN.solLeftovers({ address: "FdtiepBtP98oU2uPNgAzUoGwggUDdRXwJH2KJo3oUaix" }, replay("batch-e-sol-leftovers"));
  assert.equal(d.items.filter((i) => i.protocol === "Solana program buffer").length, 2);
  const [b] = F.solLeftovers(d, { solUsd: 100 });
  assert.equal(b.category, "solana_rent");
  assert.equal(b.confidence, "high");
  assert.equal(b.amount, 88.542072);
  assert.equal(b.txs, 2);
  assert.match(b.detail, /77QjFMxL1KNGF1sH5UnWYZXRu5VT21Qc8aYCzU6uYLTs/);
});

test("sol.leftovers / sol.vesting_streams: a non-Solana address is a 400", async () => {
  await assert.rejects(FORGOTTEN.solLeftovers({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("batch-e-sol-leftovers")), (e) => e.status === 400);
  await assert.rejects(FORGOTTEN.solStreams({ address: "nope" }, replay("batch-e-sol-streams")), (e) => e.status === 400);
});

test("sol.vesting_streams: ended Streamflow stream never withdrawn = 2.70B BONK vesting, high", async () => {
  const d = await FORGOTTEN.solStreams({ address: "YCh3rSTaSFEHXAS65RTU1GWxb4je51cmaHScktPF6r2" }, replay("batch-e-sol-streams"));
  assert.deepEqual(d.errors, []);
  const s = d.items[0];
  assert.equal(s.stream, "8uAoHEfB12X7pMchRLNpD94rUsbfnWmn2ZqoBxprrGUP");
  assert.equal(s.token, MINTS.bonk);
  assert.equal(s.deposited, "270270270300000");
  const { findings, holdings } = F.solStreams(d, { now: Date.parse("2026-10-20") });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "vesting");
  assert.equal(findings[0].amount, 2702702703);
  assert.equal(findings[0].confidence, "high");
  assert.ok(findings[0].usd > 0);
  assert.equal(holdings.length, 0);
});

test("sol.vesting_streams: mid-stream splits unlocked (finding) and locked (holding); before the cliff nothing is free", async () => {
  const d = await FORGOTTEN.solStreams({ address: "YCh3rSTaSFEHXAS65RTU1GWxb4je51cmaHScktPF6r2" }, replay("batch-e-sol-streams"));
  const mid = F.solStreams(d, { now: (1684476000 + 10 * 604800 + 5) * 1000 }); // 10 weekly periods after the cliff
  assert.equal(mid.findings[0].amount, 518326545.7808);
  assert.equal(mid.holdings[0].kind, "locked");
  assert.equal(mid.holdings[0].amount, 2184376157.2192);
  const early = F.solStreams(d, { now: 1684476000 * 1000 - 1 });
  assert.equal(early.findings.length, 0);
  assert.equal(early.holdings[0].amount, 2702702703);
});

test("sol.vesting_streams: withdrawn streams drop, unverified mints are a low hint without usd", async () => {
  const d = await FORGOTTEN.solStreams({ address: "YCh3rSTaSFEHXAS65RTU1GWxb4je51cmaHScktPF6r2" }, replay("batch-e-sol-streams"));
  const s = d.items[0];
  assert.deepEqual(F.solStreams({ items: [{ ...s, withdrawn: s.deposited }] }, { now: Date.parse("2026-10-20") }), { findings: [], holdings: [] });
  const [spam] = F.solStreams({ items: [{ ...s, verified: false }] }, { now: Date.parse("2026-10-20") }).findings;
  assert.equal(spam.confidence, "low");
  assert.equal(spam.usd, null);
});


// ---- rewards.old_tokens ----
test("old tokens: SAI is valued at the WETH its Tap pays (fix), not its market price; high", async () => {
  const d = await FORGOTTEN.oldTokens({ address: "0xec69acc35320b383580cbcc3c75a4441164d7660" }, replay("batch-e-tokens"));
  const [sai] = d.items;
  assert.equal(sai.amount, 236554.08292024); // 236,554.08 SAI, 18 dp
  assert.ok(Math.abs(sai.paid.amount - 1250.3189) < 1e-3, `WETH ${sai.paid.amount}`); // x 0.0052855 WETH per SAI
  const [f] = F.oldTokens(d);
  assert.equal(f.category, "token_migration");
  assert.equal(f.confidence, "high");
  assert.equal(f.token, "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359");
  assert.ok(f.usd > 2e6 && f.usd < 5e6);
  assert.match(f.how_to_claim, /0xBda109309f9FafA6Dd6A9CB9f1Df4085B27Ee8eF/);
});

test("old tokens: NU and KEEP swap to T at the VendingMachine ratio, REPv1 1:1, FTM to S is medium", async () => {
  const d = await FORGOTTEN.oldTokens({ address: "0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43" }, replay("batch-e-tokens"));
  const by = Object.fromEntries(d.items.map((i) => [i.asset, i]));
  assert.ok(Math.abs(by.NU.paid.amount / by.NU.amount - 3.259242493160745) < 1e-9); // conversionToT(1e18) = 3.2592 T
  assert.ok(Math.abs(by.KEEP.paid.amount / by.KEEP.amount - 4.783188631255016) < 1e-9);
  assert.equal(by.REPv1.paid.amount, by.REPv1.amount);
  const f = Object.fromEntries(F.oldTokens(d).map((x) => [x.asset, x]));
  assert.equal(f.NU.confidence, "high");
  assert.equal(f.REPv1.confidence, "high");
  assert.equal(f.FTM.confidence, "medium");
  assert.match(f.FTM.how_to_claim, /gateway\.soniclabs\.com/);
});

test("old tokens: OHM v1 whose migrator holds no gOHM is a low hint without a price", async () => {
  const d = await FORGOTTEN.oldTokens({ address: "0x0d0707963952f2fba59dd06f2b425ace40b492fe" }, replay("batch-e-tokens"));
  const ohm = d.items.find((i) => i.asset === "OHMv1");
  assert.equal(ohm.amount, 1362.942257168); // 9 dp
  assert.equal(ohm.status, "unfunded");
  const f = F.oldTokens(d).find((x) => x.asset === "OHMv1");
  assert.equal(f.confidence, "low");
  assert.equal(f.usd, null);
  assert.match(f.detail, /29\.17\d* gOHM/);
});

test("totals: a token_migration counts when no priced holding lists its token, and not when one does", () => {
  const f = F.oldTokens({ items: [{ asset: "SAI", token: "0x89D24A6b4CcB1B6fAA2625fE562bDD9a23260359", chain: "ethereum", amount: 10, usd: 100, status: "ready" }] }).map((x) => ({ ...x, net_after_fees_usd: x.usd }));
  assert.equal(F.summarize(f, []).totals.claimable_usd, 100);
  const held = [{ kind: "token", chain: "ethereum", token: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359", asset: "SAI", amount: 10, usd: 129, verified: true }];
  assert.equal(F.summarize(f, held).totals.claimable_usd, 0);
});

// ---- rewards.expired_locks ----
test("expired locks: a veCRV lock past its end is a high withdraw finding; before its end it is nothing", async () => {
  const d = await FORGOTTEN.expiredLocks({ address: "0xd4a39d219adb43ab00739dc5d876d98fdf0121bf" }, replay("batch-e-tokens"));
  const [lock] = d.items;
  assert.equal(lock.protocol, "veCRV");
  assert.ok(Math.abs(lock.amount - 2832569.734022) < 1e-5);
  assert.equal(lock.ends, "2023-08-24T00:00:00.000Z");
  const [f] = F.expiredLocks(d, { now: NOW });
  assert.equal(f.category, "unstake_ready");
  assert.equal(f.confidence, "high");
  assert.ok(f.usd > 0);
  assert.deepEqual(F.expiredLocks(d, { now: Date.parse("2023-08-01") }), []);
});

test("expired locks: vlCVX unlockable balance (no end date) is withdrawable now", async () => {
  const d = await FORGOTTEN.expiredLocks({ address: "0xb1748c79709f4ba2dd82834b8c82d4a505003f27" }, replay("batch-e-tokens"));
  const [f] = F.expiredLocks(d, { now: NOW });
  assert.equal(f.protocol, "vlCVX");
  assert.equal(f.amount, 75000);
  assert.match(f.action, /processExpiredLocks/);
});

test("zerion twins: our lock read replaces Zerion's locked row of the same amount, other rows stay", () => {
  const run = {
    findings: [{ source: "rewards.expired_locks", chain: "ethereum", protocol: "veCRV", amount: 100, usd: 40 }, { source: "rewards.zerion", category: "reward", chain: "ethereum", protocol: "Curve", amount: 5, usd: 2 }],
    holdings: [{ kind: "locked", chain: "ethereum", protocol: "Curve", asset: "CRV", amount: 100.5, usd: 40 }, { kind: "deposit", chain: "ethereum", protocol: "Curve", asset: "3CRV", amount: 7, usd: 7 }, { kind: "locked", chain: "base", protocol: "Curve", amount: 100, usd: 40 }],
  };
  const out = F.dropZerionTwins(run);
  assert.equal(out.holdings.length, 2);
  assert.ok(!out.holdings.some((h) => h.chain === "ethereum" && h.kind === "locked"));
  assert.equal(out.findings.length, 2);
});

// ---- rewards.stargate_fees ----
test("stargate fees: an unclaimed veSTG fee entry (isClaimed false) is a high USDC reward, 6 dp", async () => {
  const d = await FORGOTTEN.stargateFees({ address: "0xf70c1cb0a9833ba9613f054db71ab3eaf45060b6" }, replay("batch-e-stargate"));
  assert.deepEqual(d.errors, []);
  assert.equal(d.items.length, 1);
  assert.equal(d.items[0].status, "unclaimed");
  const [f] = F.stargateFees(d);
  assert.equal(f.amount, 250.709713);
  assert.equal(f.chain, "ethereum");
  assert.equal(f.confidence, "high");
  const row = d.items[0];
  assert.deepEqual(F.stargateFees({ items: [{ ...row, status: "claimed" }] }), []);
  assert.equal(F.stargateFees({ items: [{ ...row, status: "unknown" }] })[0].confidence, "low");
});

// ---- holdings.smart_wallets ----
test("smart wallets: only the 1-owner Safe is kept; its Aave supply and debt are holdings, the debt negative", async () => {
  const d = await FORGOTTEN.smartWallets({ address: "0x5e06839a09da9c7825a2b041df9367bbf0f916bc" }, replay("batch-e-wallets"));
  assert.deepEqual(d.wallets, [{ chain: "ethereum", wallet: "0x6320E8710D662CF7D6B5490E74B1eD653621bC92", kind: "Safe" }]); // its twin Safe 0x63201EdA is not owned by it alone
  const h = F.smartWallets(d, { minUsd: 1 });
  const ws = h.find((x) => x.asset === "aEthwstETH");
  assert.ok(Math.abs(ws.amount - 114.545) < 0.01);
  assert.ok(ws.usd > 100000);
  const debt = h.find((x) => x.asset === "variableDebtEthUSDT");
  assert.equal(debt.kind, "loan");
  assert.ok(debt.usd < -250000);
  assert.ok(!h.some((x) => x.asset === "ERC20" || x.asset === "ETH")); // unpriced spam and dust dropped
  assert.ok(h.every((x) => x.source === "holdings.smart_wallets" && x.protocol === "Safe"));
});

test("smart wallets: an Instadapp DSA on Optimism shows the aOptWETH Alchemy's index misses (read on the Aave pool)", async () => {
  const d = await FORGOTTEN.smartWallets({ address: "0xb5502eb557cdddc03309a2c3b384fb9c6e6686d5" }, replay("batch-e-wallets"));
  assert.ok(d.wallets.some((w) => w.kind === "Instadapp DSA" && w.chain === "optimism"));
  const weth = F.smartWallets(d).find((x) => x.chain === "optimism" && x.asset === "aOptWETH");
  assert.ok(Math.abs(weth.amount - 4.5868) < 0.001, `aOptWETH ${weth?.amount}`);
});

// ---- rewards.dead_apps ----
test("dead apps: staked GLP on Avalanche is priced by its GlpManager; an Element PT redeems after expiry", async () => {
  const glp = await FORGOTTEN.deadApps({ address: "0x62331a7bd1dfb3a7642b7db50b5509e57ca3154a", parts: "glp" }, replay("batch-e-deadapps"));
  assert.deepEqual(glp.errors, []);
  const [g] = F.deadApps(glp);
  assert.equal(g.protocol, "GMX v1");
  assert.equal(g.chain, "avalanche");
  assert.ok(Math.abs(g.amount - 491436.855) < 0.01);
  assert.ok(g.usd / g.amount > 0.5 && g.usd / g.amount < 1.5); // GlpManager getPrice, 1e30 scale
  assert.equal(g.confidence, "high");
  const el = await FORGOTTEN.deadApps({ address: "0x5b192f6c674fe0ebb92ef32814e371919eec975f", parts: "element" }, replay("batch-e-deadapps"));
  const pts = F.deadApps(el);
  assert.equal(pts.length, 1); // a 1e-7 LP leftover is dust
  assert.equal(pts[0].asset, "ePT-crv3crypto");
  assert.ok(Math.abs(pts[0].amount - 15.262) < 0.001);
});

test("dead apps: a smart account's EntryPoint deposit is medium; a Lighter pending balance is base x tickSize", async () => {
  const ep = await FORGOTTEN.deadApps({ address: "0x2faeb0760d4230ef2ac21496bb4f0b47d634fd4c", parts: "entrypoint" }, replay("batch-e-deadapps"));
  const [e] = F.deadApps(ep);
  assert.equal(e.chain, "base");
  assert.ok(Math.abs(e.amount - 80.896) < 0.01);
  assert.equal(e.confidence, "medium");
  const li = await FORGOTTEN.deadApps({ address: "0xfa2d904758ddf363b47049d1d8f933008414ee45", parts: "lighter" }, replay("batch-e-deadapps"));
  const [l] = F.deadApps(li);
  assert.equal(l.protocol, "Lighter");
  assert.equal(l.asset, "ETH");
  assert.equal(l.amount, 0.405); // 40,500,000 base x tickSize 1e10 wei
  assert.equal(l.confidence, "high");
});

// ---- rewards.bnb_farms ----
const BNB_ALPACA = "0x22ee31cf585c8fc1b05f2f802a508faffc3a6d8f"; // FairLaunch pid 1 ibBNB + pid 18 ibBTCB (migrated vault)
const BNB_NERVE = "0x5308b336041afd2cfd470a0226592f7719bfa747"; // Nerve MasterMind pid 0 3NRV-LP + 3NRV-LP in the wallet
const BNB_BAKERY = "0x9608c90c5845debc4b4b3e438219054cba1b0e68"; // BakeryMaster WBNB-BAKE BLP + pending BAKE

test("bnb farms: Alpaca FairLaunch stakes, ibToken value, migrated vault, ALPACA rewards", async () => {
  const d = await FORGOTTEN.bnbFarms({ address: BNB_ALPACA, farms: "alpaca" }, replay("batch-e-bnb.json"));
  assert.deepEqual(d.errors, []);
  const ibBnb = d.items.find((i) => i.category === "unstake_ready" && i.pid === 1);
  assert.equal(ibBnb.asset, "ibBNB");
  assert.ok(Math.abs(ibBnb.amount - 4796.991) < 0.01, "18-decimal amount scaled");
  assert.equal(ibBnb.value_kind, "ibtoken");
  assert.ok(ibBnb.usd / ibBnb.amount > 300 && ibBnb.usd / ibBnb.amount < 5000, "ibBNB = totalToken/totalSupply x BNB");
  const ibBtc = d.items.find((i) => i.category === "unstake_ready" && i.pid === 18);
  assert.equal(ibBtc.value_kind, "ibtoken_migrated");
  assert.ok(ibBtc.usd / ibBtc.amount > 10000, "migrated ibBTCB valued through its Alpaca 2.0 ibTokens, not the near-empty v1 vault");
  assert.match(ibBtc.action, /claimFor/);
  assert.equal(ibBtc.how_to_claim, "https://bscscan.com/address/0xA625AB01B08ce023B2a342Dbb12a16f2C8489A8F#writeContract");
  const rewards = d.items.filter((i) => i.category === "reward");
  assert.equal(rewards.length, 2);
  assert.ok(rewards.every((r) => r.asset === "ALPACA" && r.usd > 0));
  const f = F.bnbFarms(d);
  assert.ok(f.every((x) => x.source === "rewards.bnb_farms" && x.chain === "bsc" && x.deadline === null));
  assert.equal(f.find((x) => x.asset === "ibBTCB").confidence, "high");
  assert.equal(f.filter((x) => x.category === "reward").length, 2, "both ALPACA rewards are over $1");
});

test("bnb farms: Nerve stake + pool tokens in the wallet valued from the pool balances", async () => {
  const d = await FORGOTTEN.bnbFarms({ address: BNB_NERVE, farms: "nerve" }, replay("batch-e-bnb.json"));
  const staked = d.items.find((i) => i.position === "staked");
  assert.equal(staked.asset, "3NRV-LP");
  assert.ok(Math.abs(staked.amount - 157163.89) < 0.1);
  assert.ok(staked.usd / staked.amount > 0.95 && staked.usd / staked.amount < 1.1, "3pool token ~ $1");
  assert.match(staked.action, /emergencyWithdraw\(0\)/);
  const wallet = d.items.find((i) => i.position === "wallet");
  assert.equal(wallet.category, "token_migration");
  assert.ok(Math.abs(wallet.amount - 534.335) < 0.01);
  assert.equal(d.items.filter((i) => i.category === "reward").length, 0, "emergencyWithdraw forfeits NRV: no reward rows");
  const f = F.bnbFarms(d);
  assert.deepEqual(f.map((x) => x.category).sort(), ["token_migration", "unstake_ready"]);
  assert.match(f.find((x) => x.category === "unstake_ready").detail, /pool 0/);
});

test("bnb farms: BakerySwap LP valued from getReserves, BAKE reward", async () => {
  const d = await FORGOTTEN.bnbFarms({ address: BNB_BAKERY, farms: "bakery" }, replay("batch-e-bnb.json"));
  const lp = d.items.find((i) => i.category === "unstake_ready");
  assert.equal(lp.value_kind, "lp");
  assert.match(lp.asset, /WBNB/);
  assert.ok(lp.usd > 100 && lp.amount > 600);
  const bake = d.items.find((i) => i.category === "reward");
  assert.equal(bake.asset, "BAKE");
  assert.ok(Math.abs(bake.amount - 30482.52) < 0.01);
});

test("bnb farms: one farm without an answer lands in errors, input checks", async () => {
  const d = await FORGOTTEN.bnbFarms({ address: BNB_BAKERY, farms: "alpaca" }, replay("batch-e-bnb.json"));
  assert.deepEqual(d.items, []);
  assert.match(d.errors[0], /^alpaca: /);
  await assert.rejects(FORGOTTEN.bnbFarms({ address: "nope" }, replay("batch-e-bnb.json")), (e) => e.status === 400);
  await assert.rejects(FORGOTTEN.bnbFarms({ address: BNB_BAKERY, farms: "sushi" }, replay("batch-e-bnb.json")), (e) => e.status === 400);
});

test("bnb farms normalizer: dust under $1 dropped, unpriced and uncertain rows medium, zero rows dropped", () => {
  const row = (o) => ({ category: "unstake_ready", chain: "bsc", protocol: "AutoFarm", asset: "X", amount: 5, usd: 10, status: "ready", position: "staked", pid: 3, action: "a", how_to_claim: "h", detail: "d", ...o });
  const f = F.bnbFarms({ items: [row({}), row({ usd: 0.5 }), row({ usd: null }), row({ status: "uncertain" }), row({ amount: 0 }), row({ category: "reward", usd: 0.2 })] });
  assert.equal(f.length, 3);
  assert.deepEqual(f.map((x) => x.confidence), ["high", "medium", "medium"]);
  assert.equal(f[1].usd, null);
  assert.equal(f[0].detail, "d (pool 3)");
  assert.deepEqual(F.bnbFarms(null), []);
});

// ---- Zerion's chain names and twins on other chains ----
// a Zerion positions answer with one row, shaped like test/fixtures/zerion-rewards.json
const zerionRow = ({ chain, protocol, type, symbol, amount, usd, token = null }) => ({
  data: [{ attributes: { position_type: type, protocol, name: `${protocol} ${symbol}`, quantity: { numeric: String(amount) }, value: usd, fungible_info: { symbol, implementations: [{ chain_id: chain, address: token }] } }, relationships: { chain: { data: { id: chain } } } }],
});

test("chain names: every Zerion slug for a chain EVM_CHAINS knows maps to our name", () => {
  const slugs = Object.entries(fx("../../chains/zerion-chains.json")).filter(([k, id]) => k !== "_" && F.EVM_CHAINS[id]);
  for (const [slug, id] of slugs) assert.equal(F.sameChain(slug), F.EVM_CHAINS[id], slug);
  assert.equal(F.sameChain("bsc"), "bsc");
});

test("totals: an Alpaca ibToken in the wallet that Zerion prices on binance-smart-chain counts once", () => {
  const ib = "0xd7d069493685a581d27824fc46eda46b7efc0063";
  const f = F.bnbFarms({ items: [{ category: "token_migration", chain: "bsc", protocol: "Alpaca Finance", asset: "ibBNB", token: ib, amount: 10, usd: 9000, status: "ready", position: "wallet", action: "a", how_to_claim: "h", detail: "d" }] }).map((x) => ({ ...x, net_after_fees_usd: x.usd }));
  const { holdings } = F.zerionHoldings({ data: [{ attributes: { value: 9000, quantity: { numeric: "10" }, fungible_info: { symbol: "ibBNB", flags: { verified: true }, implementations: [{ chain_id: "binance-smart-chain", address: ib }] } }, relationships: { chain: { data: { id: "binance-smart-chain" } } } }] });
  const { totals } = F.summarize(f, holdings);
  assert.equal(totals.holdings_usd, 9000);
  assert.equal(totals.claimable_usd, 0, "the same ibBNB is not also claimable");
});

test("zerion twins: staked GLP (Avalanche) and an Alpaca stake (binance-smart-chain) replace Zerion's rows", async () => {
  const glp = F.deadApps(await FORGOTTEN.deadApps({ address: "0x62331a7bd1dfb3a7642b7db50b5509e57ca3154a", parts: "glp" }, replay("batch-e-deadapps")));
  const bnb = F.bnbFarms(await FORGOTTEN.bnbFarms({ address: BNB_ALPACA, farms: "alpaca" }, replay("batch-e-bnb.json")));
  const ibBnb = bnb.find((x) => x.asset === "ibBNB"), reward = bnb.find((x) => x.category === "reward");
  const z = [
    F.zerionPositions(zerionRow({ chain: "avalanche", protocol: "GMX", type: "staked", symbol: "GLP", amount: glp[0].amount, usd: glp[0].usd })),
    F.zerionPositions(zerionRow({ chain: "binance-smart-chain", protocol: "Alpaca Finance", type: "staked", symbol: "ibBNB", amount: ibBnb.amount, usd: ibBnb.usd })),
    F.zerionPositions(zerionRow({ chain: "binance-smart-chain", protocol: "Alpaca Finance", type: "reward", symbol: "ALPACA", amount: reward.amount, usd: reward.usd })),
    F.zerionPositions(zerionRow({ chain: "arbitrum", protocol: "GMX", type: "staked", symbol: "GLP", amount: glp[0].amount, usd: glp[0].usd })), // other chain: stays
  ];
  const run = { findings: [...glp, ...bnb, ...z.flatMap((x) => x.findings)], holdings: z.flatMap((x) => x.holdings) };
  const out = F.dropZerionTwins(run);
  assert.deepEqual(out.holdings.map((h) => h.chain), ["arbitrum"]);
  assert.equal(out.findings.filter((f) => f.source === "rewards.zerion").length, 0);
  assert.equal(out.findings.length, glp.length + bnb.length);
});

test("zerion twins: Zerion's whole vlCVX lock keeps only the still-locked part next to our unlockable finding", async () => {
  const [f] = F.expiredLocks(await FORGOTTEN.expiredLocks({ address: "0xb1748c79709f4ba2dd82834b8c82d4a505003f27" }, replay("batch-e-tokens")), { now: NOW });
  assert.equal(f.locked, 850000);
  const z = F.zerionPositions(zerionRow({ chain: "ethereum", protocol: "Convex Finance", type: "locked", symbol: "CVX", amount: 925000, usd: 2_075_000 }));
  const out = F.dropZerionTwins({ findings: [f], holdings: z.holdings });
  assert.equal(out.holdings.length, 1);
  assert.equal(out.holdings[0].amount, 850000);
  assert.equal(out.holdings[0].usd, 1_906_756.76);
  const { totals } = F.summarize([{ ...f, net_after_fees_usd: f.usd }], out.holdings);
  assert.equal(totals.locked_usd + totals.claimable_usd, Math.round((1_906_756.76 + f.usd) * 100) / 100, "unlockable counted once, the locked rest once");
});
