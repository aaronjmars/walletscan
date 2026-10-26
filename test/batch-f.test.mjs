// batch-f.test.mjs - Balancer pool shares (rewards.balancer) and Aerodrome / Velodrome veNFTs (rewards.ve_nfts):
// compose functions replayed on real answers captured 2026-10-20 (test/fixtures/batch-f-*.json), then the normalizers
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { FORGOTTEN } from "../forgotten/index.mjs";
import { resetV1Pools } from "../forgotten/balancer.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const sha = (b) => createHash("sha1").update(JSON.stringify(b)).digest("hex");
// a recorded call is matched by route id + params + body sha; live(id) says which routes count as configured
const replay = (name, { alchemy = true } = {}) => {
  const k = (id, p, sh) => `${id}|${JSON.stringify(p || {})}|${sh || ""}`;
  const m = new Map(fx(name).map((r) => [k(r.id, r.params, r.body_sha), r]));
  return {
    live: (id) => alchemy || !/alchemy/.test(id), local: () => [],
    call: async (id, p, over = {}) => { const r = m.get(k(id, p, over.body == null ? "" : sha(over.body))); if (!r) throw { error: `no fixture for ${id}` }; return { status: r.status, ok: r.status >= 200 && r.status < 300 && !r.data?.error, data: r.data }; },
  };
};

// ---- rewards.balancer ----
test("balancer: BPT staked in a v3 gauge is read back onchain and valued at its two legs", async () => {
  const d = await FORGOTTEN.balancerPools({ address: "0xb62ade0f6b8969962414125142960a82735470cd" }, replay("batch-f-balancer", { alchemy: false }));
  assert.deepEqual(d.errors, []);
  assert.match(d.note, /ALCHEMY_API_KEY/);
  assert.equal(d.items.length, 1);
  const [i] = d.items;
  assert.equal(i.protocol, "Balancer v3");
  assert.equal(i.where, "GAUGE");
  assert.equal(i.staked_in, "0x62a66eb9abf7a788f48d0ce7c0c065df9e09da19");
  assert.equal(i.confirmed, true);
  assert.equal(i.amount, 42.732623);
  assert.deepEqual(i.legs.map((l) => l.asset), ["waEthWETH", "rETH"]);
  assert.ok(i.usd > 100000 && i.usd < 115000, `usd ${i.usd}`);
  const [f] = F.balancer(d);
  assert.equal(f.category, "unstake_ready");
  assert.equal(f.confidence, "high");
  assert.equal(f.deadline, "2026-10-30");
  assert.equal(f.source, "rewards.balancer");
  assert.match(f.action, /^unstake from the gauge, then remove the liquidity before 2026-10-30$/);
  assert.match(f.detail, /withdraw-only on 2026-10-30/);
  assert.equal(f.token, undefined); // a staked row is not a wallet token
});

test("balancer: BPT in the wallet is a token_migration row carrying the BPT address", async () => {
  const d = await FORGOTTEN.balancerPools({ address: "0x24faf482304ed21f82c86ed5feb0ea313231a808" }, replay("batch-f-balancer", { alchemy: false }));
  const [i] = d.items;
  assert.equal(i.protocol, "Balancer v2");
  assert.equal(i.asset, "B-80BAL-20WETH");
  assert.equal(i.where, "wallet");
  const [f] = F.balancer(d);
  assert.equal(f.category, "token_migration");
  assert.equal(f.token, "0x5c6ee304399dbdb9c8ef030ab642b10820db8f56");
  assert.equal(f.confidence, "high");
  assert.match(f.detail, /BAL \+ .* WETH/);
});

test("balancer: a v1 pool found through the BFactory logs, legs read from the pool, no deadline", async () => {
  resetV1Pools();
  const d = await FORGOTTEN.balancerPools({ address: "0x821a96fbd4465d02726edbaa936a0d6d1032de46" }, replay("batch-f-balancer-v1"));
  assert.deepEqual(d.errors, []);
  const v1 = d.items.find((i) => i.protocol === "Balancer v1");
  assert.equal(v1.token, "0x59a19d8c652fa0284f44113d0ff9aba70bd46fb4");
  assert.equal(v1.deadline, null);
  assert.deepEqual(v1.legs.map((l) => l.asset), ["BAL", "WETH"]);
  assert.ok(v1.usd > 5000, `usd ${v1.usd}`);
  const f = F.balancer(d).find((x) => x.protocol === "Balancer v1");
  assert.equal(f.confidence, "high");
  assert.equal(f.deadline, null);
  assert.match(f.how_to_claim, /etherscan\.io\/address\/0x59a19d8c652fa0284f44113d0ff9aba70bd46fb4#writeContract/);
  resetV1Pools();
});

test("balancer normalizer: unpriced legs = medium, no price = low, API-only amount = medium, priced dust dropped", () => {
  const row = (o) => ({ category: "token_migration", chain: "base", protocol: "Balancer v2", asset: "BPT", token: "0xAB", amount: 1, usd: 50, legs: [], unpriced: 0, confirmed: true, deadline: "2026-10-30", action: "remove the liquidity (exit the pool)", how_to_claim: "https://balancer.fi", detail: "d", ...o });
  const out = F.balancer({ items: [row({ asset: "OK" }), row({ asset: "PART", unpriced: 1 }), row({ asset: "NONE", usd: null }), row({ asset: "API", confirmed: false }), row({ asset: "DUST", usd: 0.2 }), row({ asset: "ZERO", amount: 0 })] });
  const by = Object.fromEntries(out.map((f) => [f.asset, f]));
  assert.deepEqual(Object.keys(by).sort(), ["API", "NONE", "OK", "PART"]);
  assert.equal(by.OK.confidence, "high");
  assert.equal(by.OK.token, "0xab");
  assert.equal(by.PART.confidence, "medium");
  assert.match(by.PART.detail, /1 leg without a trusted price/);
  assert.equal(by.NONE.confidence, "low");
  assert.equal(by.API.confidence, "medium");
});

test("dropBalancerTwins: Zerion's Balancer deposit / staked rows and its deadline row go once rewards.balancer answered", () => {
  const run = {
    sources: { "rewards.balancer": "ok" },
    holdings: [
      { kind: "staked", chain: "ethereum", protocol: "Balancer V3", asset: "rETH", amount: 18, usd: 53000 },
      { kind: "deposit", chain: "arbitrum", protocol: "Aura", asset: "WETH", amount: 1, usd: 2500 },
      { kind: "locked", chain: "ethereum", protocol: "Balancer", asset: "B-80BAL-20WETH", amount: 10, usd: 8 },
      { kind: "token", chain: "ethereum", asset: "USDC", amount: 5, usd: 5 },
    ],
    findings: [
      { source: "rewards.balancer", category: "unstake_ready", chain: "ethereum", protocol: "Balancer v3", how_to_claim: "https://balancer.fi/pools/ethereum/v3/0x1" },
      { source: "rewards.zerion", category: "token_migration", chain: "ethereum", protocol: "Balancer V3", deadline: "2026-10-30" },
      { source: "rewards.zerion", category: "reward", chain: "ethereum", protocol: "Balancer V3", asset: "BAL" },
    ],
  };
  const out = F.dropBalancerTwins(run);
  assert.deepEqual(out.holdings.map((h) => h.kind), ["deposit", "locked", "token"]); // Aura stays: no Aura stake found
  assert.deepEqual(out.findings.map((f) => `${f.source}:${f.category}`), ["rewards.balancer:unstake_ready", "rewards.zerion:reward"]);
  assert.equal(F.dropBalancerTwins({ ...run, sources: { "rewards.balancer": "error" } }).holdings.length, 4); // our read failed: Zerion's rows stay
});

test("balancer: a non-EVM address is a 400", async () => {
  await assert.rejects(FORGOTTEN.balancerPools({ address: "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq" }, replay("batch-f-balancer")), (e) => e.status === 400);
});

// ---- rewards.ve_nfts ----
test("ve_nfts: a permanent veAERO lock's unclaimed fees + bribes are summed per token; its rebase goes into the lock", async () => {
  const d = await FORGOTTEN.veNfts({ address: "0x24e9cbb9ddda1247ae4b4eeee3c569a2190ac401" }, replay("batch-f-venft"));
  assert.deepEqual(d.errors, []);
  const usdc = d.items.find((i) => i.asset === "USDC");
  assert.equal(usdc.protocol, "Aerodrome");
  assert.equal(usdc.kind, "fees+bribes");
  assert.deepEqual(usdc.venft_ids, ["10"]);
  assert.ok(usdc.amount > 100);
  const rebase = d.items.find((i) => i.kind === "rebase");
  assert.equal(rebase.into_lock, true);
  assert.ok(rebase.amount > 900);
  const f = F.veNfts(d);
  assert.equal(f.find((x) => x.asset === "USDC").confidence, "high");
  assert.equal(f.find((x) => x.asset === "USDC").source, "rewards.ve_nfts");
  assert.equal(f.find((x) => x.asset === "AERO").confidence, "medium"); // the rebase is locked
});

test("ve_nfts: an ended (not permanent) veAERO lock is unstake_ready", async () => {
  const d = await FORGOTTEN.veNfts({ address: "0xb4db12c2939c41040814f50dcf9f9bff4409347d" }, replay("batch-f-venft"));
  const ended = d.items.find((i) => i.kind === "expired_lock");
  assert.equal(ended.amount, 70.575396);
  assert.equal(ended.ends.slice(0, 10), "2025-11-13");
  assert.deepEqual(ended.venft_ids, ["86921"]);
  const [f] = F.veNfts({ items: [ended] });
  assert.equal(f.category, "unstake_ready");
  assert.equal(f.confidence, "high");
  assert.match(f.detail, /withdraw\(86921\)/);
  assert.equal(d.items.find((i) => i.kind === "rebase").into_lock, false); // rebase of an ended lock is paid out
});

test("ve_nfts: Velodrome on Optimism reads the same way", async () => {
  const d = await FORGOTTEN.veNfts({ address: "0x1ecea759a0fac5d2ab3af1a2d2b43772558b3581" }, replay("batch-f-venft"));
  assert.deepEqual(d.errors, []);
  const r = d.items.find((i) => i.chain === "optimism" && i.kind === "rebase");
  assert.equal(r.protocol, "Velodrome");
  assert.equal(r.asset, "VELO");
  assert.ok(r.amount > 100);
});

test("veNfts normalizer: an unpriced bribe is a low hint without usd; zero rows dropped", () => {
  const base = { category: "reward", chain: "base", protocol: "Aerodrome", kind: "bribes", asset: "X", amount: 5, usd: 10, priced: true, action: "a", how_to_claim: "https://aerodrome.finance/dash", detail: "d" };
  const [ok, spam] = F.veNfts({ items: [base, { ...base, asset: "SPAM", priced: false, usd: null }, { ...base, amount: 0 }] });
  assert.equal(ok.confidence, "high");
  assert.equal(spam.confidence, "low");
  assert.equal(spam.usd, null);
  assert.match(spam.detail, /no trusted price/);
});

test("ve_nfts: an ended Aerodrome lock replaces Zerion's locked row of the same amount (dropZerionTwins)", () => {
  const run = {
    holdings: [{ kind: "locked", chain: "base", protocol: "Aerodrome", asset: "AERO", amount: 70.6, usd: 61 }],
    findings: [{ source: "rewards.ve_nfts", category: "unstake_ready", chain: "base", protocol: "Aerodrome", asset: "AERO", amount: 70.575396, usd: 61.5 }],
  };
  assert.equal(F.dropZerionTwins(run).holdings.length, 0);
});

// ---- stuck: Lisk withdrawals (stuck/bridges/lisk.mjs) ----
const lisk = await import("../stuck/bridges/lisk.mjs");
const LISK_FX = fx("batch-f-lisk");
const S = { maturity: 604800, finality: 302400, type: 1, typeSince: 1752607223, provenTo: 38903204n };

test("lisk: index rows come from the bridge log; the messenger's own MessagePassed is not a second withdrawal", () => {
  const rows = LISK_FX.logs.map(lisk.row).filter(Boolean);
  assert.equal(rows.length, 1);
  const [block, tx, , from, to, token, amount] = rows[0];
  assert.equal(tx, "0x5d9f94a67ea5ac5005bcb7b7bca1736df411298f8becab4464849e9821defb2b");
  assert.equal(from, "0x0ad7ca0b5e514d4e6e99ff361affd4325a8ed790");
  assert.equal(to, from);
  assert.equal(token, ""); // ETH
  assert.equal(BigInt(`0x${amount}`), 50601480242096489n);
  assert.ok(block > 0);
});

test("lisk: a wallet's withdrawals are the rows it sent or receives, tokens on their Ethereum address", () => {
  const items = lisk.mine(LISK_FX.rows, "0x0AD7CA0B5E514D4E6E99FF361AFFD4325A8ED790");
  assert.equal(items.length, 1);
  assert.equal(items[0].asset.kind, "native");
  assert.equal(items[0].owner.toLowerCase(), "0x0ad7ca0b5e514d4e6e99ff361affd4325a8ed790");
  assert.equal(lisk.mine(LISK_FX.rows, "0xbAd85cBDD525D0144f8bCcaF73c249A56507a459").length, 3); // recipient of 3 of 0xc0eea677's
});

test("lisk: portal facts -> status (claimed, prove, re-prove, waiting, finalize) and the 2026-10-31 deadline", () => {
  const t = 1792540000, block = 37000000n;
  assert.equal(lisk.classify({ finalized: true }, S, block, t).status, "claimed");
  const unproven = lisk.classify({ finalized: false, proofs: 0 }, S, block, t);
  assert.equal(unproven.status, "ready-to-prove");
  assert.equal(unproven.deadline, "2026-10-31");
  assert.equal(lisk.classify({ finalized: false, proofs: 0 }, S, S.provenTo + 1n, t).status, "waiting"); // no state proposal past it yet
  const game = { finalized: false, proofs: 1, proxy: "0xg", status: 2, type: 1, createdAt: 1791000000, resolvedAt: 1791100000, blacklisted: false };
  assert.equal(lisk.classify({ ...game, provenAt: 1791000100 }, S, block, t).status, "ready-to-finalize");
  assert.equal(lisk.classify({ ...game, provenAt: 1791000100 }, S, block, t).deadline, undefined);
  assert.equal(lisk.classify({ ...game, provenAt: t - 3600 }, S, block, t).status, "waiting"); // inside the 7 days
  assert.equal(lisk.classify({ ...game, status: 0, provenAt: 1791000100 }, S, block, t).status, "waiting"); // game not resolved
  for (const bad of [{ status: 1 }, { blacklisted: true }, { createdAt: 1700000000 }, { type: 0 }]) {
    const r = lisk.classify({ ...game, provenAt: 1791000100, ...bad }, S, block, t);
    assert.equal(r.status, "ready-to-prove", JSON.stringify(bad));
    assert.match(r.detail, /prove again/);
  }
});

test("lisk: a ready-to-prove stuck item is a high bridge_stuck finding with the shutdown as deadline", () => {
  const [f] = F.stuck({ items: [{ key: "lisk", bridge: "Lisk", status: "ready-to-prove", symbol: "ETH", value: 0.0506, usd: 124.2, tx: "0x5d9f", deadline: "2026-10-31", action: "bridge.lisk.com (or Superbridge): prove it" }] });
  assert.equal(f.category, "bridge_stuck");
  assert.equal(f.chain, "ethereum");
  assert.equal(f.deadline, "2026-10-31");
  assert.equal(f.how_to_claim, "https://bridge.lisk.com");
  assert.equal(f.confidence, "high");
});
