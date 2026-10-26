// nonevm-ton.test.mjs - TON (nonevm/ton.mjs): UTONIC uTON withdrawals and held uTON, TON + jetton holdings, and one
// scan.ton, replayed on real tonapi / DefiLlama answers captured 2026-10-22 (test/fixtures/nonevm-ton-*.json)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as F from "../findings.mjs";
import { tonUtonic, tonHoldings, cellAddress, UTON } from "../nonevm/ton.mjs";
import { addressKind } from "../nonevm/address.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
// a recorded call is matched by route id + params; edit(rows) may change a recorded answer first
const replay = (name, edit) => {
  const rows = fx(name);
  if (edit) edit(rows);
  const k = (id, p) => `${id}|${JSON.stringify(p || {})}`;
  const m = new Map(rows.map((r) => [k(r.id, r.params), r]));
  return {
    live: () => true, local: () => [],
    call: async (id, p) => { const r = m.get(k(id, p)); if (!r) throw { error: `no fixture for ${id} ${JSON.stringify(p)}` }; return { status: r.status, ok: r.status >= 200 && r.status < 300 && !r.data?.error, data: r.data }; },
  };
};
const NOW = Date.parse("2026-10-22T20:20:00Z"); // when the fixtures were recorded: the uTON price and the unlocks depend on it
const W = "0:307220f8da037ced06a53ae3374835d2443308aa7623be4f6ab0452cead5a3ab"; // 14 burns (13 never claimed) + 514,786 uTON held
const SMALL = "0:27b42611f266848924e0d967a0badc6686d6fdba669f49fce0b64d3589e4c451"; // 5.44 uTON held, never burned

test("ton address: EQ, UQ and raw forms of one wallet are the same raw address", () => {
  for (const a of ["EQAwciD42gN87QalOuM3SDXSRDMIqnYjvk9qsEUs6tWjq70d", "UQAwciD42gN87QalOuM3SDXSRDMIqnYjvk9qsEUs6tWjq-DY", W]) assert.equal(addressKind(a).address, W);
  assert.equal(addressKind("UQAwciD42gN87QalOuM3SDXSRDMIqnYjvk9qsEUs6tWjq-rW"), null); // bad crc16
});

test("cellAddress reads the address out of a get method's one-cell BOC", () => {
  assert.equal(cellAddress("b5ee9c7201010101002400004380175a1cbf8aeb2f8ee0646522b909df04252278d13c4093ba8478cc9d3f9e1451f0"), "0:bad0e5fc57597c7703232915c84ef8212913c689e2049dd423c664e9fcf0a28f");
  assert.equal(cellAddress("00"), null);
});

test("utonic: burned withdrawals never claimed and held uTON wait on the team while the proxy reserve is short (low, team_must_release)", async () => {
  const d = await tonUtonic({ address: W }, replay("nonevm-ton-utonic-withdrawals"), { now: NOW });
  assert.deepEqual(d.errors, []);
  assert.equal(d.reserve_ton, 9.004);
  assert.equal(d.price_ton, 1.066386);
  const w = d.items.filter((i) => i.asset === "TON");
  assert.equal(w.length, 13); // withdrawal #2 is finished
  assert.ok(!w.some((i) => /withdrawal #2:/.test(i.detail)));
  const out = F.hfClaims(d, { source: "ton.utonic" });
  assert.equal(out.length, 14);
  for (const f of out) {
    assert.equal(f.category, "unstake_ready");
    assert.equal(f.chain, "ton");
    assert.equal(f.confidence, "low");
    assert.equal(F.bucketOf(f), "team_must_release");
    assert.match(f.action, /until the UTONIC team acts: its withdrawal proxy .* holds 9 TON/);
    assert.equal(f.how_to_claim, "https://utonic.org");
  }
  const big = out.find((f) => /withdrawal #13:/.test(f.detail));
  assert.equal(big.amount, 53143.55);
  assert.match(big.detail, /50000 uTON burned 2026-09-15 at 1\.062871 TON each, unlocked 2026-09-18, never claimed/);
  const held = out.find((f) => f.asset === "uTON");
  assert.equal(held.token, UTON.master);
  assert.equal(held.amount, 514786.715046);
  assert.ok(held.usd > 600000 && held.usd < 800000, `usd ${held.usd}`);
  // hints stay out of the totals but show in the team bucket
  const s = F.summarize(out, []);
  assert.equal(s.totals.claimable_usd, 0);
  assert.equal(s.totals.likely_usd, 0);
  assert.equal(s.totals.by_bucket.team_must_release.findings, 14);
});

test("utonic: with enough TON in the proxy, an unlocked withdrawal is ready (high) and held uTON pending (medium)", async () => {
  const rich = (rows) => { for (const r of rows) if (r.id === "ton.account") r.data = { ...r.data, balance: 10 ** 16 }; };
  const d = await tonUtonic({ address: W }, replay("nonevm-ton-utonic-withdrawals", rich), { now: NOW });
  const out = F.hfClaims(d, { source: "ton.utonic" });
  const ready = out.filter((f) => f.asset === "TON");
  assert.equal(ready.length, 13);
  for (const f of ready) {
    assert.equal(f.confidence, "high");
    assert.equal(F.bucketOf(f), "you_can_claim");
    assert.match(f.action, /press Claim on this withdrawal in the UTONIC app/);
  }
  assert.equal(out.find((f) => f.asset === "uTON").confidence, "medium");
  // before the unlock a withdrawal is pending, not ready
  const early = await tonUtonic({ address: W }, replay("nonevm-ton-utonic-withdrawals", rich), { now: Date.parse("2026-09-12T00:00:00Z") });
  assert.ok(early.items.filter((i) => i.asset === "TON").every((i) => i.status === "pending" && /press Claim in the UTONIC app after 2026-09-1\d/.test(i.action)));
});

test("utonic: a small uTON balance the reserve covers is a medium unstake row at the app's price", async () => {
  const d = await tonUtonic({ address: SMALL }, replay("nonevm-ton-utonic-small"), { now: NOW });
  const [f] = F.hfClaims(d, { source: "ton.utonic" });
  assert.equal(f.asset, "uTON");
  assert.equal(f.amount, 5.441556);
  assert.equal(f.confidence, "medium");
  assert.equal(f.usd, 7.63);
  assert.match(f.action, /unstake \(burn\) the uTON in the UTONIC app, wait 3 days, then press Claim/);
  assert.match(f.detail, /worth 5\.8028 TON at the app's price of 1\.066386 TON per uTON; uTON has no market/);
});

test("utonic: a wallet that never held uTON has no row; a non-TON address is a 400", async () => {
  const d = await tonUtonic({ address: "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N" }, replay("nonevm-ton-utonic-empty"), { now: NOW });
  assert.deepEqual(d.items, []);
  await assert.rejects(tonUtonic({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("nonevm-ton-utonic-empty")), (e) => e.status === 400);
  await assert.rejects(tonHoldings({ address: "nope" }, replay("nonevm-ton-holdings")), (e) => e.status === 400);
});

test("holdings: TON priced on DefiLlama, whitelisted jettons, no uTON (ton.utonic has it), no blacklisted or unpriced spam", async () => {
  const d = await tonHoldings({ address: "0:0b988dba1f04d5a2a23dfae802fab33297a6cd015cbb4769d8607b636442def8" }, replay("nonevm-ton-holdings"));
  assert.deepEqual(d.errors, []);
  const ton = d.holdings.find((h) => h.asset === "TON");
  assert.equal(ton.amount, 1.383659);
  assert.ok(ton.usd > 1 && ton.usd < 3);
  assert.equal(ton.verified, true);
  assert.ok(!d.holdings.some((h) => h.asset === "uTON"));
  assert.ok(!d.holdings.some((h) => /ton-locked/.test(h.detail)));
  assert.equal(d.holdings.find((h) => h.asset === "STON").usd, 5.69);
  assert.ok(d.holdings.every((h) => h.verified && h.kind === "token" && h.chain === "ton"));
  const empty = await tonHoldings({ address: "0:ae87b8e4b9bdb6a9d77f4ec0b3a0e3e2b0e3c2a1b4d5e6f708192a3b4c5d6e7f" }, replay("nonevm-ton-holdings-empty"));
  assert.deepEqual(empty, { items: [], holdings: [], errors: [] });
});

test("scan.ton: the source routes in one answer, the pasted UQ form kept, team rows out of the totals", async () => {
  const { COMPOSE } = await import("../compose.mjs");
  const d = await COMPOSE.scanTon({ address: "UQAwciD42gN87QalOuM3SDXSRDMIqnYjvk9qsEUs6tWjq-DY" }, replay("nonevm-ton-scan"));
  assert.equal(d.kind, "ton");
  assert.equal(d.address, W);
  assert.equal(d.friendly, "UQAwciD42gN87QalOuM3SDXSRDMIqnYjvk9qsEUs6tWjq-DY");
  assert.equal(d.partial, false);
  assert.deepEqual(d.sources, { "ton.utonic": "ok", "ton.holdings": "ok" });
  assert.equal(d.findings.length, 14);
  assert.equal(d.totals.claimable_usd, 0);
  assert.equal(d.totals.by_bucket.team_must_release.findings, 14);
  assert.ok(d.totals.holdings_usd > 500, `holdings ${d.totals.holdings_usd}`);
  assert.ok(d.findings.every((f) => f.source === "ton.utonic" && f.bucket === "team_must_release"));
  await assert.rejects(COMPOSE.scanTon({ address: W.replace("0:", "0x") }, replay("nonevm-ton-scan")), (e) => e.status === 400);
});
