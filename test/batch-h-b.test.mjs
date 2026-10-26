// batch-h-b.test.mjs - Karak and Polkadot gap sources (forgotten/karak.mjs, polkadot.mjs): compose functions replayed
// on real answers captured 2026-10-21 (test/fixtures/hf-karak-*, hf-k2-*, hf-dot-*), then hfClaims
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { FORGOTTEN } from "../forgotten/index.mjs";
import { le } from "../forgotten/polkadot.mjs";

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
const SUNSET = JSON.parse(readFileSync(new URL("../data/sunset-chains.json", import.meta.url), "utf8"));

// ---- rewards.karak_queue ----
test("karak queue: finished-delay withdrawals on Ethereum and Arbitrum are high unstake_ready rows in the vault's asset", async () => {
  const d = await FORGOTTEN.karakQueue({ address: "0x624d64272f738c92e2bb836ba06a26cd4c59f883" }, replay("hf-karak-queue"));
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.items.map((i) => `${i.chain}:${i.asset}:${i.nonce}`), ["ethereum:PT-rswETH-27JUN2024:0", "arbitrum:USD₮0:0", "arbitrum:PT-ezETH-27JUN2024:1"]);
  const out = F.hfClaims(d, { source: "rewards.karak_queue" });
  assert.equal(out.length, 3);
  for (const f of out) {
    assert.equal(f.category, "unstake_ready");
    assert.equal(f.protocol, "Karak");
    assert.equal(f.confidence, "high");
    assert.match(f.action, /finishWithdraw on the DelegationSupervisor 0x/);
    assert.equal(f.how_to_claim, "https://app.karak.network");
  }
  const usdt = out.find((f) => f.chain === "arbitrum" && f.token === "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9");
  assert.equal(usdt.amount, 528.15);
  assert.ok(usdt.usd > 500 && usdt.usd < 560, `usd ${usdt.usd}`);
  assert.match(usdt.detail, /delay over since 2026-04-13, never finished/);
  const total = out.reduce((s, f) => s + f.usd, 0);
  assert.ok(total > 4000 && total < 7000, `total ${total}`);
});

test("karak queue: a wallet with nothing queued has no row, and a non-EVM address is a 400", async () => {
  const d = await FORGOTTEN.karakQueue({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("hf-karak-queue-empty"));
  assert.deepEqual(d, { items: [], errors: [] });
  await assert.rejects(FORGOTTEN.karakQueue({ address: "nope" }, replay("hf-karak-queue-empty")), (e) => e.status === 400);
});

// ---- bridge.k2_claims ----
test("k2 claims: ETH left on K2 and not claimed on Ethereum is a medium bridge_stuck row with the 2027-09-12 deadline", async () => {
  const d = await FORGOTTEN.k2Claims({ address: "0xce9a2558e2586fe0981739a5a05bd50f7db1b998" }, replay("hf-k2-claims"));
  assert.equal(d.items.length, 1);
  const [f] = F.hfClaims(d, { source: "bridge.k2_claims" });
  assert.equal(f.category, "bridge_stuck");
  assert.equal(f.chain, "ethereum");
  assert.equal(f.asset, "ETH");
  assert.equal(f.amount, 5);
  assert.ok(f.usd > 5000 && f.usd < 25000, `usd ${f.usd}`);
  assert.equal(f.confidence, "medium"); // the tree is not published: the K2 balance is a floor
  assert.equal(f.deadline, "2027-09-12");
  assert.equal(f.how_to_claim, "https://k2bridge.karak.network");
  assert.match(f.action, /claimETH on Ethereum/);
  assert.match(f.detail, /claimedETH 0 on the portal 0xeeCE9CD7/);
});

test("k2 claims: rswETH on K2 is paid by claimTokens in L1 rswETH", async () => {
  const d = await FORGOTTEN.k2Claims({ address: "0xa172429884c08f4f314d19aba38bda944fa77000" }, replay("hf-k2-claims-rsweth"));
  const [f] = F.hfClaims(d, { source: "bridge.k2_claims" });
  assert.equal(f.asset, "rswETH");
  assert.equal(f.token, "0xfae103dc9cf190ed75350761e95403b7b8afa6c0");
  assert.equal(f.amount, 76.70673715);
  assert.ok(f.usd > 100000, `usd ${f.usd}`);
  assert.match(f.action, /claimTokens on Ethereum/);
});

test("k2 claims: a wallet that already claimed on Ethereum, or never used K2, has no row", async () => {
  assert.deepEqual(await FORGOTTEN.k2Claims({ address: "0x8deeffb6047b8ee91b09334eb2a4ca120f43f596" }, replay("hf-k2-claims-claimed")), { items: [], errors: [] });
  assert.deepEqual(await FORGOTTEN.k2Claims({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("hf-k2-claims-empty")), { items: [], errors: [] });
});

test("k2 sunset row: the exit names the Merkle claim path, the claim site and the guardian date", () => {
  const k2 = SUNSET.find((s) => s.id === "karak-k2");
  assert.equal(k2.link, "https://k2bridge.karak.network");
  assert.equal(k2.closes, "2027-09-12");
  assert.match(k2.exit, /claimETH/);
  assert.match(k2.exit, /claimTokens/);
  assert.doesNotMatch(k2.exit, /no claim site/i);
});

// ---- rewards.dot_sale ----
test("dot sale: an unclaimed 2017 allocation is a high DOT row on Polkadot plus the KSM row on Kusama", async () => {
  const d = await FORGOTTEN.dotSale({ address: "0x006e514cf3312db766b10f6ddc624518b8e02618" }, replay("hf-dot-sale"));
  assert.deepEqual(d.errors, []);
  const out = F.hfClaims(d, { source: "rewards.dot_sale" });
  const dot = out.find((f) => f.asset === "DOT"), ksm = out.find((f) => f.asset === "KSM");
  assert.equal(dot.chain, "polkadot");
  assert.equal(dot.category, "airdrop");
  assert.equal(dot.amount, 321166);
  assert.equal(dot.confidence, "high");
  assert.ok(dot.usd > 100000, `usd ${dot.usd}`);
  assert.match(dot.how_to_claim, /^https:\/\/polkadot\.js\.org\/apps\/\?rpc=wss%3A%2F%2Fpolkadot-asset-hub-rpc\.polkadot\.io#\/claims$/);
  assert.match(dot.action, /Regular statement \(claimAttest\)/);
  assert.match(dot.detail, /3211\.66 DOT allocation indicator/);
  assert.equal(ksm.chain, "kusama");
  assert.equal(ksm.amount, 3211.66);
  assert.doesNotMatch(ksm.action, /statement/);
});

test("dot sale: the vesting-locked part and a SAFT statement show on the row", async () => {
  const v = await FORGOTTEN.dotSale({ address: "0x46db544038c59b826dda8d3cc8b72de90c86e683" }, replay("hf-dot-sale-vesting"));
  const vd = v.items.find((i) => i.asset === "DOT");
  assert.equal(vd.amount, 167500);
  assert.equal(vd.locked, 167500);
  assert.match(vd.detail, /167500 of it is vesting-locked/);
  const s = await FORGOTTEN.dotSale({ address: "0xb79356aad9bf2116efe1a66ed55bf1a0d124393b" }, replay("hf-dot-sale-saft"));
  const sd = s.items.find((i) => i.asset === "DOT");
  assert.equal(sd.statement, "SAFT");
  assert.match(sd.action, /SAFT statement/);
});

test("dot sale: an address with no claim entry has no row; SCALE little-endian decode", async () => {
  assert.deepEqual(await FORGOTTEN.dotSale({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("hf-dot-sale-empty")), { items: [], errors: [] });
  assert.equal(le("0x00bcf1dd16ed6a000000000000000000"), 30097030000000000n);
  assert.equal(le("0x0100000002000000000000000000000003000000", 16, 4), 3n);
});

// ---- the Zerion / holdings twin filter keeps the tokens a claim pays ----
test("dropHfTwins: a Karak or K2 row does not hide the wallet's own holding of the token it pays; Blur Pool's receipt still goes", () => {
  const run = {
    findings: [
      { source: "rewards.karak_queue", category: "unstake_ready", chain: "ethereum", protocol: "Karak", asset: "weETH", token: "0xcd5fe23c85820f7b72d0926fc9b05b43e359b7ee", amount: 2.6, usd: 7000 },
      { source: "bridge.k2_claims", category: "bridge_stuck", chain: "ethereum", protocol: "K2 (Karak)", asset: "USDC", token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amount: 100, usd: 100 },
      { source: "rewards.blur_pool", category: "unstake_ready", chain: "ethereum", protocol: "Blur Pool", asset: "ETH", token: "0x0000000000a39bb272e79075ade125fd351887ac", amount: 1, usd: 2500 },
      { source: "rewards.zerion", category: "unstake_ready", chain: "ethereum", protocol: "Karak", asset: "weETH", amount: 2.6, usd: 7010 },
    ],
    holdings: [
      { kind: "token", chain: "ethereum", asset: "weETH", token: "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", amount: 10, usd: 27000, source: "holdings.chains" },
      { kind: "token", chain: "ethereum", asset: "USDC", token: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", amount: 50, usd: 50, source: "holdings.chains" },
      { kind: "token", chain: "ethereum", asset: "Blur Pool", token: "0x0000000000A39bb272e79075ade125fd351887Ac", amount: 1, usd: null, source: "holdings.chains" },
    ],
  };
  const out = F.dropHfTwins(run);
  assert.deepEqual(out.holdings.map((h) => h.asset), ["weETH", "USDC"]);
  assert.ok(!out.findings.some((f) => f.source === "rewards.zerion")); // Zerion's Karak row of the same withdrawal goes
});
