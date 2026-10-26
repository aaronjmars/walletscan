// unclaimed/ sources: fixtures are real answers of the compose routes (captured 2026-10-20 on proven wallets)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as F from "../findings.mjs";
import { encodeFunctionResult, decodeFunctionData, parseAbi } from "viem";
import { v4Owed, v4Ticks, UNCLAIMED } from "../unclaimed/index.mjs";

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/batch-d-${n}.json`, import.meta.url), "utf8"));
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test("Polygon zkEVM exits: exact unclaimed amounts, high, with the claim deadline", () => {
  const f = F.zkevmExits(fx("zkevm"), { deadline: "2027-12-31" });
  assert.equal(f.length, 2);
  const eth = f.find((x) => x.asset === "ETH"), usdt = f.find((x) => x.asset === "USDT");
  close(eth.amount, 0.02047825162125785, 1e-12);
  close(usdt.amount, 2.500392);
  for (const x of f) {
    assert.equal(x.category, "bridge_stuck");
    assert.equal(x.confidence, "high");
    assert.equal(x.deadline, "2027-12-31");
    assert.equal(x.chain, "ethereum");
  }
});

test("Polygon zkEVM exits: claimed leaves are dropped, an unread claimed state is medium", () => {
  const d = fx("zkevm");
  d.items[0].claimed = true;
  d.items[1].read = false;
  const f = F.zkevmExits(d);
  assert.equal(f.length, 1);
  assert.equal(f[0].asset, "USDT");
  assert.equal(f[0].confidence, "medium");
});

test("Hedgey: redeemable plan balances become vesting findings; a plan with nothing unlocked is not one", () => {
  const f = F.hedgey(fx("hedgey"));
  assert.equal(f.length, fx("hedgey").items.length);
  assert.ok(f.every((x) => x.category === "vesting" && x.asset === "DRV" && x.confidence === "high" && x.chain === "ethereum"));
  close(f.reduce((t, x) => t + x.amount, 0), 20735);
  assert.equal(F.hedgey(fx("hedgey-locked")).length, 0); // vitalik's Linea lockup: 4.2069 Secta-LP locked until 2069
});

test("Flaunch: ETH in the FeeEscrow is a high creator_fees finding", () => {
  const [f] = F.flaunch(fx("flaunch"));
  assert.equal(f.category, "creator_fees");
  assert.equal(f.confidence, "high");
  close(f.amount, 0.028355590269474631, 1e-12);
  assert.ok(f.usd > 0);
});

test("Uniswap fees: spam legs without a price are dropped, v3 is high, v4 medium", () => {
  const f = F.uniswapFees(fx("uniswap"));
  assert.ok(f.length > 0);
  assert.ok(f.every((x) => x.usd > 0 && ["WETH", "ETH"].includes(x.asset)), "only priced legs");
  const big = f.find((x) => x.chain === "base" && x.how_to_claim.endsWith("/46052"));
  close(big.amount, 0.171277142433280955, 1e-12);
  assert.equal(big.confidence, "high");
  const v4 = f.find((x) => x.protocol === "Uniswap V4");
  assert.equal(v4.confidence, "medium");
  assert.ok(!f.some((x) => ["DOGE", "BARK", "Mierda", "GoGo"].includes(x.asset)));
});

test("Uniswap v4 fee math: growth delta x liquidity / 2^128, wrapping like the contract", () => {
  const Q = 1n << 128n;
  assert.equal(v4Owed(5n * Q, 2n * Q, 7n), 21n);
  assert.equal(v4Owed(1n * Q, (1n << 256n) - Q, 3n), 6n); // feeGrowth wrapped past 2^256
  const info = (BigInt(-600 & 0xffffff) << 32n) | (BigInt(-1200 & 0xffffff) << 8n);
  assert.deepEqual(v4Ticks(info), { tickLower: -1200, tickUpper: -600 });
});

test("Superfluid: a priced pool share is high, an unpriced memecoin share is a low hint out of the totals", () => {
  const [usdc] = F.superfluid(fx("superfluid"));
  assert.equal(usdc.asset, "USDCx");
  assert.equal(usdc.confidence, "high");
  close(usdc.amount, 605.7799617646809, 1e-9);
  const [spam] = F.superfluid(fx("superfluid-spam"));
  assert.equal(spam.asset, "BOCKER");
  assert.equal(spam.confidence, "low");
  const { totals } = F.summarize([usdc, spam].map((x) => F.withNet(x, {})), [], { minUsd: 1 });
  close(totals.claimable_usd, Math.round(usdc.usd * 100) / 100, 0.011);
  assert.equal(totals.findings, 2);
});

test("Token locks: an expired Team Finance lock is unstake_ready (high); unpriced UNCX and Unvest rows are low", () => {
  const [tf] = F.tokenLocks(fx("locks"));
  assert.equal(tf.protocol, "Team Finance");
  assert.equal(tf.category, "unstake_ready");
  assert.equal(tf.confidence, "high");
  assert.equal(tf.amount, 10000000);
  const spam = F.tokenLocks(fx("locks-spam"));
  assert.ok(spam.some((x) => x.protocol === "UNCX") && spam.some((x) => x.protocol === "Unvest"));
  assert.ok(spam.every((x) => x.confidence === "low" && x.category === "vesting" && x.usd == null));
});

// ---- zkEVM: a token born on zkEVM with no Ethereum copy, and the hints an exact read replaces ----
test("Polygon zkEVM exits: a zkEVM-born token with no Ethereum copy is not ETH; its own name and decimals, medium", async () => {
  const ZK_TOKEN = "0x1111111111111111111111111111111111111111", ZERO = "0x0000000000000000000000000000000000000000";
  const abi = parseAbi([
    "function isClaimed(uint32 leafIndex, uint32 sourceBridgeNetwork) view returns (bool)",
    "function getTokenWrappedAddress(uint32 originNetwork, address originTokenAddress) view returns (address)",
    "function decimals() view returns (uint8)", "function symbol() view returns (string)",
  ]);
  const answer = { isClaimed: false, getTokenWrappedAddress: ZERO, decimals: 6, symbol: "ZKT" };
  const calls = [];
  const ctx = {
    live: () => true,
    call: async (id, p, over = {}) => {
      calls.push(id);
      if (id === "bridge.zkevm_claimer") return { ok: true, status: 200, data: { bridges: [{ leaf_type: 0, origin_network: 1, origin_token_address: ZK_TOKEN, destination_network: 0, amount: "2500000", deposit_count: 7 }] } };
      if (id === "token.prices") return { ok: true, status: 200, data: { coins: {} } };
      // Ethereum only knows the bridge; the token itself only answers on zkEVM
      return { ok: true, status: 200, data: over.body.map((b) => {
        const { functionName } = decodeFunctionData({ abi, data: b.params[0].data });
        const here = id === "bridge.zkevm_rpc" ? ["decimals", "symbol"] : ["isClaimed", "getTokenWrappedAddress"];
        return { id: b.id, result: here.includes(functionName) ? encodeFunctionResult({ abi, functionName, result: answer[functionName] }) : "0x" };
      }) };
    },
  };
  const d = await UNCLAIMED.zkevmExits({ address: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045" }, ctx);
  assert.ok(calls.includes("bridge.zkevm_rpc"));
  const [i] = d.items;
  assert.equal(i.token, null);
  assert.equal(i.asset, "ZKT");
  assert.equal(i.amount, 2.5);
  assert.equal(i.usd, null);
  const [f] = F.zkevmExits(d);
  assert.equal(f.asset, "ZKT");
  assert.equal(f.confidence, "medium");
  assert.match(f.detail, /no Ethereum copy yet/);
});

const zkHint = { category: "bridge_stuck", chain: "polygon-zkevm", asset: "ETH", amount: 0.02, usd: 50, confidence: "medium", source: "holdings.zerion" };
test("zkEVM hints: Zerion's polygon-zkevm balance goes when the claimer lists the wallet, even with every leaf claimed", () => {
  const run = { sources: { "bridge.polygon_zkevm": "ok" }, findings: [zkHint, { source: "holdings.chains", chain_id: 1101, category: "bridge_stuck", usd: 50 }], holdings: [] };
  assert.equal(F.dropDirectTwins(run, { zkevmKnown: true }).findings.length, 0);
  assert.equal(F.dropDirectTwins(run, { zkevmKnown: false }).findings.length, 2, "a wallet the claimer does not list keeps its hint");
  assert.equal(F.dropDirectTwins({ ...run, sources: { "bridge.polygon_zkevm": "error: x" } }, { zkevmKnown: true }).findings.length, 2);
});

test("direct reads: Zerion's reward rows go only on chains our read answered for", () => {
  const z = (chain, protocol) => ({ source: "rewards.zerion", category: "reward", chain, protocol, asset: "X", amount: 1, usd: 10 });
  const run = { sources: { "rewards.uniswap_fees": "ok", "rewards.token_locks": "ok" }, findings: [z("ethereum", "Uniswap V3"), z("base", "Uniswap V3"), z("binance-smart-chain", "UNCX"), z("ethereum", "UNCX"), z("base", "Aerodrome")], holdings: [] };
  const failed = { "rewards.uniswap_fees": F.failedChains(["base: base RPC batch failed (upstream 502)"]), "rewards.token_locks": F.failedChains(["uncx bsc: bsc RPC batch failed (upstream 502)"]) };
  const out = F.dropDirectTwins(run, { failed });
  assert.deepEqual(out.findings.map((f) => `${f.chain} ${f.protocol}`), ["base Uniswap V3", "binance-smart-chain UNCX", "base Aerodrome"]);
});
