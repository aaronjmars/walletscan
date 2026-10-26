// final-verify.test.mjs - found by the 2026-10-22 live check on new wallets: the same money read twice (Zerion +
// rewards.legacy KNCL / Zora, Merkl + CometRewards COMP), a holding worth 3.5e30 USD on 0x...dEaD, burn addresses,
// and a Helius 200 + JSON-RPC database timeout that failed sol.assets on a big wallet. Upstreams are a stubbed fetch
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../findings.mjs";

process.env.RETRY_WAIT_MS = "10";
process.env.HELIUS_API_KEY = "helius-test";

test("a Zerion row twin of an exact source goes, the exact row stays", () => {
  const rows = [
    { source: "holdings.zerion", category: "token_migration", chain: "ethereum", asset: "KNC", amount: 700008.531373792, usd: 104995 },
    { source: "rewards.legacy", category: "token_migration", chain: "ethereum", asset: "KNCL", amount: 700008.531373792, usd: 86869 },
    { source: "rewards.zerion", category: "reward", chain: "base", asset: "ETH", amount: 0.038345208291388475, usd: 91.74 },
    { source: "rewards.legacy", category: "reward", chain: "base", asset: "ETH", amount: 0.03834520829138848, usd: 91.73 },
    { source: "rewards.merkl", category: "reward", chain: "base", asset: "COMP", amount: 4.773515, usd: 116.75 },
    { source: "rewards.compound_rewards", category: "reward", chain: "base", asset: "COMP", amount: 4.773513, usd: 116.75 },
    // not twins: another amount, another chain, another category, two rows of one source
    { source: "rewards.zerion", category: "reward", chain: "base", asset: "WETH", amount: 0.0178, usd: 42 },
    { source: "rewards.zerion", category: "reward", chain: "base", asset: "WETH", amount: 0.0174, usd: 41 },
    { source: "rewards.zerion", category: "reward", chain: "arbitrum", asset: "ETH", amount: 0.038345208291388475, usd: 91 },
    { source: "rewards.zerion", category: "unstake_ready", chain: "base", asset: "ETH", amount: 0.03834520829138848, usd: 91 },
  ];
  const kept = F.dropReaderTwins(rows);
  assert.deepEqual(kept.map((f) => `${f.source}:${f.asset}:${f.chain}:${f.category}`), [
    "rewards.legacy:KNCL:ethereum:token_migration", "rewards.legacy:ETH:base:reward", "rewards.merkl:COMP:base:reward",
    "rewards.zerion:WETH:base:reward", "rewards.zerion:WETH:base:reward", "rewards.zerion:ETH:arbitrum:reward", "rewards.zerion:ETH:base:unstake_ready",
  ]);
});

test("a holding worth over $100B is unverified, so holdings_usd stays sane", () => {
  const h = [F.saneHolding({ kind: "token", chain: "xphere", asset: "XP", amount: 4e32, usd: 3.5e30, verified: true }), F.saneHolding({ kind: "token", chain: "ethereum", asset: "ETH", usd: 2500, verified: true })];
  assert.equal(h[0].verified, false);
  assert.match(h[0].note, /over \$100B/);
  const t = F.summarize([], h).totals;
  assert.equal(t.holdings_usd, 2500);
});

let heliusCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes("helius")) {
    heliusCalls++;
    const body = heliusCalls === 1
      ? { jsonrpc: "2.0", error: { code: -32603, message: "Database Error: Query Error: canceling statement due to statement timeout" }, id: 1 }
      : { jsonrpc: "2.0", result: { total: 0, items: [] }, id: 1 };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }
  return new Response("{}", { status: 404 });
};
const { callRoute, REG_BY_ID } = await import("../engine.mjs");
const call = (id, params) => callRoute(REG_BY_ID.get(id), params);

test("sol.assets retries a 200 that carries a JSON-RPC database timeout", async () => {
  const r = await call("sol.assets", { owner: "86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY" });
  assert.equal(r.ok, true);
  assert.equal(heliusCalls, 2);
  assert.deepEqual(r.data.result.items, []);
});

test("burn addresses are refused before any upstream call", async () => {
  for (const a of ["0x000000000000000000000000000000000000dEaD", "0x0000000000000000000000000000000000000000"]) {
    await assert.rejects(call("scan.all", { address: a }), (e) => e.status === 400 && /burn address/.test(e.error));
  }
});

test("a Zerion Gearbox reward is a low hint, out of the totals; other Zerion rewards stay medium", () => {
  const pos = (protocol, quantity, value) => ({ attributes: { position_type: "reward", protocol, quantity: { numeric: quantity }, value, fungible_info: { symbol: "X", implementations: [] } }, relationships: { chain: { data: { id: "ethereum" } } } });
  const { findings } = F.zerionPositions({ data: [pos("Gearbox", "100160", 61.92), pos("Aave", "10", 25)] });
  assert.deepEqual(findings.map((f) => [f.protocol, f.confidence]), [["Gearbox", "low"], ["Aave", "medium"]]);
  assert.match(findings[0].detail, /far too high/);
  assert.equal(F.summarize(findings, []).totals.likely_usd, 25);
});

test("Solana: a token Helius cannot price gets Jupiter's price; a deep pool with no authorities counts, bait does not", () => {
  const tok = (id, balance, decimals) => ({ interface: "FungibleToken", id, token_info: { balance, decimals } });
  const das = { result: { items: [tok("SPCmint", 13540800000, 6), tok("BAITmint", 5e9, 6), tok("FRZmint", 1e9, 6), tok("NOPRICE", 1e9, 6)] } };
  const jup = [
    { id: "SPCmint", symbol: "SPC", usdPrice: 0.00077123, liquidity: 110575, isVerified: null, tags: ["unknown"], audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } },
    { id: "BAITmint", symbol: "BAIT", usdPrice: 2, liquidity: 900, tags: ["unknown"], audit: { mintAuthorityDisabled: true, freezeAuthorityDisabled: true } },
    { id: "FRZmint", symbol: "FRZ", usdPrice: 1, liquidity: 500000, tags: ["unknown"], audit: { mintAuthorityDisabled: true } },
  ];
  const { holdings, unpriced } = F.solHoldings(das, jup);
  const by = Object.fromEntries(holdings.map((h) => [h.asset, h]));
  assert.equal(by.SPC.verified, true);
  assert.equal(Math.round(by.SPC.usd * 100) / 100, 10.44);
  assert.match(by.SPC.detail, /\$111k pool/);
  assert.equal(by.BAIT.verified, false); // thin pool
  assert.equal(by.FRZ.verified, false); // freeze authority still set
  assert.equal(unpriced, 1);
  assert.equal(F.summarize([], holdings).totals.holdings_usd, 10.44);
});
