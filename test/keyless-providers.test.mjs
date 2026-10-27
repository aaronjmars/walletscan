import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { encodeFunctionResult, decodeFunctionData, parseAbi, keccak256, stringToHex } from "viem";
import { dexPools, geckoPools, selectMarketQuote, marketQuote, fillMarketGaps, rugcheckRows, rugcheckVerdict } from "../market.mjs";
import { walletPositions, walletAssets, mintInformation } from "../pagination.mjs";
import { pons, vestShare, PONS } from "../forgotten/pons.mjs";
import { approvals, approvalCandidates } from "../approvals.mjs";
import { COMPOSE, mergeWallets } from "../compose.mjs";
import { render } from "../cli.mjs";
import * as F from "../findings.mjs";

const A = "0x1111111111111111111111111111111111111111", B = "0x2222222222222222222222222222222222222222";
const T = "0x3333333333333333333333333333333333333333", U = "0x4444444444444444444444444444444444444444";
const ZERO = "0x0000000000000000000000000000000000000000";
const SOL = "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq";
const ok = (data) => ({ ok: true, status: 200, data });
const pool = (more = {}) => ({ pool: "0xpool", price: 2, liquidity: 200000, volume_24h: 5000, provider: "dexscreener", ...more });

test("market data matches exact chain/address and does not mistake a quote-side token for the base price", () => {
  const p = { chainId: "ethereum", pairAddress: "0xpool", baseToken: { address: T }, quoteToken: { address: U }, priceUsd: "2", liquidity: { usd: 200000 }, volume: { h24: 5000 } };
  assert.equal(dexPools([p], T.toUpperCase().replace("0X", "0x"), "ethereum")[0].price, 2);
  assert.deepEqual(dexPools([p], U, "ethereum"), []);
  assert.deepEqual(dexPools([p], T, "base"), []);
  const g = { data: [{ attributes: { address: "pool", base_token_price_usd: "200", quote_token_price_usd: "1", reserve_in_usd: "90000", volume_usd: { h24: "3000" } }, relationships: { base_token: { data: { id: `eth_${T}` } }, quote_token: { data: { id: `eth_${U}` } } } }] };
  assert.equal(geckoPools(g, U)[0].price, 1);
  assert.deepEqual(geckoPools(g, A), []);
});

test("market evidence counts one pool once, rejects deep-pool conflicts, dead markets and insufficient exit liquidity", () => {
  const same = selectMarketQuote([pool(), pool({ provider: "geckoterminal" })]);
  assert.equal(same.pools.length, 1);
  assert.equal(selectMarketQuote([pool(), pool({ pool: "other", price: 20 })]).price, null);
  assert.equal(selectMarketQuote([pool({ volume_24h: 0 })]).price, null);
  assert.equal(selectMarketQuote([pool({ liquidity: 49999 })]).price, null);
  assert.equal(selectMarketQuote([pool()], { valueUsd: 100001 }).price, null);
  assert.equal(selectMarketQuote([pool({ price: Infinity })]).price, null);
});

test("GeckoTerminal is a gap fallback; market estimates cannot promote a token to verified or a high claim", async () => {
  const seen = [];
  const quote = await marketQuote({ chain: "ethereum", token: T }, { call: async (id) => { seen.push(id); return ok(id === "token.dexscreener_pairs" ? [] : { data: [{ attributes: { address: "p", base_token_price_usd: "3", reserve_in_usd: "100000", volume_usd: { h24: "5000" } }, relationships: { base_token: { data: { id: `eth_${T}` } } } }] }); } });
  assert.deepEqual(seen, ["token.dexscreener_pairs", "token.gecko_pools"]);
  assert.equal(quote.price, 3);
  const run = { holdings: [{ chain: "ethereum", token: T, amount: 10, usd: null, verified: false }], findings: [{ chain: "ethereum", token: T, amount: 2, usd: null, confidence: "high", category: "reward" }] };
  const info = await fillMarketGaps({ call: async () => ok(quote) }, run);
  assert.equal(info.priced, 1);
  assert.equal(run.holdings[0].usd, 30);
  assert.equal(run.holdings[0].verified, false);
  assert.equal(run.findings[0].confidence, "medium");
  assert.equal(F.summarize(run.findings, run.holdings).totals.claimable_usd, 0);
  assert.equal(F.summarize(run.findings, run.holdings).totals.holdings_usd, 0);
});

test("market and Rugcheck budgets disclose unchecked rows; missing reports and score alone never establish trust", async () => {
  const rows = [T, U].map((token) => ({ chain: "solana", token, amount: 10, usd: null, confidence: "medium", category: "reward" }));
  const d = await fillMarketGaps({ call: async () => ok({ price: null, errors: [] }) }, { holdings: [], findings: rows }, { max: 1 });
  assert.equal(d.unchecked, 1);
  assert.equal(rows[0].usd, null);
  assert.equal(rugcheckVerdict({ score_normalised: 0 }), null);
  assert.equal(rugcheckVerdict({ risks: [], score_normalised: 9999 }).danger, false);
  const risk = await rugcheckRows({ call: async () => ok({ risks: [{ name: "Freeze authority", level: "danger" }] }) }, { holdings: [], findings: rows }, { max: 1 });
  assert.equal(risk.checked, 1);
  assert.equal(risk.unchecked, 1);
  assert.equal(rows[0].confidence, "low");
  assert.equal(rows[1].confidence, "medium");
});

const next = (cursor, host = "api.zerion.io", wallet = A) => `https://${host}/v1/wallets/${wallet}/positions/?page%5Bafter%5D=${cursor}`;
test("Zerion pagination keeps later pages and duplicate IDs once, without following credential-bearing upstream URLs", async () => {
  const cursors = [];
  const d = await walletPositions({ call: async (id, p) => { cursors.push(p.after); return ok(p.after ? { data: [{ id: "one" }, { id: "two" }], links: {} } : { data: [{ id: "one" }], links: { next: next("abc") } }); } }, "holdings.zerion", { address: A });
  assert.deepEqual(cursors, [undefined, "abc"]);
  assert.deepEqual(d.data.map((r) => r.id), ["one", "two"]);
  assert.equal(d.coverage.status, "complete");
  let calls = 0;
  const bad = await walletPositions({ call: async () => { calls++; return ok({ data: [{ id: "one" }], links: { next: next("stolen", "untrusted.example") } }); } }, "holdings.zerion", { address: A });
  assert.equal(calls, 1);
  assert.equal(bad.coverage.status, "truncated");
});

test("a failed or repeated portfolio page retains earlier balances and explains incomplete coverage", async () => {
  for (const mode of ["failed", "repeated"]) {
    const d = await walletPositions({ call: async (id, p) => p.after && mode === "failed" ? { ok: false, status: 429 } : ok({ data: [{ id: "a" }], links: { next: next("same") } }) }, "rewards.zerion", { address: A });
    assert.equal(d.data.length, 1);
    assert.equal(d.coverage.status, "truncated");
  }
});

test("DAS pages are merged and repeat detection reports truncation; Jupiter enriches beyond the old 300-mint limit", async () => {
  const d = await walletAssets({ call: async (id, p) => ok({ result: { total: 3, items: Number(p.page) === 1 ? [{ id: "a" }, { id: "b" }] : [{ id: "c" }] } }) }, SOL, { limit: 2 });
  assert.deepEqual(d.result.items.map((r) => r.id), ["a", "b", "c"]);
  assert.equal(d.coverage.status, "complete");
  const repeat = await walletAssets({ call: async () => ok({ result: { total: 4, items: [{ id: "a" }, { id: "b" }] } }) }, SOL, { limit: 2 });
  assert.equal(repeat.coverage.status, "truncated");
  let calls = 0;
  const m = await mintInformation({ call: async (id, p) => { calls++; const ids = p.query.split(","); assert.ok(ids.length <= 100); return ok(ids.map((id) => ({ id }))); } }, Array.from({ length: 450 }, (_, i) => `mint${i}`));
  assert.equal(calls, 5);
  assert.equal(m.items.length, 450);
  assert.equal(m.coverage.status, "complete");
});

test("Pons vesting uses the snapshotted split, including rounding, beneficiary changes and identical recipients", () => {
  assert.equal(vestShare(101n, [A, B, 2500], A), 76n);
  assert.equal(vestShare(101n, [A, B, 2500], B), 25n);
  assert.equal(vestShare(101n, [B, U, 2500], A), 0n);
  assert.equal(vestShare(101n, [A, A, 2500], A), 101n);
  assert.equal(vestShare(100n, [A, B, 10001], A), 0n);
});

const MC = parseAbi(["struct C { address target; bool allowFailure; bytes callData; }", "struct R { bool success; bytes returnData; }", "function aggregate3(C[] calls) payable returns (R[] returnData)"]);
const PABI = parseAbi(["function feeEscrow() view returns (address)", "function buybackVault() view returns (address)", "function balanceOf(address) view returns (uint256)", "function balanceOfToken(address,address) view returns (uint256)", "function releasable(address) view returns (uint256)", "function vestingTerms(address) view returns (address,address,uint16)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
function ponsCtx({ discoveryFails = false } = {}) {
  return { call: async (id, p, over) => {
    if (id === "rewards.pons_profile") return discoveryFails ? { ok: false, status: 503 } : ok({ launches: [{ address: T, quote: { address: U } }] });
    if (id === "token.prices") return ok({ coins: { "coingecko:ethereum": { price: 2000, confidence: 0.99 }, [`robinhood:${U}`]: { price: 1, confidence: 0.99 }, [`robinhood:${T}`]: { price: 10, confidence: 0.99 } } });
    assert.equal(id, "evm.rpc"); assert.equal(p.chain, "robinhood");
    const calls = decodeFunctionData({ abi: MC, data: over.body.params[0].data }).args[0];
    const result = calls.map((c) => {
      const { functionName: fn, args } = decodeFunctionData({ abi: PABI, data: c.callData });
      const v = { feeEscrow: () => PONS.escrows[0], buybackVault: () => B,
        balanceOf: () => c.target.toLowerCase() === PONS.escrows[0] ? 10n ** 18n : 0n,
        balanceOfToken: () => args[1].toLowerCase() === U && c.target.toLowerCase() === PONS.escrows[0] ? 1234567n : 0n,
        releasable: () => 10n ** 18n, vestingTerms: () => [A, U, 2500], decimals: () => c.target.toLowerCase() === U ? 6 : 18, symbol: () => c.target.toLowerCase() === U ? "USD" : "TOK" }[fn]();
      return { success: true, returnData: encodeFunctionResult({ abi: PABI, functionName: fn, result: v }) };
    });
    return ok({ result: encodeFunctionResult({ abi: MC, functionName: "aggregate3", result }) });
  } };
}
test("Pons fees keep asset decimals and distinct escrow/vest balances; missing discovery does not erase known escrow funds", async () => {
  const d = await pons({ address: A }, ponsCtx());
  assert.deepEqual(d.errors, []);
  assert.equal(d.items.find((x) => x.asset === "ETH").amount, 1);
  assert.equal(d.items.find((x) => x.asset === "USD").amount, 1.234567);
  assert.equal(d.items.find((x) => x.category === "vesting").amount, 0.75);
  assert.equal(d.items.find((x) => x.category === "vesting").usd, 7.5);
  const partial = await pons({ address: A }, ponsCtx({ discoveryFails: true }));
  assert.equal(partial.coverage.status, "truncated");
  assert.ok(partial.items.some((x) => x.asset === "ETH"));
});

test("Pons public creator fixture replays its exact onchain ETH fee balance without any key or network", async () => {
  const records = JSON.parse(readFileSync(new URL("./fixtures/pons-creator.json", import.meta.url), "utf8"));
  const k = (id, p, sha) => `${id}|${JSON.stringify(p)}|${sha || ""}`;
  const by = new Map(records.map((r) => [k(r.id, r.params, r.body_sha), r]));
  const address = records.find((r) => r.id === "rewards.pons_profile").params.address;
  const d = await pons({ address }, { call: async (id, p, over = {}) => {
    const r = by.get(k(id, p, over.body == null ? "" : createHash("sha1").update(JSON.stringify(over.body)).digest("hex")));
    assert.ok(r, `recorded ${id}`);
    return { status: r.status, ok: r.status === 200, data: r.data };
  } });
  assert.deepEqual(d.errors, []);
  assert.equal(d.coverage.status, "complete");
  assert.ok(d.items.find((x) => x.asset === "ETH").amount > 1);
});

const topic = (a) => `0x${"0".repeat(24)}${a.slice(2)}`;
const APPROVE = keccak256(stringToHex("Approval(address,address,uint256)"));
test("approval discovery matches owner and preserves large NFT IDs; current revocations and transferred NFTs are excluded", async () => {
  const nftId = (2n ** 128n).toString();
  const logs = [{ address: T, topics: [APPROVE, topic(A), topic(B)] }, { address: U, topics: [APPROVE, topic(A), topic(B), `0x${BigInt(nftId).toString(16).padStart(64, "0")}`] }];
  const c = approvalCandidates(logs, A);
  assert.equal(c[1].token_id, nftId);
  assert.deepEqual(approvalCandidates(logs, B), []);
  const abi = parseAbi(["function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function ownerOf(uint256) view returns (address)", "function getApproved(uint256) view returns (address)"]);
  const d = await approvals({ address: A, chains: "ethereum,base" }, { call: async (id, p, over) => {
    if (id === "security.approval_logs") return ok({ status: "1", result: p.event === APPROVE ? logs : [] });
    const calls = decodeFunctionData({ abi: MC, data: over.body.params[0].data }).args[0];
    const result = calls.map((c) => { const { functionName: fn } = decodeFunctionData({ abi, data: c.callData }); const v = { allowance: 0n, balanceOf: 10n, decimals: 18, symbol: "TOK", ownerOf: B, getApproved: B }[fn]; return { success: true, returnData: encodeFunctionResult({ abi, functionName: fn, result: v }) }; });
    return ok({ result: encodeFunctionResult({ abi: MC, functionName: "aggregate3", result }) });
  } });
  assert.deepEqual(d.approvals, []);
  assert.deepEqual(d.unsupported_chains, ["base"]);
  assert.equal(d.coverage.ethereum.status, "complete");
});

test("active approval exposure is capped by the current balance; unlimited allowances and NFT operators remain permissions", async () => {
  const operator = keccak256(stringToHex("ApprovalForAll(address,address,bool)"));
  const abi = parseAbi(["function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function isApprovedForAll(address,address) view returns (bool)"]);
  const d = await approvals({ address: A, chains: "ethereum" }, { call: async (id, p, over) => {
    if (id === "security.approval_logs") return ok({ status: "1", result: [{ address: p.event === operator ? U : T, topics: [p.event, topic(A), topic(B)], data: "0x01" }] });
    const calls = decodeFunctionData({ abi: MC, data: over.body.params[0].data }).args[0];
    const result = calls.map((c) => {
      const { functionName: fn } = decodeFunctionData({ abi, data: c.callData });
      const v = { allowance: 2n ** 256n - 1n, balanceOf: 9n, decimals: 6, symbol: "USD", isApprovedForAll: true }[fn];
      return { success: true, returnData: encodeFunctionResult({ abi, functionName: fn, result: v }) };
    });
    return ok({ result: encodeFunctionResult({ abi: MC, functionName: "aggregate3", result }) });
  } });
  assert.equal(d.approvals.length, 2);
  assert.equal(d.approvals.find((x) => x.type === "erc20").exposed_raw, "9");
  assert.equal(d.approvals.find((x) => x.type === "erc20").unlimited, true);
  assert.equal(d.approvals.find((x) => x.type === "operator").usd, undefined);
});

test("scan truncation is kept in totals, multi-wallet output and the CLI; approval exposure is never claimable money", async () => {
  const out = await COMPOSE.scanEvm({ address: A }, {
    live: (id) => id === "holdings.zerion", local: () => [], call: async (id, p) => id === "holdings.zerion" ? ok({ data: [], links: { next: next("a", "untrusted.example") } }) : { ok: false, status: 404 },
  });
  assert.equal(out.partial, true);
  assert.equal(out.totals.partial, true);
  assert.equal(out.truncated_sources[0].id, "holdings.zerion");
  out.security = { approvals: [{ chain: "ethereum", token: T, spender: B, type: "erc20", allowance_raw: "9999999", how_to_revoke: "https://revoke.cash" }], coverage: {} };
  const multi = mergeWallets([{ address: A, status: "scanned", data: out }], 10000);
  assert.equal(multi.truncated_sources[0].address, A);
  assert.equal(multi.security.approvals.length, 1);
  assert.equal(multi.totals.claimable_usd, 0);
  const text = render(multi);
  assert.match(text, /^  stopped +holdings\.zerion/m);
  assert.match(text, /Active token approvals/);
});


test("an EVM fallback price is risk-checked before a honeypot can enter likely totals", async () => {
  const live = new Set(["rewards.pons", "token.market_quote", "token.goplus_evm"]);
  const d = await COMPOSE.scanEvm({ address: A }, { live: (id) => live.has(id), local: () => [], call: async (id) => {
    if (id === "rewards.pons") return ok({ items: [{ category: "creator_fees", chain: "robinhood", protocol: "Pons v2", token: T, asset: "TOK", amount: 10, usd: null, status: "ready" }], errors: [] });
    if (id === "token.market_quote") return ok({ price: 2, liquidity: 100000, price_from: "dexscreener", errors: [] });
    if (id === "token.goplus_evm") return ok({ result: { [T]: { is_honeypot: "1" } } });
    return { ok: false, status: 404 };
  } });
  assert.equal(d.findings[0].usd, 20);
  assert.equal(d.findings[0].confidence, "low");
  assert.equal(d.totals.claimable_usd, 0);
  assert.equal(d.totals.likely_usd, 0);
});
