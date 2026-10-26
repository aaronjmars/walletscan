// hf.test.mjs - the hiddenfunds.xyz gap sources (forgotten/claims.mjs, dexes.mjs ...): compose functions replayed on
// real answers captured 2026-10-21 (test/fixtures/hf-*.json), then the normalizers and the Zerion twin filter
import { test, beforeEach } from "node:test";
beforeEach((t) => t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T00:00:00Z") }));
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { FORGOTTEN } from "../forgotten/index.mjs";

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

// ---- rewards.blur_pool ----
test("blur pool: ETH left in the pool is a high unstake_ready row, priced as ETH", async () => {
  const d = await FORGOTTEN.blurPool({ address: "0x07c669fc7bc04e015fe8d53425b6f32f67a38eea" }, replay("hf-blur"));
  assert.equal(d.items.length, 1);
  const [f] = F.hfClaims(d, { source: "rewards.blur_pool" });
  assert.equal(f.category, "unstake_ready");
  assert.equal(f.chain, "ethereum");
  assert.equal(f.asset, "ETH");
  assert.equal(f.amount, 0.04206857);
  assert.ok(f.usd > 50 && f.usd < 200, `usd ${f.usd}`);
  assert.equal(f.confidence, "high");
  assert.equal(f.token, "0x0000000000a39bb272e79075ade125fd351887ac");
  assert.match(f.action, /withdraw\(42068574257512270\)/);
  assert.match(f.how_to_claim, /etherscan\.io\/address\/0x0000000000A39bb272e79075ade125fd351887Ac#writeProxyContract/);
});

test("blur pool: an empty wallet has no row", async () => {
  const d = await FORGOTTEN.blurPool({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("hf-blur-empty"));
  assert.deepEqual(d.items, []);
});

test("blur pool: a non-EVM address is a 400", async () => {
  await assert.rejects(FORGOTTEN.blurPool({ address: "nope" }, replay("hf-blur")), (e) => e.status === 400);
});

// ---- normalizer + twins ----
test("hfClaims: ready + priced = high, unpriced leg or no price = medium, hint = low, dust dropped unless a deadline", () => {
  const row = (o) => ({ category: "reward", chain: "base", protocol: "X", asset: "A", amount: 1, usd: 50, status: "ready", action: "claim", how_to_claim: "https://x", detail: "d", ...o });
  const out = F.hfClaims({ items: [row({ asset: "OK" }), row({ asset: "LEG", unpriced: 1 }), row({ asset: "NOPX", usd: null }), row({ asset: "Q", status: "queued" }), row({ asset: "HINT", status: "hint" }),
    row({ asset: "DUST", usd: 0.2 }), row({ asset: "DUSTDL", usd: 0.2, deadline: "2026-10-26" }), row({ asset: "ZERO", amount: 0 })] }, { source: "s" });
  const by = Object.fromEntries(out.map((f) => [f.asset, f]));
  assert.deepEqual(Object.keys(by).sort(), ["DUSTDL", "HINT", "LEG", "NOPX", "OK", "Q"]);
  assert.equal(by.OK.confidence, "high");
  assert.equal(by.LEG.confidence, "medium");
  assert.match(by.LEG.detail, /1 leg without a trusted price/);
  assert.equal(by.NOPX.confidence, "medium");
  assert.equal(by.Q.confidence, "medium");
  assert.equal(by.HINT.confidence, "low");
  assert.equal(by.DUSTDL.action, "claim before 2026-10-26");
  assert.equal(by.OK.source, "s");
});

test("dropHfTwins: Zerion's row of the same money and the receipt-token holding go, other rows stay", () => {
  const ours = { source: "rewards.blur_pool", category: "unstake_ready", chain: "ethereum", protocol: "Blur Pool", asset: "ETH", token: "0x0000000000a39bb272e79075ade125fd351887ac", amount: 1.5, usd: 3600 };
  const lp = { source: "rewards.dead_dexes", category: "token_migration", chain: "bsc", protocol: "BabySwap", asset: "A-B LP", token: "0xpair", amount: 2, usd: 500, legs: [{ asset: "WBNB", amount: 0.4 }, { asset: "USDT", amount: 250 }] };
  const run = {
    findings: [ours, lp, { source: "rewards.zerion", category: "unstake_ready", chain: "ethereum", protocol: "Blur", amount: 1.5, usd: 3601 }, { source: "rewards.zerion", category: "reward", chain: "ethereum", protocol: "Blur", amount: 9, usd: 9 }],
    holdings: [
      { kind: "deposit", chain: "ethereum", protocol: "Blur", asset: "ETH", amount: 1.49, usd: 3590 },
      { kind: "token", chain: "ethereum", asset: "Blur Pool", token: "0x0000000000A39bb272e79075ade125fd351887Ac", amount: 1.5, usd: null, source: "holdings.chains" },
      { kind: "deposit", chain: "binance-smart-chain", protocol: "BabySwap", asset: "USDT", amount: 250.5, usd: 250 },
      { kind: "token", chain: "bsc", asset: "A-B LP", token: "0xpair", amount: 2, usd: 480, source: "holdings.chains" },
      { kind: "deposit", chain: "ethereum", protocol: "Aave", asset: "ETH", amount: 1.5, usd: 3600 },
    ],
  };
  const out = F.dropHfTwins(run);
  assert.equal(out.findings.length, 3);
  assert.ok(out.findings.some((f) => f.source === "rewards.zerion" && f.amount === 9));
  assert.deepEqual(out.holdings.map((h) => h.protocol || h.asset), ["A-B LP", "Aave"]); // the LP holding stays: summarize() handles token_migration
});

// ---- bridge.blast_usdb ----
test("blast usdb: a finalized, unclaimed request is a high bridge_stuck row with its claim call and the app date", async () => {
  const d = await FORGOTTEN.blastUsdb({ address: "0x93f7c76C7a4aA5A37998015F3a3A4E781F057bf6" }, replay("hf-blast-usdb"));
  assert.equal(d.items.length, 1);
  const [i] = d.items;
  assert.equal(i.request_id, "3449");
  assert.equal(i.hint_id, "277");
  assert.equal(i.status, "ready");
  const [f] = F.hfClaims(d, { source: "bridge.blast_usdb" });
  assert.equal(f.category, "bridge_stuck");
  assert.equal(f.asset, "DAI");
  assert.equal(f.amount, 33046.8446);
  assert.ok(f.usd > 32000 && f.usd < 34000, `usd ${f.usd}`);
  assert.equal(f.confidence, "high");
  assert.equal(f.deadline, "2026-10-26");
  assert.match(f.action, /claimWithdrawal\(3449, 277\)/);
  assert.match(f.action, /no onchain expiry/);
  assert.equal((f.action.match(/before 2026-10-26/g) || []).length, 1); // the normalizer does not add a second one
});

test("blast usdb: a wallet with no requests has no row", async () => {
  const d = await FORGOTTEN.blastUsdb({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("hf-blast-usdb-empty"));
  assert.deepEqual(d.items, []);
});

// ---- rewards.balancer_rescue ----
test("balancer rescue: Merkl test=true allocations on the rescue wrappers, claimed() read onchain, paid token priced", async () => {
  const d = await FORGOTTEN.balancerRescue({ address: "0x5e0481cad8bff5453635f4770f44b2194ddf6e02" }, replay("hf-balancer-rescue"));
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.items.map((i) => i.asset).sort(), ["WETH", "wstETH"]); // the aglaMerkl incentive in the same answer is not a rescue wrapper
  const fs = F.hfClaims(d, { source: "rewards.balancer_rescue" });
  const weth = fs.find((f) => f.asset === "WETH");
  assert.equal(weth.token, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"); // what the wrapper pays, read with token()
  assert.equal(weth.amount, 0.47192652);
  assert.equal(weth.confidence, "high");
  assert.equal(weth.deadline, "2027-02-10");
  assert.match(weth.action, /balancer\.fi\/portfolio before 2026-10-30/);
  assert.ok(fs.every((f) => f.usd > 500), JSON.stringify(fs.map((f) => f.usd)));
});

test("balancer rescue: an allocation already claimed has no row", async () => {
  const d = await FORGOTTEN.balancerRescue({ address: "0x247d084e47fc065bce5667a4c32421d3fccd87d6" }, replay("hf-balancer-rescue-claimed"));
  assert.deepEqual(d.items, []);
});

// ---- rewards.creator_rewards ----
test("creator rewards: Zora ProtocolRewards left on Zora, Optimism and Ethereum, one row per chain, priced as ETH", async () => {
  const d = await FORGOTTEN.creatorRewards({ address: "0x277c2a47ac1aeb6f77b778dbed48d3d4feea8937" }, replay("hf-creator-zora"));
  assert.deepEqual(d.errors, []);
  const fs = F.hfClaims(d, { source: "rewards.creator_rewards" });
  assert.deepEqual(fs.map((f) => f.chain), ["zora", "optimism", "ethereum"]);
  const [z] = fs;
  assert.equal(z.protocol, "Zora");
  assert.equal(z.category, "reward");
  assert.equal(z.amount, 0.14337052);
  assert.equal(z.confidence, "high");
  assert.match(z.how_to_claim, /explorer\.zora\.energy\/address\/0x7777777F279eba3d3Ad8F4E708545291A6fDBA8B/);
  assert.ok(fs.every((f) => f.usd > 1));
});

// ---- bridge.agglayer (Silicon exits) ----
test("agglayer: a Silicon exit to Ethereum not claimed on the unified bridge is a high bridge_stuck row with the Silicon deadline", async () => {
  const d = await FORGOTTEN.agglayerExits({ address: "0xb7c6fd0521a85a71f362aec8d9522ededec6fb92" }, replay("hf-agglayer"));
  assert.deepEqual(d.errors, []);
  assert.equal(d.items.length, 1); // the claimed exit 2464 and the two deposits into Silicon are not rows
  const [f] = F.hfClaims(d, { source: "bridge.agglayer" });
  assert.equal(f.category, "bridge_stuck");
  assert.equal(f.asset, "ETH");
  assert.equal(f.amount, 0.0309904);
  assert.equal(f.confidence, "high");
  assert.equal(f.deadline, "2026-12-31");
  assert.match(f.detail, /isClaimed\(2599, 10\) = false/);
});

test("agglayer: a wallet with no Silicon bridge history has no row", async () => {
  const d = await FORGOTTEN.agglayerExits({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("hf-agglayer-empty"));
  assert.deepEqual(d.items, []);
});

// ---- data/sunset-chains.json rows added with this batch ----
test("sunset rows: Forma and Harmony are listed with sources and live RPCs, Silicon has its official notice and L1 bridge", () => {
  const rows = JSON.parse(readFileSync(new URL("../data/sunset-chains.json", import.meta.url), "utf8"));
  const by = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.equal(by.forma.chain_id, 984122);
  assert.equal(by.forma.native, "TIA");
  assert.equal(by.harmony.chain_id, 1666600000);
  assert.equal(by.harmony.closes, "2026-09-10"); // snapshot cutoff: a balance left there is a hint, not money to bridge
  for (const r of [by.forma, by.harmony]) { assert.match(r.source, /^https:\/\//); assert.ok(r.rpcs.length > 0); }
  assert.match(by.silicon.source, /docs\.silicon\.network/);
  assert.ok(by.silicon.l1_bridges.some((b) => b.address === "0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe"));
});

// ---- rewards.plasma_vault ----
test("plasma vault: shares on Plasma with the queue open are a high token_migration row valued at the accountant rate", async () => {
  const d = await FORGOTTEN.plasmaVault({ address: "0xc949b2019f937d4822c14e396e730407ce62130b" }, replay("hf-plasma"));
  assert.deepEqual(d.errors, []);
  const [f] = F.hfClaims(d, { source: "rewards.plasma_vault" });
  assert.equal(f.chain, "plasma");
  assert.equal(f.category, "token_migration");
  assert.equal(f.token, "0xd1074e0ae85610ddba0147e29ebe0d8e5873a000");
  assert.equal(f.amount, 77.990523);
  assert.ok(f.usd > 80 && f.usd < 84, `usd ${f.usd}`); // shares x rate (about 1.049 USDT0 each)
  assert.equal(f.confidence, "high");
  assert.match(f.action, /requestOnChainWithdraw/);
});

test("plasma vault: shares on Ethereum must be bridged to Plasma first, so medium", async () => {
  const d = await FORGOTTEN.plasmaVault({ address: "0x1a78fbe94576de9bc17aa01223ac1d1261d542c9" }, replay("hf-plasma-eth"));
  const [f] = F.hfClaims(d, { source: "rewards.plasma_vault" });
  assert.equal(f.chain, "ethereum");
  assert.equal(f.amount, 3500);
  assert.ok(f.usd > 3600 && f.usd < 3700, `usd ${f.usd}`);
  assert.equal(f.confidence, "medium");
  assert.match(f.action, /teller\.bridge/);
});

test("creator rewards: 0xSplits v2 warehouse balances (ETH by its 0xEeee id, then ERC-20s), the 1-unit leftover not counted", async () => {
  const d = await FORGOTTEN.creatorRewards({ address: "0x06536e09915020e95c314fa73aefa8a4285e4411" }, replay("hf-creator-splits"));
  assert.deepEqual(d.errors, []);
  const fs = F.hfClaims(d, { source: "rewards.creator_rewards" });
  assert.ok(fs.every((f) => f.protocol === "0xSplits v2"));
  const eth = fs.find((f) => f.chain === "ethereum" && f.asset === "ETH");
  assert.equal(eth.amount, 0.45061463);
  assert.equal(eth.confidence, "high");
  assert.match(eth.action, /withdraw\(your address, 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE\)/);
  const usdc = fs.find((f) => f.chain === "ethereum" && f.asset === "USDC");
  assert.equal(usdc.token, "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  assert.ok(usdc.usd > 250);
});

// ---- rewards.dead_dexes ----
test("dead dexes: an LP of a dead Uniswap v2 fork, valued at the wallet's share of the reserves; an unpriced leg = medium", async () => {
  const d = await FORGOTTEN.deadDexes({ address: "0x08e67455964d1419fa9f2fd0612c4f526315b50b" }, replay("hf-dexes"));
  assert.deepEqual(d.errors, []);
  assert.equal(d.pairs_checked, 335);
  const [f] = F.hfClaims(d, { source: "rewards.dead_dexes" });
  assert.equal(f.protocol, "Unicly");
  assert.equal(f.category, "token_migration");
  assert.equal(f.token, "0xec5100ad159f660986e47afa0cda1081101b471d"); // the pair: summarize() leaves it out of the totals if a priced holding has it
  assert.equal(Math.round(f.amount * 1e8) / 1e8, 2.66262089);
  assert.equal(f.legs.length, 2);
  assert.equal(f.legs.find((l) => l.asset === "uJENNY").usd, null);
  assert.ok(f.usd > 30 && f.usd < 120, `usd ${f.usd}`); // the WETH leg only
  assert.equal(f.confidence, "medium");
  assert.match(f.detail, /1 leg without a trusted price/);
  assert.match(f.action, /burn\(your address\)/);
});

test("dead dexes: a wallet with no LP in the listed pairs has no row; every listed pair is on a chain we can reach", async () => {
  const d = await FORGOTTEN.deadDexes({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("hf-dexes-empty"));
  assert.deepEqual(d.items, []);
  assert.deepEqual(d.errors, []);
  const { DEAD_DEXES } = await import("../forgotten/dexes.mjs");
  const { RPC } = await import("../forgotten/anyrpc.mjs");
  assert.ok(DEAD_DEXES.pairs.every((x) => RPC[x.chain] && DEAD_DEXES.dexes.some((dx) => dx.id === x.dex)));
});

test("dead dexes: YouSwap LPs with both legs priced are high; partly priced ones medium, biggest first after summarize", async () => {
  const d = await FORGOTTEN.deadDexes({ address: "0x33881af1e954359d375a0b135c241aeffb8a6582" }, replay("hf-dexes-youswap"));
  const fs = F.hfClaims(d, { source: "rewards.dead_dexes" });
  const by = Object.fromEntries(fs.map((f) => [f.asset, f]));
  assert.deepEqual(Object.keys(by).sort(), ["WBTC-USDT LP", "WETH-USDT LP", "YOU-LINK LP", "YOU-UNI LP"]);
  assert.equal(by["WETH-USDT LP"].confidence, "high");
  assert.ok(by["WETH-USDT LP"].usd > 50000, `usd ${by["WETH-USDT LP"].usd}`);
  assert.equal(by["YOU-LINK LP"].confidence, "medium");
  assert.ok(by["WBTC-USDT LP"].amount > 0 && by["WBTC-USDT LP"].amount < 1e-6); // a WBTC-USDT LP is about 1e-9 units: kept, not rounded away
  const s = F.summarize(fs, []);
  assert.ok(s.totals.claimable_usd > 100000, `claimable ${s.totals.claimable_usd}`); // no priced holding lists the pairs, so they count
});

test("dead dexes: legs priced more than 3x apart count only the smaller one; a quote older than 3 days is no price", async () => {
  const { countedLegs, staleQuote } = await import("../forgotten/dexes.mjs");
  const even = countedLegs([{ asset: "WETH", usd: 1000 }, { asset: "USDT", usd: 990 }]);
  assert.equal(even.imbalanced, false);
  assert.equal(even.priced.length, 2);
  const skew = countedLegs([{ asset: "METIS", usd: 40000 }, { asset: "WBNB", usd: 900 }]); // a bridged copy priced as the original
  assert.equal(skew.imbalanced, true);
  assert.deepEqual(skew.priced.map((l) => l.asset), ["WBNB"]);
  assert.equal(countedLegs([{ asset: "A", usd: 5 }, { asset: "B", usd: null }]).priced.length, 1);
  const now = 1_800_000_000;
  assert.equal(staleQuote({ price: 1, timestamp: now - 4 * 86400 }, now), true);
  assert.equal(staleQuote({ price: 1, timestamp: now - 3600 }, now), false);
  assert.equal(staleQuote({ price: 1 }, now), false);
});
