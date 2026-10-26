// buckets.test.mjs - who must act on a finding: bucketOf on rows made by the real normalizers, one fixture per
// bucket, and totals.by_bucket next to the unchanged claimable_usd / likely_usd
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../findings.mjs";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const row = (o) => ({ chain: "ethereum", asset: "ETH", amount: 1, action: "claim it", how_to_claim: null, deadline: null, source: "test", detail: null, ...o });

// you_can_claim: the source says claimable now (high), or our estimate the wallet can act on (medium)
const lido = row({ category: "unstake_ready", usd: 2000, confidence: "high", action: "claim 1 finished Lido withdrawal" });
const zerionReward = row({ category: "reward", usd: 300, confidence: "medium", action: "collect in Aave" });
// team_must_release: a bridge exit only its team can unblock
const [blocked] = F.stuck({ items: [{ status: "blocked", key: "polygon", bridge: "Polygon PoS", symbol: "USDC", value: "500", usd: 500, tx: "0xabc" }] });
// team_must_release: a sunset chain with no exit path (window not closed, balance read)
const noExit = F.chainSweep({ sunset: [{ chain: "deadl3", chain_id: 9999, name: "Dead L3", status: "shut_down", closes: null, exit: "Nothing known: RPC is down and no exit path was announced.", read: "explorer", balances: [{ asset: "ETH", amount: 0.5, usd: 1000, verified: true }] }] }).findings[0];
// team_must_release: an airdrop whose claim has not opened yet (the distributor is not live)
const [notOpen] = F.jupiterAirdrops([{ airdrops: [{ id: "foo-s1", emitterName: "Foo", status: "upcoming", claimStart: NOW + 7 * 86400000, items: [{ isEligible: true, isClaimed: false, amount: "100", value: 40, label: "FOO", address: "FooMint1111111111111111111111111111111111111" }] }] }], { now: NOW });
// team_must_release: a dead DeFi token whose market holds nothing to pay out
const [emptyMarket] = F.deadDefi({ items: [{ category: "token_migration", chain: "ethereum", asset: "aDAI v1", token: "0xfC1E690f61EFd961294b3e1Ce3313fBD8aa4f85d", amount: 50, usd: 50, valued_by: "contract", status: "redeemable", liquidity: "none", protocol: "Aave v1", action: "redeem aDAI v1", detail: "the market holds no underlying to pay it out now" }] });
// may_not_work: the exit window already closed
const closed = F.chainSweep({ sunset: [{ chain: "heco", chain_id: 128, name: "HECO", status: "shut_down", closes: "2025-01-10", exit: "None now: the window closed.", read: "rpc", balances: [{ asset: "HT", amount: 10, usd: 20, verified: true }] }] }).findings[0];
// may_not_work: a low hint (on a list whose claim we cannot read)
const [hint] = F.airdropIndex({ items: [{ status: "unknown", chain: "ethereum", name: "Bar", symbol: "BAR", amount: 5, usd: 25, source: "rotki", id: "bar" }] }, { now: NOW });

test("bucketOf: you_can_claim = high or medium rows the wallet can act on", () => {
  assert.equal(F.bucketOf(lido), "you_can_claim");
  assert.equal(F.bucketOf(zerionReward), "you_can_claim");
});

test("bucketOf: team_must_release = blocked bridge, sunset chain with no exit, claim not open, empty market", () => {
  assert.equal(blocked.category, "bridge_blocked");
  assert.equal(F.bucketOf(blocked), "team_must_release");
  assert.equal(noExit.confidence, "medium");
  assert.equal(F.bucketOf(noExit), "team_must_release");
  assert.equal(notOpen.confidence, "low"); // low, but the money is there: the team has to open the claim
  assert.equal(F.bucketOf(notOpen), "team_must_release");
  assert.equal(emptyMarket.confidence, "low");
  assert.equal(F.bucketOf(emptyMarket), "team_must_release");
  // a sunset exit that was already done for the holder is not a team ask
  assert.equal(F.bucketOf(row({ category: "bridge_stuck", confidence: "medium", usd: 5, action: "Nothing to do on Geist: assets were re-minted on Base" })), "you_can_claim");
});

test("bucketOf: may_not_work = closed windows and low hints", () => {
  assert.equal(closed.expired, true);
  assert.equal(F.bucketOf(closed), "may_not_work");
  assert.equal(F.bucketOf({ ...blocked, expired: true }), "team_must_release"); // a blocked exit stays the team's
  assert.equal(hint.confidence, "low");
  assert.equal(F.bucketOf(hint), "may_not_work");
});

test("summarize: bucket on every finding, by_bucket totals, claimable_usd / likely_usd unchanged", () => {
  const all = [lido, zerionReward, blocked, noExit, notOpen, emptyMarket, closed, hint];
  const s = F.summarize(all, [], { minUsd: 1 });
  assert.equal(s.findings.length, 8);
  assert.ok(s.findings.every((f) => F.BUCKETS.includes(f.bucket)));
  assert.equal(all.some((f) => "bucket" in f), false, "the input rows are not changed");
  // the headline totals are what they were before buckets: high 2000; medium 300 + the no-exit sunset balance 1000
  assert.equal(s.totals.claimable_usd, 2000);
  assert.equal(s.totals.likely_usd, 1300);
  assert.deepEqual(s.totals.by_bucket, {
    you_can_claim: { findings: 2, usd: 2300, unpriced: 0 },
    team_must_release: { findings: 4, usd: 1590, unpriced: 0 },
    may_not_work: { findings: 2, usd: 45, unpriced: 0 },
  });
});

test("summarize: a migration row already counted in holdings adds nothing to its bucket", () => {
  const mig = row({ category: "token_migration", chain: "ethereum", token: "0xaaaa", usd: 70, confidence: "high", source: "holdings.zerion" });
  const s = F.summarize([mig], [{ kind: "token", chain: "ethereum", token: "0xaaaa", usd: 70, verified: true }]);
  assert.equal(s.findings[0].bucket, "you_can_claim");
  assert.deepEqual(s.totals.by_bucket.you_can_claim, { findings: 1, usd: 0, unpriced: 0 });
  assert.equal(s.totals.claimable_usd, 0);
});
