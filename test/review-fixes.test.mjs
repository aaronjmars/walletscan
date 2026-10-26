// review-fixes.test.mjs - money math and double counts found in the 2026-10-20 review: EigenLayer per-token
// withdrawals, the Scroll twin, Zerion twins of our own reads, partial scans, closed sunset windows, the thin-market
// rule on Solana and the cache byte count. Compose functions run on a fake ctx (no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionResult, decodeFunctionData, parseAbi } from "viem";
import * as F from "../findings.mjs";
import { COMPOSE } from "../compose.mjs";
import { makeCache } from "../cache.mjs";

const A = "0x31dC14430AF73e3D91155FD98FAc4598913D089a";
const ok = (data) => ({ status: 200, ok: true, data });
// answers: route id -> { status, ok, data } or (params, over) => that; live: the route ids that are configured
const fakeCtx = (answers, live = Object.keys(answers)) => ({
  live: (id) => live.includes(id),
  local: () => [],
  call: async (id, p, over = {}) => {
    const a = answers[id];
    if (!a) return { status: 404, ok: false, data: { error: `no answer for ${id}` } };
    return typeof a === "function" ? a(p, over) : a;
  },
});
const PRICES = { "coingecko:ethereum": { price: 2000, confidence: 0.99 }, "coingecko:solana": { price: 100, confidence: 0.99 } };
const prices = (more = {}) => (p) => ok({ coins: Object.fromEntries(String(p.coins).split(",").map((k) => [k, { ...PRICES, ...more }[k]]).filter(([, v]) => v)) });
const scanBase = { "token.prices": prices(), "evm.rpc": ok({ jsonrpc: "2.0", id: 1, result: "0x3b9aca00" }) };

// ---- A1: EigenLayer ----------------------------------------------------------------------------------------
const EL = {
  dm: "0x39053d51b77dc0d36036fc1fcc8cb819df8ef37a", beacon: "0xbeac0eeeeeeeeeeeeeeeeeeeeeeeeeeeeeebeac0",
  sEigen: "0xacb55c530acdb2849e6d4f36992cd8c9d50ed8f7", bEigen: "0x83e9115d334d248ce39a6f36144aeab5b3456e75",
  sSteth: "0x93c4b944d05dfe6df7645a86cd2206016c51564d", steth: "0xae7ab96520de3a18e5e111b5eaab095312d7fe84",
};
const elAbi = parseAbi([
  "struct Withdrawal { address staker; address delegatedTo; address withdrawer; uint256 nonce; uint32 startBlock; address[] strategies; uint256[] scaledShares; }",
  "function getQueuedWithdrawals(address staker) view returns (Withdrawal[], uint256[][])",
  "function minWithdrawalDelayBlocks() view returns (uint256)",
  "function underlyingToken() view returns (address)",
  "function sharesToUnderlyingView(uint256 amountShares) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const E18 = 10n ** 18n, HEAD = 1_000_000;
// one ready withdrawal of 5000 EIGEN + 32 beacon ETH (31 left after slashing), one in escrow of stETH shares
function eigenChain(to, data) {
  const { functionName: fn, args } = decodeFunctionData({ abi: elAbi, data });
  const w = (nonce, startBlock, strategies, scaledShares) => ({ staker: A, delegatedTo: A, withdrawer: A, nonce, startBlock, strategies, scaledShares });
  const result = {
    getQueuedWithdrawals: () => [[w(0n, HEAD - 200_000, [EL.sEigen, EL.beacon], [5000n * E18, 32n * E18]), w(1n, HEAD - 10, [EL.sSteth], [E18])], [[5000n * E18, 31n * E18], [E18]]],
    minWithdrawalDelayBlocks: () => 100800n,
    underlyingToken: () => ({ [EL.sEigen]: EL.bEigen, [EL.sSteth]: EL.steth })[to],
    sharesToUnderlyingView: () => (to === EL.sSteth ? (args[0] * 11n) / 10n : args[0]),
    symbol: () => ({ [EL.bEigen]: "bEIGEN", [EL.steth]: "stETH" })[to],
    decimals: () => 18,
  }[fn]();
  return encodeFunctionResult({ abi: elAbi, functionName: fn, result });
}
const eigenCtx = () => fakeCtx({
  "evm.rpc": (p, { body }) => (body.method === "eth_blockNumber" ? ok({ result: `0x${HEAD.toString(16)}` }) : ok({ jsonrpc: "2.0", id: 1, result: eigenChain(body.params[0].to.toLowerCase(), body.params[0].data) })),
  "token.prices": prices({ "ethereum:0xec53bf9167f50cdeb3ae105f56099aaab9061f83": { price: 0.25, confidence: 0.99 }, [`ethereum:${EL.steth}`]: { price: 1990, confidence: 0.99 } }),
});

test("eigenlayer: EIGEN, stETH and beacon ETH shares become their own tokens, withdrawable after slashing", async () => {
  const d = await COMPOSE.eigenlayerWithdrawals({ address: A }, eigenCtx());
  assert.equal(d.delay_blocks, 100800);
  const [w0, w1] = d.withdrawals;
  assert.equal(w0.ready, true);
  assert.equal(w1.ready, false);
  assert.deepEqual(w0.assets.map((a) => [a.symbol, a.amount, a.usd]), [["EIGEN", 5000, 1250], ["ETH", 31, 62000]]); // bEIGEN priced as EIGEN; 31, not 32
  assert.deepEqual(w1.assets.map((a) => [a.symbol, a.amount]), [["stETH", 1.1]]); // sharesToUnderlyingView
  const f = F.eigenlayer(d, { ethUsd: 2000 });
  assert.deepEqual(f.map((x) => [x.asset, x.amount, x.usd, x.confidence]), [["EIGEN", 5000, 1250, "high"], ["ETH", 31, 62000, "high"], ["stETH", 1.1, 2189, "medium"]]);
  const t = F.summarize(f.map((x) => F.withNet(x, { gasPriceWei: 1e9, ethUsd: 2000 })), []).totals;
  assert.equal(t.claimable_usd, 63250); // not 5031 "ETH"
});

test("eigenlayer: a thin market is no price, an unreadable strategy is a low hint", async () => {
  const ctx = eigenCtx();
  const base = ctx.call;
  ctx.call = async (id, p, over) => {
    if (id === "token.prices") return ok({ coins: { "ethereum:0xec53bf9167f50cdeb3ae105f56099aaab9061f83": { price: 0.25, confidence: 0.5 } } });
    if (id === "evm.rpc" && over.body?.params?.[0]?.to?.toLowerCase() === EL.sSteth) return ok({ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted" } });
    return base(id, p, over);
  };
  const d = await COMPOSE.eigenlayerWithdrawals({ address: A }, ctx);
  assert.equal(d.withdrawals[0].assets[0].usd, null);
  const f = F.eigenlayer(d, { ethUsd: 2000 });
  assert.equal(f.find((x) => x.asset === "EIGEN").usd, null);
  assert.equal(f.find((x) => x.asset === "ETH").usd, 62000); // ETH falls back to the scan's ETH price
  const lost = f.find((x) => x.confidence === "low");
  assert.equal(lost.amount, null);
  assert.match(lost.detail, /could not be read/);
});

// ---- A2: Scroll twin ---------------------------------------------------------------------------------------
const STUCK_SCROLL = { items: [{ key: "scroll", bridge: "Scroll", status: "claimable", symbol: "ETH", value: "1", usd: 2000, tx: "0xaaa", action: "claim it" }], errors: [], bridges_checked: ["scroll"] };
const SCROLL_API = { errcode: 0, data: { results: [{ hash: "0xaaa", token_amounts: ["1000000000000000000"], l1_token_address: "0x0000000000000000000000000000000000000000", claim_info: { claimable: true } }], total: 1 } };

test("scroll: bridge.stuck and bridge.scroll read the same withdrawal, it counts once", async () => {
  const d = await COMPOSE.scanEvm({ address: A }, fakeCtx({ ...scanBase, "bridge.stuck": ok(STUCK_SCROLL), "bridge.scroll": ok(SCROLL_API) }));
  assert.equal(d.findings.filter((f) => f.category === "bridge_stuck").length, 1);
  assert.equal(d.findings[0].source, "bridge.stuck");
  assert.equal(d.totals.claimable_usd, 2000);
  assert.match(d.sources["bridge.scroll"], /^skipped: bridge.stuck covers Scroll/);
  assert.equal(d.partial, false);
  assert.deepEqual(d.failed_sources, []);
});

test("scroll: without a bridge.stuck answer, bridge.scroll stands in and the scan says it is partial", async () => {
  const d = await COMPOSE.scanEvm({ address: A }, fakeCtx({ ...scanBase, "bridge.stuck": { status: 502, ok: false, data: { error: "boom" } }, "bridge.scroll": ok(SCROLL_API) }));
  assert.deepEqual(d.findings.map((f) => [f.source, f.amount, f.usd]), [["bridge.scroll", 1, 2000]]);
  assert.equal(d.partial, true);
  assert.equal(d.totals.partial, true);
  assert.deepEqual(d.failed_sources.map((f) => f.id), ["bridge.stuck"]);
  assert.match(d.warning, /1 source failed \(bridge.stuck\)/);
});

// ---- A3: Zerion twins of our own reads ---------------------------------------------------------------------
const zerionPos = (protocol, symbol, value, qty, type = "deposit") => ({
  attributes: { position_type: type, protocol, name: symbol, value, quantity: { numeric: String(qty) }, fungible_info: { symbol, implementations: [{ chain_id: "ethereum", address: "0x5fe3" }] } },
  relationships: { chain: { data: { id: "ethereum" } } },
});

test("pendle: a matured PT is a finding; Zerion's deposit row of the same PT leaves holdings_usd", async () => {
  const d = await COMPOSE.scanEvm({ address: A }, fakeCtx({
    ...scanBase,
    "rewards.pendle": ok({ matured: [{ chain_id: 1, market: "0xf80b", name: "USDG", expiry: "2026-09-24", part: "pt", usd: 50000 }], rewards: [] }),
    "rewards.zerion": ok({ data: [zerionPos("Pendle", "PT-USDG", 50300, 50310), zerionPos("Aave", "aUSDC", 700, 700)] }),
  }));
  assert.equal(d.totals.claimable_usd, 50000);
  assert.equal(d.totals.holdings_usd, 700);
  assert.deepEqual(d.holdings.map((h) => h.protocol), ["Aave"]);
});

test("zerion twins: Lido, EigenLayer and Venice reads replace Zerion's row of the same money", () => {
  const run = {
    findings: [
      ...F.lido({ claimable_eth: 3, requests: [{ finalized: true, claimed: false }] }, { ethUsd: 2000 }),
      ...F.eigenlayer({ withdrawals: [{ ready: true, assets: [{ token: null, symbol: "ETH", amount: 31, usd: 62000 }] }] }),
      ...F.venice({ pending_vvv: 5, vvv_usd: 2, cooldown: { vvv: 100, ends: "2026-01-01T00:00:00.000Z" } }).findings.map((f) => ({ ...f, chain: "base" })),
    ],
    holdings: [
      { kind: "staked", chain: "ethereum", protocol: "Lido", asset: "unstETH", amount: 3, usd: 6000 },
      { kind: "staked", chain: "ethereum", protocol: "EigenLayer", asset: "ETH", amount: 31.2, usd: 62400 },
      { kind: "staked", chain: "base", protocol: "Venice", asset: "sVVV", amount: 100, usd: 200 },
      { kind: "staked", chain: "base", protocol: "Venice", asset: "sVVV", amount: 900, usd: 1800 }, // the stake that keeps earning stays
    ],
  };
  const out = F.dropZerionTwins(run);
  assert.deepEqual(out.holdings.map((h) => h.amount), [900]);
});

// ---- B4: Sablier fallback when Zerion fails ----------------------------------------------------------------
const SABLIER = { data: { LockupStream: [{ chainId: "1", alias: "LL3-1-7", startTime: "0", endTime: "1", depositAmount: "5000000000000000000", withdrawnAmount: "0", asset: { symbol: "X", decimals: 18 } }] } };

test("sablier: a failing Zerion no longer hides vesting streams; a working one still covers them", async () => {
  const down = await COMPOSE.scanEvm({ address: A }, fakeCtx({ ...scanBase, "rewards.zerion": { status: 429, ok: false, data: { errors: [{ title: "quota" }] } }, "rewards.sablier_streams": ok(SABLIER) }));
  assert.equal(down.sources["rewards.sablier_streams"], "ok");
  assert.deepEqual(down.findings.map((f) => [f.source, f.amount]), [["rewards.sablier_streams", 5]]);
  assert.equal(down.partial, true);
  assert.deepEqual(down.failed_sources.map((f) => f.id), ["rewards.zerion"]);
  const up = await COMPOSE.scanEvm({ address: A }, fakeCtx({ ...scanBase, "rewards.zerion": ok({ data: [] }), "rewards.sablier_streams": ok(SABLIER) }));
  assert.match(up.sources["rewards.sablier_streams"], /^skipped: rewards.zerion covers Sablier/);
  assert.equal(up.findings.length, 0);
});

// ---- A5: closed sunset windows -----------------------------------------------------------------------------
test("sunset: a Zerion balance on a chain whose exit window closed is a low expired hint, not a holding", async () => {
  const { sunsetDeadlines, SUNSET } = await import("../chains/index.mjs");
  const zslug = (await import("../chains/zerion-chains.json", { with: { type: "json" } })).default;
  const slugOf = new Map(Object.entries(zslug).filter(([k]) => k !== "_").map(([k, v]) => [v, k]));
  const closed = SUNSET.find((s) => s.closes && s.closes < "2026-10-20" && slugOf.has(Number(s.chain_id)));
  assert.ok(closed, "a closed sunset chain with a Zerion slug");
  const slug = slugOf.get(Number(closed.chain_id));
  const dl = sunsetDeadlines([], { now: Date.parse("2026-10-20") });
  const row = dl.find((d) => d.match.chain === slug);
  assert.equal(row.expired, true);
  const ans = { data: [{ attributes: { value: 5000, quantity: { numeric: "2" }, fungible_info: { symbol: "ETH", flags: { verified: true }, implementations: [{ chain_id: slug, address: null }] } }, relationships: { chain: { data: { id: slug } } } }] };
  const { findings, holdings } = F.zerionHoldings(ans, { deadlines: dl });
  assert.equal(holdings.length, 0);
  assert.deepEqual([findings[0].category, findings[0].confidence, findings[0].expired], ["bridge_stuck", "low", true]);
  assert.match(findings[0].action, new RegExp(`exit window closed on ${closed.closes}`));
  assert.equal(F.summarize(findings, holdings).totals.likely_usd, 0);
});

// ---- A4: thin markets on Solana ----------------------------------------------------------------------------
test("solana thin markets: vesting, airdrops, Serum leftovers and Drift claims go low; holdings unverified", () => {
  const stream = { category: "vesting", stream: "st1", sender: "snd", asset: "TEAM", token: "mintT", decimals: 0, deposited: "2000000", withdrawn: "0", cliff: "0", cliff_amount: "0", end: "1", period: "1", amount_per_period: "2000000", ends: "1970-01-01", verified: true, price: 0.5, liquidity: 40000, how_to_claim: "x" };
  const s = F.solStreams({ items: [stream] }, { now: 2000 });
  assert.equal(s.findings[0].usd, 1e6);
  assert.equal(s.findings[0].confidence, "low");
  assert.match(s.findings[0].detail, /thin market \(about \$40000 liquidity\)/);
  assert.equal(F.solStreams({ items: [{ ...stream, liquidity: 5e6 }] }, { now: 2000 }).findings[0].confidence, "high");
  assert.equal(F.solStreams({ items: [{ ...stream, liquidity: null }] }, { now: 2000 }).findings[0].confidence, "high"); // no figure, no call

  const [air] = F.streamflow({ items: [{ distributor: "d", mint: "m", symbol: "AIR", claimable: 1e5, usd: 50000, verified: true, liquidity: 30000, claim_url: "u" }] });
  assert.equal(air.confidence, "low");

  const [serum] = F.solLeftovers({ items: [{ protocol: "Serum", category: "unstake_ready", asset: "OLD", token: "m2", amount: 1000, usd: 900, price: 0.9, verified: true, liquidity: 1000, status: "ready", vault_covers: true }] });
  assert.equal(serum.confidence, "low");

  const [dfx] = F.perpsFindings({ items: [{ protocol: "Drift", chain: "solana", asset: "DFX", amount: 1e6, usd: 36000, status: "closed", confidence: "high", liquidity: 20000, detail: "DFX" }] }, { source: "holdings.perps_sol" });
  assert.equal(dfx.confidence, "low");
  assert.equal(F.perpsFindings({ items: [{ protocol: "Drift", chain: "solana", asset: "DFX", amount: 1900, usd: 68, status: "closed", confidence: "high", liquidity: 190000, detail: "DFX" }] })[0].confidence, "high");

  const das = { result: { items: [{ interface: "FungibleToken", id: "mintH", token_info: { symbol: "HOLD", balance: 1000, decimals: 0, price_info: { total_price: 10000 } } }] } };
  const { holdings } = F.solHoldings(das, [{ id: "mintH", isVerified: true, liquidity: 15000 }]);
  assert.equal(holdings[0].verified, false);
  assert.match(holdings[0].detail, /thin market/);
});

// ---- C1: cache byte count ----------------------------------------------------------------------------------
test("cache: counts UTF-8 bytes; a route can raise its entry cap (the 1.8 MB Pendle list)", () => {
  const big = { markets: "x".repeat(1_800_000) };
  const c = makeCache({ maxEntryBytes: 1 << 20 });
  assert.equal(c.set("a", big, 60), false); // over the 1 MB default
  assert.equal(c.set("a", big, 60, { maxBytes: 4096 * 1024 }), true);
  assert.equal(c.get("a").value.markets.length, 1_800_000);
  assert.ok(c.stats().bytes < 1_900_000); // real bytes, not 2 x length
  assert.equal(c.set("b", { s: "x".repeat(600_000) }, 60), true); // 600 KB fits under 1 MB now (it counted 1.2 MB before)
});

test("scroll: bridge.stuck skipped Scroll for a missing key, bridge.scroll stands in and the scan is not partial", async () => {
  const skipped = { items: [], errors: [], skipped: [{ bridge: "scroll", key: "ALCHEMY_API_KEY", why: "full-history event logs on scroll-mainnet: no keyless source, needs ALCHEMY_API_KEY" }], bridges_checked: ["base"] };
  const d = await COMPOSE.scanEvm({ address: A }, fakeCtx({ ...scanBase, "bridge.stuck": ok(skipped), "bridge.scroll": ok(SCROLL_API) }));
  assert.deepEqual(d.findings.map((f) => [f.source, f.amount, f.usd]), [["bridge.scroll", 1, 2000]]);
  assert.equal(d.sources["bridge.scroll"], "ok");
  assert.equal(d.partial, false);
  assert.deepEqual(d.skipped_for_keys.filter((x) => x.id === "bridge.stuck"), [{ id: "bridge.stuck", key: "ALCHEMY_API_KEY", why: `scroll: ${skipped.skipped[0].why}` }]);
});
