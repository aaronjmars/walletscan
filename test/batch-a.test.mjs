// batch-a.test.mjs - Parcl PRCL airdrops (airdrop.parcl), Blast app positions (rewards.blast) and the RNDR / STG
// deadlines. The compose routes replay upstream answers captured 2026-10-20 (test/fixtures/batch-a-*.json), then the
// normalizers turn them into findings
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as F from "../findings.mjs";
import { COMPOSE } from "../compose.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const OCT20 = Date.parse("2026-10-20T12:00:00Z");

// a ctx that answers each step from the recorded calls (same route + params, in recorded order)
async function replay(fn, name) {
  const rec = fx(name), queues = new Map();
  for (const c of rec.calls) {
    const k = c.id + JSON.stringify(c.params);
    queues.set(k, [...(queues.get(k) || []), c.res]);
  }
  const ctx = {
    live: () => true, local: () => [],
    call: async (id, params) => {
      const q = queues.get(id + JSON.stringify(params));
      if (!q?.length) throw new Error(`no recorded answer for ${id} ${JSON.stringify(params)}`);
      return q.shift();
    },
  };
  return COMPOSE[fn]({ address: rec.address }, ctx);
}

test("parcl: unclaimed seasons in 6-decimal units, S3 dated by its clawback, older seasons still open", async () => {
  const data = await replay("parcl", "batch-a-parcl-unclaimed.json");
  assert.deepEqual(data.errors, []);
  const out = F.parcl(data, { now: OCT20 });
  assert.deepEqual(out.map((f) => f.amount), [81027, 67400, 44455.952]);
  assert.ok(out.every((f) => f.confidence === "high" && f.asset === "PRCL" && f.chain === "solana" && /^claim the Parcl/.test(f.action)));
  const [s3, s2, initial] = out;
  assert.equal(s3.deadline, "2026-10-28");
  assert.equal(s2.deadline, null);
  assert.match(initial.detail, /never claimed; clawback allowed since 2025-01-01 but nothing was clawed back yet/);
  assert.equal(Math.round(s3.usd), Math.round(81027 * data.price));
});

test("parcl: a claimed season pays only its vested part not withdrawn; fully withdrawn seasons drop out", async () => {
  const data = await replay("parcl", "batch-a-parcl-vested.json");
  const out = F.parcl(data, { now: OCT20 });
  const s2 = out.find((f) => /S2/.test(f.action));
  assert.equal(s2.amount, 20921.329171); // locked 25,135 - withdrawn 4,213.670829
  assert.match(s2.action, /^withdraw the vested PRCL from your Parcl Points S2 claim/);
  assert.match(s2.detail, /claimed, vested part never withdrawn/);
  assert.equal(out.length, 2); // + S3 never claimed; initial, S1 and HOA were fully withdrawn
  assert.equal(out.find((f) => f.deadline === "2026-10-28").amount, 72124);
});

test("parcl: a wallet that took everything has no findings", async () => {
  const data = await replay("parcl", "batch-a-parcl-claimed.json");
  assert.deepEqual(F.parcl(data, { now: OCT20 }), []);
});

test("parcl: past the S3 clawback date it stays claimable until clawed back; clawed-back or underfunded seasons", async () => {
  const data = await replay("parcl", "batch-a-parcl-unclaimed.json");
  const later = F.parcl(data, { now: Date.parse("2026-11-01") });
  assert.equal(later[0].deadline, null);
  assert.match(later[0].detail, /clawback allowed since 2026-10-28/);
  const gone = { ...data, items: data.items.map((i) => (i.season === "s3" ? { ...i, clawed_back: true } : i.season === "s2" ? { ...i, vault_balance: 1000 } : i)) };
  const out = F.parcl(gone, { now: OCT20 });
  assert.equal(out.length, 2);
  const s2 = out.find((f) => f.amount === 67400);
  assert.equal(s2.confidence, "medium");
  assert.match(s2.detail, /vault holds only 1000 PRCL/);
});

test("blast: Pac deposit with cash and no loan = high, dated by Blast's app withdrawal end", async () => {
  const data = await replay("blastApps", "batch-a-blast-pac.json");
  const [f, ...rest] = F.blastApps(data, { now: OCT20 });
  assert.equal(rest.length, 0);
  assert.equal(f.category, "unstake_ready");
  assert.equal(f.chain, "blast");
  assert.equal(f.asset, "ezETH");
  assert.equal(f.amount, 1.357986);
  assert.equal(f.confidence, "high");
  assert.equal(f.deadline, "2026-10-26");
  assert.match(f.action, /^withdraw ezETH from Pac Finance, then bridge it to Ethereum before 2026-10-26/);
  assert.ok(f.usd > 3000 && f.usd < 4500);
});

test("blast: Orbit oTokens scaled by the exchange rate; a loan nets the usd and makes it medium", async () => {
  const data = await replay("blastApps", "batch-a-blast-orbit.json");
  const [f] = F.blastApps(data, { now: OCT20 });
  const item = data.items[0];
  assert.equal(f.amount, 37.966528); // 186,669.5 oETH x exchangeRate 0.000203389
  assert.equal(f.confidence, "medium");
  assert.ok(Math.abs(f.usd - (item.supply_usd - item.debt_usd)) < 0.01);
  assert.match(f.action, /^repay the loan, then withdraw ETH from Orbit Lending/);
  assert.match(f.detail, /loan of 40058\.\d+ USDB locks the deposit/);
});

test("blast: a market with no cash left is low; loans worth more than the deposits leave nothing", async () => {
  const nocash = F.blastApps(await replay("blastApps", "batch-a-blast-nocash.json"), { now: OCT20 });
  const weth = nocash.find((f) => f.asset === "WETH");
  assert.equal(weth.confidence, "low");
  assert.equal(weth.usd, 0);
  assert.match(weth.detail, /no WETH cash left/);
  const usdb = nocash.find((f) => f.asset === "USDB");
  assert.equal(usdb.confidence, "medium");
  assert.ok(usdb.usd < 1); // 0.6 USDB of cash for a 134k USDB deposit
  const under = F.blastApps(await replay("blastApps", "batch-a-blast-underwater.json"), { now: OCT20 }).find((f) => f.asset === "DETH");
  assert.equal(under.confidence, "low");
  assert.match(under.detail, /are worth more than the Pac Finance deposits/);
});

test("blast: Thruster LP NFTs become token amounts from liquidity and the pool price", async () => {
  const out = F.blastApps(await replay("blastApps", "batch-a-blast-thruster.json"), { now: OCT20 });
  assert.equal(out.length, 2);
  const lp = out.find((f) => f.asset === "USDB/USDe LP");
  assert.equal(lp.amount, null);
  assert.equal(lp.confidence, "high");
  assert.match(lp.detail, /^43\.6\d+ USDB \+ 51\.1\d+ USDe; Thruster v3 position #112286/);
  assert.ok(lp.usd > 90 && lp.usd < 100);
  assert.match(lp.action, /^remove the Thruster liquidity/);
});

test("blast: after the app deadline the action points to the L1 bridge contracts", async () => {
  const [f] = F.blastApps(await replay("blastApps", "batch-a-blast-pac.json"), { now: Date.parse("2026-11-02") });
  assert.match(f.action, /exit through the Blast bridge contracts on Ethereum \(Blast app withdrawals ended 2026-10-26\)/);
  assert.match(f.detail, /Blast bridge contracts on Ethereum directly/);
  assert.equal(f.expired, undefined);
});

test("deadlines: RNDR and STG balances become token migrations, STG with its 2026-12-15 close on every chain", () => {
  const dl = fx("../../data/deadlines.json");
  const row = (chain, address, symbol, value) => ({ attributes: { value, quantity: { numeric: "100" }, fungible_info: { symbol, flags: { verified: true }, implementations: [{ chain_id: chain, address }] } }, relationships: { chain: { data: { id: chain } } } });
  const ans = { data: [
    row("ethereum", "0x6de037ef9ad2725eb40118bb1702ebb27e4aeb24", "RNDR", 185),
    row("ethereum", "0xaf5191b0de278c7286d6c7cc6ab6bb8a73ba2cd6", "STG", 17),
    row("arbitrum", "0x6694340fc020c5e6b96567843da2df01b2ce1eb6", "STG", 17),
  ] };
  const { findings } = F.zerionHoldings(ans, { deadlines: dl });
  assert.equal(findings.length, 3);
  assert.ok(findings.every((f) => f.category === "token_migration" && f.confidence === "high"));
  const [rndr, stg, stgArb] = findings;
  assert.equal(rndr.deadline, null);
  assert.equal(rndr.how_to_claim, "https://upgrade.rendernetwork.com");
  assert.equal(stg.deadline, "2026-12-15");
  assert.equal(stg.action, "migrate before 2026-12-15");
  assert.match(stgArb.detail, /STG on Arbitrum is bridged to Ethereum first/);
  assert.equal(new Set(dl.map((d) => d.id)).size, dl.length);
});
