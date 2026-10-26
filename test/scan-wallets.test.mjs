// scan-wallets.test.mjs - scan.wallets: the address list (dedupe, mixed EVM + Solana, limits), merged totals and
// address tags on a fake ctx, bounded concurrency, the time budget, and through engine.callRoute the address list as
// a string, an array or with other params. Upstreams are a stubbed fetch (no network)
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.WALLETS_MAX = "4";
globalThis.fetch = async () => new Response("{}", { status: 404 });

const F = await import("../findings.mjs");
const { COMPOSE, walletList, WALLETS } = await import("../compose.mjs");

const E1 = "0x31dC14430AF73e3D91155FD98FAc4598913D089a", E2 = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const S1 = "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq", S2 = "So11111111111111111111111111111111111111112";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const f = (o) => ({ chain: "ethereum", asset: "ETH", amount: 1, action: "claim it", how_to_claim: null, deadline: null, source: "test", detail: null, ...o });

// what scan.all answers for one wallet (the parts scan.wallets reads), built with the real summarize
function scanAnswer(address, findings, holdings = [], { failed = [] } = {}) {
  const out = F.summarize(findings, holdings);
  const partial = failed.length > 0;
  out.totals.partial = partial;
  return { address, kind: address.startsWith("0x") ? "evm" : "solana", partial, failed_sources: failed, ...out, spam_hidden: 1, holdings, sources: { "rewards.merkl": "ok", ...Object.fromEntries(failed.map((x) => [x.id, `error: ${x.reason}`])) }, deadlines_open: [{ id: "x" }], prices: { eth_usd: 2000 } };
}
const ANSWERS = {
  [E1]: scanAnswer(E1, [f({ category: "reward", usd: 100, confidence: "high" }), f({ category: "reward", usd: 40, confidence: "medium" })], [{ kind: "token", chain: "base", asset: "USDC", usd: 10, verified: true }]),
  [S1]: scanAnswer(S1, [f({ category: "solana_rent", chain: "solana", asset: "SOL", usd: 500, confidence: "high" }), f({ category: "airdrop", chain: "solana", usd: 9, confidence: "low" })], [], { failed: [{ id: "sol.assets", reason: "upstream 500" }] }),
  [E2]: scanAnswer(E2, [f({ category: "bridge_blocked", usd: 70, confidence: "low", action: "stuck until the Polygon team acts: contact them with tx 0x1" })]),
};
// a fake ctx whose scan.all answers from ANSWERS after `delay(address)` ms, counting scans running at once
function fakeCtx({ delay = () => 5, answers = ANSWERS } = {}) {
  const st = { running: 0, peak: 0, calls: [] };
  return {
    st, live: () => true, local: () => [],
    call: async (id, p) => {
      assert.equal(id, "scan.all");
      st.calls.push(p);
      st.running++; st.peak = Math.max(st.peak, st.running);
      await sleep(delay(p.address));
      st.running--;
      return answers[p.address] ? { status: 200, ok: true, data: answers[p.address] } : { status: 502, ok: false, data: { error: "step scan.evm failed (upstream 500)" } };
    },
  };
}

test("walletList: comma, space or array; EVM and Solana mixed; duplicates dropped (EVM without case)", () => {
  assert.deepEqual(walletList(`${E1}, ${S1}\n${E1.toLowerCase()} ${S1}`), [E1, S1]);
  assert.deepEqual(walletList([E2, S2, E2.toUpperCase().replace("0X", "0x")]), [E2, S2]);
});

test("walletList: a bad address, an empty list or too many = 400", () => {
  assert.throws(() => walletList(`${E1},hello,0x12`), (e) => e.status === 400 && /2 addresses are not valid /.test(e.error) && e.detail.join() === "hello,0x12");
  assert.throws(() => walletList(""), (e) => e.status === 400 && e.detail[0] === "addresses");
  assert.throws(() => walletList(undefined), (e) => e.status === 400);
  assert.equal(WALLETS.max, 4);
  const five = [E1, E2, S1, S2, "0x0000000000000000000000000000000000000001"];
  assert.throws(() => walletList(five), (e) => e.status === 400 && /max 4 addresses/.test(e.error) && /got 5/.test(e.error));
});

test("scanWallets: one merged answer, every row tagged with its address, totals added up", async () => {
  const ctx = fakeCtx();
  const d = await COMPOSE.scanWallets({ addresses: `${E1},${S1},${E2}`, min_usd: "5", skip: "bridge.stuck" }, ctx);
  assert.deepEqual(ctx.st.calls.map((p) => p.min_usd + "|" + p.skip), ["5|bridge.stuck", "5|bridge.stuck", "5|bridge.stuck"]);
  assert.equal(d.addresses, 3);
  assert.equal(d.scanned, 3);
  // combined: claimable 100 + 500, likely 40; the blocked bridge and the low hint stay out of both
  assert.equal(d.totals.claimable_usd, 600);
  assert.equal(d.totals.likely_usd, 40);
  assert.equal(d.totals.holdings_usd, 10);
  assert.equal(d.totals.findings, 5);
  assert.deepEqual(d.totals.by_bucket, {
    you_can_claim: { findings: 3, usd: 640, unpriced: 0 },
    team_must_release: { findings: 1, usd: 70, unpriced: 0 },
    may_not_work: { findings: 1, usd: 9, unpriced: 0 },
  });
  // findings: biggest first across wallets, low hints last, each with its address and bucket
  assert.deepEqual(d.findings.map((x) => [x.address, x.usd, x.bucket]), [[S1, 500, "you_can_claim"], [E1, 100, "you_can_claim"], [E1, 40, "you_can_claim"], [E2, 70, "team_must_release"], [S1, 9, "may_not_work"]]);
  assert.deepEqual(d.holdings.map((h) => h.address), [E1]);
  // per wallet: its own totals and sources; S1 had a failed source, so the whole answer is partial
  assert.deepEqual(d.wallets.map((w) => [w.address, w.kind, w.status, w.partial, w.totals.claimable_usd, w.findings]), [[E1, "evm", "scanned", false, 100, 2], [S1, "solana", "scanned", true, 500, 2], [E2, "evm", "scanned", false, 0, 1]]);
  assert.equal(d.wallets[1].sources["sol.assets"], "error: upstream 500");
  assert.equal(d.partial, true);
  assert.equal(d.totals.partial, true);
  assert.deepEqual(d.failed_sources, [{ address: S1, id: "sol.assets", reason: "upstream 500" }]);
  assert.match(d.warning, /1 source failed on 1 wallet/);
  assert.deepEqual(d.not_scanned, []);
  assert.equal(d.spam_hidden, 3);
  assert.deepEqual(d.deadlines_open, [{ id: "x" }]);
});

test("scanWallets: no failed source and every wallet scanned = not partial", async () => {
  const d = await COMPOSE.scanWallets({ addresses: [E1, E2] }, fakeCtx());
  assert.equal(d.partial, false);
  assert.equal(d.totals.partial, false);
  assert.equal(d.warning, undefined);
});

test("scanWallets: at most 3 scans at a time", async () => {
  const many = {};
  const list = Array.from({ length: 4 }, (_, i) => `0x${String(i + 1).padStart(40, "0")}`);
  for (const a of list) many[a] = scanAnswer(a, []);
  const ctx = fakeCtx({ delay: () => 30, answers: many });
  const d = await COMPOSE.scanWallets({ addresses: list }, ctx);
  assert.equal(d.scanned, 4);
  assert.equal(ctx.st.peak, Math.min(3, WALLETS.concurrency));
});

test("scanWallets: a wallet not done in the time budget is listed as not scanned, a failed scan as failed", async () => {
  // E1 is slow, S1 answers, E2 has no answer (its scan fails); S2 never starts: the budget is gone by then
  const answers = { ...ANSWERS, [E2]: undefined, [S2]: scanAnswer(S2, []) };
  const ctx = fakeCtx({ answers, delay: (a) => (a === E1 ? 2000 : a === S2 ? 1 : 20) });
  const t0 = Date.now();
  const d = await COMPOSE.scanWallets({ addresses: [E1, S1, E2, S2], budget_s: "0.3" }, ctx);
  assert.ok(Date.now() - t0 < 1500, "the answer does not wait for the slow scan");
  assert.equal(d.time_budget_s, 0.3);
  assert.deepEqual(d.wallets.map((w) => [w.address, w.status]), [[E1, "not_scanned"], [S1, "scanned"], [E2, "failed"], [S2, "scanned"]]);
  assert.match(d.wallets[0].reason, /not finished within/);
  assert.match(d.wallets[2].reason, /step scan.evm failed/);
  assert.deepEqual(d.not_scanned.map((x) => x.address), [E1, E2]);
  assert.equal(d.totals.claimable_usd, 500);
  assert.equal(d.partial, true);
  assert.match(d.warning, /2 wallets were not scanned/);
  // a wallet whose turn comes after the budget ended is never started
  const late = fakeCtx({ delay: () => 400 });
  const d2 = await COMPOSE.scanWallets({ addresses: [E1, S1, E2, S2], budget_s: "0.2" }, late);
  assert.equal(late.st.calls.length, 3);
  assert.equal(d2.wallets[3].status, "not_scanned");
  assert.match(d2.wallets[3].reason, /ran out before this wallet started/);
});

test("scanWallets: the time budget never goes over WALLETS_BUDGET_S", async () => {
  const d = await COMPOSE.scanWallets({ addresses: E1, budget_s: "99999" }, fakeCtx());
  assert.equal(d.time_budget_s, WALLETS.budgetS);
});

// ---- through the engine ------------------------------------------------------------------------------------
const { callRoute, REG_BY_ID } = await import("../engine.mjs");
const call = (params) => callRoute(REG_BY_ID.get("scan.wallets"), params);

test("engine: a bad list is refused before any scan; a list string, an array or params with it all scan", async () => {
  // a bad address or too many addresses: 400 before any scan runs
  await assert.rejects(call({ addresses: `${E1},hello` }), (e) => e.status === 400);
  await assert.rejects(call({ addresses: [E1, E2, S1, S2, "0x0000000000000000000000000000000000000001"] }), (e) => e.status === 400 && /max 4 addresses/.test(e.error));
  // 2 addresses (3 sent, one a duplicate); the stubbed upstreams fail, so the scans are partial
  const r = await call({ addresses: `${E1},${S1},${E1.toLowerCase()}` });
  assert.equal(r.status, 200);
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.wallets.map((w) => w.address), [E1, S1]);
  assert.ok(r.data.findings.every((x) => x.address));
  const a = await call({ addresses: [E2, S2] });
  assert.equal(a.ok, true);
  assert.equal(a.data.addresses, 2);
  const o = await call({ addresses: [E1, E2, S1, S2], skip: "bridge.stuck" });
  assert.equal(o.ok, true);
  assert.equal(o.data.addresses, 4);
  assert.equal(o.data.wallets[0].sources["bridge.stuck"], "skipped");
});
