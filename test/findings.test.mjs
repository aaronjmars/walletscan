// findings.test.mjs - normalizers on real upstream answers captured 2026-10-15 (test/fixtures), plus Solana PDA math
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as F from "../findings.mjs";
import { ata, pumpVaults, isSolAddr, isEvmAddr } from "../solana.mjs";

const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const V = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const S = "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq";

test("solana rent: empty accounts are summed, non-empty ones give the rent-cut surplus", () => {
  const out = F.solRent([fx("sol-token-accounts.json")], { solUsd: 100, rentMin165: 1488440 });
  const rent = out.find((f) => f.category === "solana_rent");
  assert.equal(rent.amount, 0.010196); // 5 x 2,039,280 lamports
  assert.equal(Math.round(rent.usd * 1e4) / 1e4, 1.0196);
  assert.match(rent.action, /close 5 empty token accounts/);
  const extra = out.find((f) => f.category === "solana_rent_surplus");
  assert.equal(extra.amount, 0.001653); // 3 x (2,039,280 - 1,488,440) lamports, rounded
  assert.equal(extra.confidence, "medium");
});

test("solana rent: frozen accounts and Token-2022 accounts with withheld fees are not counted", () => {
  const row = (state, ext) => ({ pubkey: "x", account: { lamports: 2039280, space: 165, data: { parsed: { info: { state, tokenAmount: { amount: "0" }, ...(ext && { extensions: [ext] }) } } } } });
  const out = F.solRent([{ result: { value: [row("frozen"), row("initialized", { extension: "transferFeeAmount", state: { withheldAmount: 5 } }), row("initialized")] } }], { solUsd: 100, rentMin165: null });
  assert.equal(out.length, 1);
  assert.match(out[0].action, /close 1 empty/);
  assert.match(out[0].detail, /1 more are frozen/);
  assert.match(out[0].detail, /1 Token-2022/);
});

test("solana stake: deactivated or undelegated stake is withdrawable, active stake is not", () => {
  const acc = (deact) => ({ pubkey: "st", account: { lamports: 2e9, data: { parsed: { info: { stake: deact === undefined ? undefined : { delegation: { deactivationEpoch: deact } } } } } } });
  const out = F.solStakes({ result: [acc("18446744073709551615"), acc("700"), acc(undefined)] }, { solUsd: 100, epoch: 800 });
  assert.equal(out.length, 2);
  assert.equal(out[0].usd, 200);
});

test("solana holdings: priced fungibles only, Jupiter verification marks trust", () => {
  const das = fx("helius-das.json");
  const priced = das.result.items.filter((i) => i.token_info?.price_info);
  const jup = [{ id: priced[0].id, isVerified: true, tags: ["verified"], liquidity: 1e9 }];
  const { holdings, unpriced } = F.solHoldings(das, jup, { minUsd: 0 });
  assert.equal(unpriced, 2);
  assert.ok(holdings.find((h) => h.asset === "SOL"));
  assert.equal(holdings.find((h) => h.mint === priced[0].id).verified, true);
});

test("merkl: claimable = amount - claimed, priced with the token price", () => {
  const out = F.merkl(fx("merkl.json"), { address: V });
  assert.equal(out.length, 1);
  assert.equal(out[0].asset, "ZARP");
  assert.equal(out[0].chain, "ethereum");
  assert.ok(out[0].usd > 0 && out[0].usd < 0.001);
  assert.equal(out[0].how_to_claim, `https://app.merkl.xyz/users/${V}`);
});

test("zerion: reward rows are findings (medium: Zerion's own read), unpriced ones low, loans are negative holdings", () => {
  const ans = fx("zerion-rewards.json");
  ans.data.push({ attributes: { position_type: "reward", value: null, quantity: { numeric: "5" }, fungible_info: { symbol: "FakeDontBuy" }, protocol: "clanker world" }, relationships: { chain: { data: { id: "base" } } } });
  ans.data.push({ attributes: { position_type: "loan", value: 9, quantity: { numeric: "9" }, fungible_info: { symbol: "USDC" }, protocol: "Venice" }, relationships: { chain: { data: { id: "base" } } } });
  ans.data.push({ attributes: { position_type: "deposit", value: 50, quantity: { numeric: "50" }, fungible_info: { symbol: "S*USDC" }, protocol: "Stargate" }, relationships: { chain: { data: { id: "ethereum" } } } });
  const { findings, holdings } = F.zerionPositions(ans, { deadlines: fx("../../data/deadlines.json") });
  const rewards = findings.filter((f) => f.category === "reward");
  assert.equal(rewards.filter((f) => f.confidence === "medium").length, 3);
  assert.equal(rewards.find((f) => f.asset === "FakeDontBuy").confidence, "low");
  assert.equal(rewards[0].how_to_claim, "https://app.uniswap.org/pools");
  const stargate = findings.find((f) => f.category === "token_migration");
  assert.equal(stargate.deadline, "2026-12-15");
  assert.equal(holdings.length, 2);
  assert.equal(holdings.find((h) => h.kind === "loan").usd, -9);
});

test("zerion holdings: MKR matches the migration table", () => {
  const ans = { data: [{ attributes: { value: 1500, quantity: { numeric: "1" }, fungible_info: { symbol: "MKR", flags: { verified: true }, implementations: [{ chain_id: "ethereum", address: "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2" }] } }, relationships: { chain: { data: { id: "ethereum" } } } }] };
  const { findings, holdings } = F.zerionHoldings(ans, { deadlines: fx("../../data/deadlines.json") });
  assert.equal(findings[0].category, "token_migration");
  assert.match(findings[0].detail, /penalty/);
  assert.equal(holdings[0].verified, true);
});

test("zerion holdings: a balance left on Polygon zkEVM is an exit claim, not a holding", () => {
  const ans = { data: [{ attributes: { value: 5.02, quantity: { numeric: "0.002" }, fungible_info: { symbol: "ETH", flags: { verified: true }, implementations: [{ chain_id: "polygon-zkevm", address: null }] } }, relationships: { chain: { data: { id: "polygon-zkevm" } } } }] };
  const { findings, holdings } = F.zerionHoldings(ans, { deadlines: fx("../../data/deadlines.json") });
  assert.equal(findings[0].category, "bridge_stuck");
  assert.equal(findings[0].deadline, "2027-12-31");
  assert.equal(findings[0].how_to_claim, "https://zkevm-claims.polygon.technology");
  assert.equal(holdings.length, 0);
});

test("polymarket: redeemable rows with value become winnings", () => {
  const out = F.polymarket(fx("polymarket.json"));
  assert.equal(out.length, 1);
  assert.equal(out[0].category, "prediction_winnings");
  assert.equal(out[0].usd, 52.2388);
});

test("polymarket: open bets with a value are holdings, resolved ones are not", () => {
  const rows = [...fx("polymarket.json"), { title: "Will X happen?", outcome: "Yes", size: 40, currentValue: 22.5, redeemable: false }, { title: "Lost", outcome: "No", size: 10, currentValue: 0, redeemable: false }];
  const out = F.polymarketOpen(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].usd, 22.5);
  assert.equal(out[0].protocol, "Polymarket");
});

test("hyperliquid referral: zero unclaimed gives nothing", () => {
  assert.deepEqual(F.hyperliquidReferral(fx("hl-referral.json")), []);
  assert.equal(F.hyperliquidReferral({ unclaimedRewards: "12.5" })[0].usd, 12.5);
});

test("sablier: testnet streams are skipped, mainnet streamed-not-withdrawn is found", () => {
  assert.deepEqual(F.sablier(fx("sablier.json")), []); // the fixture streams are all Sepolia
  const s = { data: { LockupStream: [{ alias: "LL-1-1", chainId: "1", asset: { symbol: "USDC", decimals: "6" }, depositAmount: "1000000000", withdrawnAmount: "0", startTime: "0", endTime: "100" }] } };
  assert.equal(F.sablier(s, { now: 1000 })[0].amount, 1000);
});

test("ccip: messages ready for manual execution", () => {
  const out = F.ccip(fx("ccip-manual.json"));
  assert.ok(out.length >= 1);
  assert.match(out[0].how_to_claim, /^https:\/\/ccip\.chain\.link\/msg\/0x/);
  assert.equal(out[0].confidence, "high");
});

test("across: unfilled deposits are low-confidence hints only", () => {
  const out = F.across(fx("across.json"));
  assert.equal(out.length, 2);
  assert.ok(out.every((f) => f.confidence === "low" && f.usd == null));
});

test("lifi, mayan: completed transfers give nothing", () => {
  assert.deepEqual(F.lifi(fx("lifi.json")), []);
  assert.deepEqual(F.mayan(fx("mayan.json")), []);
  const failed = { transfers: [{ status: "FAILED", substatus: "UNKNOWN", sending: { chainId: 1, amountUSD: "40", token: { symbol: "USDC" }, timestamp: 1 }, receiving: { chainId: 8453 }, tool: "x", lifiExplorerLink: "https://scan.li.fi/tx/0x1" }] };
  assert.equal(F.lifi(failed)[0].usd, 40);
});

test("stuck: claimable items become findings, blocked ones low, waiting ones dropped", () => {
  const items = [
    { key: "base", bridge: "Base", status: "ready-to-finalize", symbol: "ETH", value: 0.5, usd: 1200, tx: "0xa", action: "finalize on Ethereum" },
    { bridge: "Ronin", status: "blocked", symbol: "USDC", value: 10, usd: 10, tx: "0xb" },
    { bridge: "Base", status: "waiting", symbol: "ETH", value: 1, usd: 2400, tx: "0xc" },
  ];
  const out = F.stuck({ items });
  assert.equal(out.length, 2);
  assert.equal(out[0].how_to_claim, "https://superbridge.app/base");
  assert.equal(out[1].category, "bridge_blocked");
});

test("summarize: low confidence and migrations stay out of totals, unverified holdings apart", () => {
  const env = { ethUsd: 2000, solUsd: 100, gasPriceWei: 1e9 };
  const f = [
    { category: "reward", chain: "ethereum", usd: 100, confidence: "high" },
    { category: "reward", chain: "base", usd: 50, confidence: "medium" },
    { category: "bridge_stuck", chain: "ethereum", usd: null, confidence: "low" },
    { category: "token_migration", chain: "ethereum", usd: 900, confidence: "high", deadline: null },
    { category: "reward", chain: "base", usd: 0.2, confidence: "high" },
  ].map((x) => F.withNet(x, env));
  assert.equal(f[0].net_after_fees_usd, 99.7); // 150k gas x 1 gwei x $2000 = $0.30
  const s = F.summarize(f, [{ usd: 10, verified: true }, { usd: 1e6, verified: false }, { kind: "locked", usd: 5000, verified: true }, { kind: "loan", usd: -3, verified: true }], { minUsd: 1 });
  assert.equal(s.totals.claimable_usd, 100); // high only
  assert.equal(s.totals.likely_usd, 50); // medium: Zerion's read or an estimate
  assert.equal(s.totals.holdings_usd, 7); // locked vault shares out, the loan netted
  assert.equal(s.totals.locked_usd, 5000);
  assert.equal(s.totals.debt_usd, -3);
  assert.equal(s.totals.unverified_holdings_usd, 1e6);
  assert.equal(s.hidden_below_min_usd, 1);
});

test("summarize: biggest first, low hints and closed windows last", () => {
  const f = [
    { category: "airdrop", usd: 1, confidence: "high" },
    { category: "reward", usd: 62, confidence: "medium" },
    { category: "bridge_stuck", usd: 500, confidence: "low" },
    { category: "bridge_stuck", usd: 0.3, confidence: "low", deadline: "2026-09-30", expired: true },
    { category: "unstake_ready", usd: 7, confidence: "high" },
  ];
  assert.deepEqual(F.summarize(f, [], { minUsd: 0 }).findings.map((x) => x.usd), [62, 7, 1, 500, 0.3]);
});

test("every-chain sweep: a past exit window is marked expired and low", () => {
  const { findings } = F.chainSweep({ sunset: [{ name: "Moonriver", chain: "moonriver", chain_id: 1285, closes: "2026-09-30", exit: "bridge out", read: "rpc", balances: [{ asset: "MOVR", amount: 0.1, usd: 0.28, verified: true }] }] });
  assert.equal(findings[0].expired, true);
  assert.equal(findings[0].confidence, "low");
  assert.match(findings[0].action, /window closed on 2026-09-30/);
});

test("pendle: PT, YT and LP left in expired markets and merkle rewards become findings", () => {
  const out = F.pendle({
    matured: [{ chain_id: 1, market: "0xf80b", name: "USDG", expiry: "2026-09-24", part: "pt", usd: 202622.56 }, { chain_id: 42161, market: "0xaa", name: "weETH", expiry: "2026-06-26", part: "yt", usd: 3.1 }],
    rewards: [{ chain_id: 1, token: "0x6f40", symbol: "FLUID", amount: 0.0061, usd: 0.0137, title: "Pendle rewards" }],
  });
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((x) => [x.category, x.chain, x.asset]), [["unstake_ready", "ethereum", "PT-USDG"], ["reward", "arbitrum", "YT-weETH"], ["reward", "ethereum", "FLUID"]]);
  assert.ok(out.every((x) => x.confidence === "high" && x.source === "rewards.pendle"));
  assert.match(out[0].action, /redeem the matured PT \(USDG, expired 2026-09-24\)/);
});

test("venice: rewards and a finished cooldown are findings, DIEM minted is a debt", () => {
  const { findings, holdings } = F.venice({ locked_svvv: 3.2886, diem_debt: 0.004945, pending_vvv: 0.013257, vvv_usd: 24.25, diem_usd: 1816.69, cooldown: { vvv: 2, ends: "2026-01-01T00:00:00.000Z" } });
  assert.deepEqual(findings.map((x) => x.category), ["reward", "unstake_ready"]);
  assert.equal(Math.round(findings[0].usd * 100) / 100, 0.32);
  assert.equal(holdings[0].kind, "loan");
  assert.equal(holdings[0].usd, -8.98);
  assert.equal(F.venice({ locked_svvv: 0, diem_debt: 0, pending_vvv: 0, cooldown: { vvv: 1, ends: "2999-01-01T00:00:00.000Z" } }).findings.length, 0); // cooldown not over yet
});

test("goplus: scams are spam, a trusted token turns verified, warnings land in detail", () => {
  const scam = F.goplusVerdict({ is_honeypot: "1", is_airdrop_scam: "0", sell_tax: "0" });
  assert.match(scam.spam, /honeypot/);
  const h = F.applyGoplus({ kind: "token", usd: 80, verified: false, detail: "not verified by Zerion: check before selling" }, scam);
  assert.equal(h.spam, true);
  const reward = F.applyGoplus({ category: "reward", usd: 60, confidence: "medium" }, F.goplusVerdict({ fake_token: { value: 1 } }));
  assert.equal(reward.confidence, "low");
  const ok = F.applyGoplus({ kind: "token", usd: 5, verified: false, detail: "not verified by Zerion: check before selling" }, F.goplusVerdict({ trust_list: "1", sell_tax: "0.1" }));
  assert.equal(ok.verified, true);
  assert.equal(ok.detail, "on GoPlus's trust list; GoPlus: sell tax 10%");
  const sol = F.goplusVerdict({ balance_mutable_authority: { status: "1", authority: [] }, freezable: { status: "1", authority: [] }, trusted_token: 0 }, { solana: true });
  assert.match(sol.spam, /change balances/);
  assert.match(sol.warn, /freeze/);
  assert.equal(F.goplusVerdict({ freezable: { status: "1", authority: [] }, trusted_token: 1 }, { solana: true }).warn, null); // USDC: freezable but trusted
});

test("goplus: a thin market keeps a lock out of the totals (10M OPAL priced at $1.08M, ~$117 in DEX pools)", async () => {
  const { readFileSync } = await import("node:fs");
  const locks = JSON.parse(readFileSync(new URL("./fixtures/batch-d-locks.json", import.meta.url), "utf8"));
  const [opal] = F.tokenLocks(locks);
  assert.equal(opal.confidence, "high");
  const v = F.goplusVerdict({ is_honeypot: "0", trust_list: null, dex: [{ name: "UniswapV4", liquidity: "90.87" }, { name: "UniswapV4", liquidity: "21.68" }, { name: "UniswapV2", liquidity: "4.48" }] });
  assert.equal(Math.round(v.liquidity), 117);
  F.applyGoplus(opal, v);
  assert.equal(opal.confidence, "low");
  assert.match(opal.detail, /thin market \(about \$117 DEX liquidity/);
  assert.equal(F.summarize([opal], []).totals.claimable_usd, 0);
  // deep pools or a trusted token: unchanged
  const deep = F.applyGoplus({ category: "reward", usd: 1000, confidence: "high" }, F.goplusVerdict({ dex: [{ liquidity: "5000000" }] }));
  assert.equal(deep.confidence, "high");
  assert.equal(F.applyGoplus({ category: "reward", usd: 1000, confidence: "high" }, F.goplusVerdict({ trust_list: "1", dex: [{ liquidity: "10" }] })).confidence, "high");
});

test("dedupe: a position and its receipt token, or one pool under two names, count once", () => {
  const h = [
    { kind: "staked", chain: "base", asset: "sVVV", amount: 3.288603222404098, usd: 79.73, verified: true, protocol: "Venice" },
    { kind: "token", chain: "base", asset: "sVVV", amount: 3.288603222404098, usd: 79.73, verified: false },
    { kind: "deposit", chain: "ethereum", asset: "mUSD", amount: 0.0689, usd: 0.07, verified: true, detail: "mStable mUSD Pool" },
    { kind: "deposit", chain: "ethereum", asset: "mUSD", amount: 0.0689, usd: 0.07, verified: true, detail: "mStable Yield: mUSD Pool" },
    { kind: "token", chain: "ethereum", asset: "USDC", amount: 10, usd: 10, verified: true },
    { kind: "loan", chain: "base", asset: "USDC", amount: 10, usd: -10, verified: true },
    { kind: "loan", chain: "base", asset: "USDC", amount: 10, usd: -10, verified: true },
  ];
  const out = F.dedupeHoldings(h);
  assert.deepEqual(out.map((x) => `${x.kind}:${x.asset}`), ["staked:sVVV", "deposit:mUSD", "token:USDC", "loan:USDC", "loan:USDC"]);
});

test("every-chain sweep: priced balances are holdings, sunset balances are exit findings, deposits a low hint", () => {
  const today = new Date().toISOString().slice(0, 10);
  const { findings, holdings } = F.chainSweep(fx("chains.json"), { minUsd: 1 });
  assert.equal(holdings.find((h) => h.chain === "morph").asset, "ETH");
  assert.ok(holdings.every((h) => h.usd >= 1 && h.source === "holdings.chains"));
  assert.equal(holdings.find((h) => h.chain === "fuse"), undefined); // $0.03, under min_usd
  assert.match(holdings.find((h) => h.asset === "xAI").detail, /explorer only/);
  assert.equal(holdings.find((h) => h.asset === "xAI").verified, false);
  const zk = findings.find((f) => f.chain === "polygon-zkevm");
  assert.equal(zk.category, "bridge_stuck");
  assert.equal(zk.deadline, "2027-12-31");
  const blast = findings.find((f) => f.chain === "blast" && f.asset === "WETH");
  assert.equal(blast.confidence, blast.deadline >= today ? "medium" : "low");
  assert.equal(findings.find((f) => f.chain === "moonbeam").confidence, "low"); // its exit window closed 2026-09-30
  const red = findings.find((f) => f.chain === "redstone");
  assert.equal(red.usd, null);
  assert.equal(red.confidence, "low");
  assert.match(red.action, /bridged to Redstone \(1 deposit, last 2024-05-02\)/);
});

test("every-chain sweep vs Zerion: only what Zerion missed stays, nothing counts twice", () => {
  const z = (chain, symbol, address, value) => ({ attributes: { value, quantity: { numeric: "1" }, fungible_info: { symbol, implementations: [{ chain_id: chain, address }] } }, relationships: { chain: { data: { id: chain } } } });
  const seen = F.zerionSeen({ data: [z("ethereum", "ETH", null, 94.6), z("ethereum", "kpdUSDC", "0x7b5a0182e400b241b317e781a4e9dedfc1429822", null)] });
  const { holdings } = F.chainSweep(fx("chains.json"), { minUsd: 1 });
  const kept = holdings.filter((h) => !F.zerionDrops(seen, h)).map((h) => `${h.chain}:${h.asset}`);
  assert.ok(!kept.includes("ethereum:ETH")); // Zerion has it, priced
  assert.ok(kept.includes("ethereum:kpdUSDC")); // Zerion has no price for it: the sweep's read counts
  assert.ok(!kept.includes("ethereum:xAI")); // unverified on a Zerion chain: left to Zerion's spam filter
  assert.ok(kept.includes("morph:ETH") && kept.includes("mode:ETH"));
  // Zerion gives MNT on Mantle a token address, the sweep reads it as native: matched by symbol
  const seen2 = F.zerionSeen({ data: [z("mantle", "MNT", "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000", 2.27)] });
  assert.ok(F.zerionDrops(seen2, { source: "holdings.chains", chain: "mantle", asset: "MNT", verified: true }));
});

test("sunset table: sourced rows, Zerion slugs become exit deadlines", async () => {
  const rows = fx("../../data/sunset-chains.json");
  assert.ok(rows.length >= 50);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  for (const r of rows) {
    assert.ok(["shut_down", "closing"].includes(r.status), r.id);
    assert.match(r.source, /^https:\/\//, r.id);
    assert.ok(r.exit && !/[\u2013\u2014]/.test(JSON.stringify(r)), r.id);
  }
  const { sunsetDeadlines } = await import("../chains/index.mjs");
  const dl = fx("../../data/deadlines.json");
  const extra = sunsetDeadlines(dl);
  assert.ok(!extra.find((d) => d.id === "gravity-alpha" || d.match.chain === "polygon-zkevm")); // already in deadlines.json
  const blast = extra.find((d) => d.match.chain === "blast");
  if (blast) { // after its window closes it stays in, expired (a low hint)
    const ans = { data: [{ attributes: { value: 3.1, quantity: { numeric: "0.0013" }, fungible_info: { symbol: "WETH", flags: { verified: true }, implementations: [{ chain_id: "blast", address: "0x4300000000000000000000000000000000000004" }] } }, relationships: { chain: { data: { id: "blast" } } } }] };
    const { findings, holdings } = F.zerionHoldings(ans, { deadlines: [...dl, ...extra] });
    assert.equal(findings[0].category, "bridge_stuck");
    assert.equal(findings[0].deadline, "2026-10-26");
    assert.equal(holdings.length, 0);
  }
});

test("solana math: ATA and PDA derivation", () => {
  // the wallet's USDC associated token account, as seen onchain
  assert.equal(ata(S, "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), "3tBMiT532p88a2oSR7UqXZvNLAtcvtnVMrn3FvphvtGK");
  const v = pumpVaults(S);
  assert.ok(isSolAddr(v.curve) && isSolAddr(v.ammWsol));
  assert.ok(isEvmAddr(V) && !isEvmAddr(S) && !isSolAddr(V));
});

test("jupiter airdrops: eligible + not claimed + open = high, not open yet = low; claimed, expired, ineligible dropped", () => {
  const item = (o) => ({ label: "TOK", address: "Mint1111", amount: 100, isEligible: true, isClaimed: false, value: 25, status: "1_claimable", ...o });
  const answer = [{ owner: S, airdrops: [
    { id: "open-drop", emitterName: "Open", status: "2_open", claimLink: "https://claim.open", claimEnd: Date.parse("2026-12-01"), items: [item(), item({ isClaimed: true, status: "3_claimed" }), item({ isEligible: false, status: "5_ineligible" })] },
    { id: "soon", emitterName: "Soon", status: "1_upcoming", claimStart: Date.parse("2026-11-01"), items: [item({ label: "SOON" })] },
    { id: "gone", emitterName: "Gone", status: "3_closed", claimEnd: Date.parse("2025-01-01"), items: [item({ status: "4_claimExpired" })] },
  ] }];
  const out = F.jupiterAirdrops(answer, { now: Date.parse("2026-10-15") });
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].asset, out[0].confidence, out[0].usd, out[0].deadline, out[0].how_to_claim], ["TOK", "high", 25, "2026-12-01", "https://claim.open"]);
  assert.equal(out[1].confidence, "low");
  assert.match(out[1].action, /opens 2026-11-01/);
});

test("streamflow airdrops: Jupiter-verified mints are medium, Streamflow-only verified are low hints", () => {
  const out = F.streamflow({ items: [
    { distributor: "D1", name: "Real", mint: "M1", symbol: "AAA", claimable: 10, locked: 5, vesting_end: "2027-01-01", usd: 20, verified: true, liquidity: 1e6, claim_url: "https://app.streamflow.finance/airdrop/solana/mainnet/D1" },
    { distributor: "D2", name: "", mint: "M2", symbol: "BBB", claimable: 1, locked: 0, usd: 3, verified: false, liquidity: 2 },
  ] });
  assert.equal(out[0].confidence, "medium");
  assert.match(out[0].detail, /5 more still vesting until 2027-01-01/);
  assert.equal(out[1].confidence, "low");
  assert.match(out[1].detail, /not verified by Jupiter.*thin market/);
});

test("legacy claims: findings with no deadline; migrations, rewards and DSProxy smart wallet count in totals", () => {
  const f = F.legacy({ items: [
    { kind: "bridge_stuck", protocol: "ZKsync Lite", asset: "DAI", amount: 1.13, usd: 1.13, action: "claim DAI left on ZKsync Lite", how_to_claim: "https://lite.zksync.io", detail: "x" },
    { kind: "token_migration", protocol: "DigixDAO", asset: "DGD", amount: 10, usd: 4800, action: "redeem DGD for ETH", how_to_claim: "https://etherscan.io", detail: "y" },
    { kind: "token_migration", protocol: "Kyber", asset: "KNCL", amount: 100, usd: 12, action: "migrate KNCL to KNC", how_to_claim: "https://etherscan.io", detail: "z" },
    { kind: "reward", protocol: "Zora", chain: "base", asset: "ETH", amount: 0.05, usd: 120, action: "withdraw Zora creator rewards", how_to_claim: "https://zora.co", detail: "rewards" },
    { kind: "reward", protocol: "DSProxy", asset: "ETH", amount: 1.5, usd: 3600, action: "withdraw ETH left in your DSProxy smart wallet", how_to_claim: "https://tokensaver.fyi", detail: "proxy" },
    { kind: "reward", protocol: "Liquity", asset: "ETH", amount: 0, usd: 0 },
  ] });
  assert.equal(f.length, 5);
  assert.equal(f.find((x) => x.protocol === "Zora").chain, "base");
  assert.equal(f.find((x) => x.protocol === "DSProxy").chain, "ethereum");
  assert.equal(f.find((x) => x.protocol === "Kyber").category, "token_migration");
  assert.ok(f.every((x) => x.confidence === "high" && x.source === "rewards.legacy" && x.deadline === null));
  const migration = { category: "token_migration", asset: "USDC", usd: 100, confidence: "high", source: "holdings.zerion" }; // already a holding
  assert.equal(F.summarize([...f, migration], [], { minUsd: 1 }).totals.claimable_usd, 8533.13);
});

test("hyperliquid: HyperCore rows become holdings, thin spot markets stay unverified", () => {
  const h = F.hyperliquid({ items: [
    { kind: "token", asset: "MAX", amount: 1093.9, usd: 2000, verified: false, detail: "thin market" },
    { kind: "position", asset: "USDC", amount: 50, usd: 50, verified: true, protocol: "Hyperliquid perps" },
    { kind: "token", asset: "USDC", amount: 0.0000005, usd: 0.0000005, verified: true },
  ] }, { minUsd: 1 });
  assert.deepEqual(h.map((x) => `${x.kind}:${x.asset}:${x.verified}`), ["token:MAX:false", "position:USDC:true"]);
  assert.ok(h.every((x) => x.chain === "hypercore" && x.source === "holdings.hyperliquid"));
  assert.equal(F.summarize([], h).totals.holdings_usd, 50);
});

test("every-chain sweep: a vault share that cannot be withdrawn is a locked holding", () => {
  const { holdings } = F.chainSweep({ balances: [{ chain_id: 1, chain: "ethereum", asset: "kpdUSDC", token: "0x7b5a", amount: 5002.3, usd: 5000.4, verified: true, locked: true, price_from: "defillama", source: "alchemy" }] });
  assert.equal(holdings[0].kind, "locked");
  assert.match(holdings[0].detail, /maxWithdraw 0/);
  assert.equal(holdings[0].how_to_claim, "https://etherscan.io/token/0x7b5a");
  assert.equal(F.summarize([], holdings).totals.locked_usd, 5000.4);
});

test("zerion: a time lock past its end date is a withdraw finding, a running one stays a locked holding", () => {
  const pos = (name, value) => ({ attributes: { position_type: "locked", name, value, quantity: { numeric: "2" }, fungible_info: { symbol: "PRIME" }, protocol: "Wayfinder", application_metadata: { url: "https://wayfinder.ai" } }, relationships: { chain: { data: { id: "base" } } } });
  const { findings, holdings } = F.zerionPositions({ data: [pos("Wayfinder PRIME Pool (2025-02-08T12:34:01Z)", 0.44), pos("Wayfinder PRIME Pool (2027-02-08T12:34:01Z)", 0.44), pos("Hedgey NET Pool (#3398)", null)] }, { now: Date.parse("2026-10-16") });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].category, "unstake_ready");
  assert.equal(findings[0].confidence, "medium");
  assert.match(findings[0].action, /the Wayfinder lock ended on 2025-02-08: withdraw it/);
  assert.deepEqual(holdings.map((h) => h.kind), ["locked", "locked"]);
});

test("eigenlayer: one finding per token and state, ready = high, in escrow = medium, never summed across tokens", () => {
  const eth = (amount, usd = null) => ({ strategy: "0xbeac0eeeeeeeeeeeeeeeeeeeeeeeeeeeeeebeac0", token: null, symbol: "ETH", amount, usd });
  const data = {
    withdrawals: [
      { nonce: "1", start_block: 20000000, ready: true, blocks_remaining: 0, approx_hours_remaining: 0, assets: [eth(5.5), { strategy: "0xacb5", token: "0x83e9", symbol: "EIGEN", amount: 5000, usd: 1175 }] },
      { nonce: "2", start_block: 26200000, ready: false, blocks_remaining: 66600, approx_hours_remaining: 222, assets: [eth(10)] },
    ],
  };
  const f = F.eigenlayer(data, { ethUsd: 2500 });
  assert.deepEqual(f.map((x) => [x.asset, x.amount, x.usd, x.confidence]), [["ETH", 5.5, 13750, "high"], ["EIGEN", 5000, 1175, "high"], ["ETH", 10, 25000, "medium"]]);
  assert.match(f[0].action, /complete 1 finished EigenLayer queued withdrawal of ETH/);
  assert.match(f[2].action, /escrow \(~222h remaining\)/);
  assert.ok(f.every((x) => x.protocol === "EigenLayer"));
});

test("scroll bridge: decimals per token, unknown tokens unscaled, a withdrawal not yet finalized is medium", () => {
  const answer = {
    errcode: 0,
    data: {
      results: [
        { hash: "0xabc", token_amounts: ["1500000000000000000"], l1_token_address: "0x0000000000000000000000000000000000000000", claim_info: { claimable: true } },
        { hash: "0xdef", token_amounts: ["2500000"], l1_token_address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", claim_info: { claimable: false } },
        { hash: "0x123", token_amounts: ["500000000000000000"], l1_token_address: "0x1234567890123456789012345678901234567890", claim_info: { claimable: true } },
      ],
      total: 3,
    },
  };
  const f = F.scrollBridge(answer, { ethUsd: 2000 });
  assert.deepEqual(f.map((x) => [x.asset, x.amount, x.usd, x.confidence]), [["ETH", 1.5, 3000, "high"], ["USDC", 2.5, null, "medium"], ["0x1234567890123456789012345678901234567890", null, null, "high"]]);
  assert.ok(f.every((x) => x.category === "bridge_stuck" && x.chain === "ethereum" && x.how_to_claim === "https://portal.scroll.io/bridge"));
  assert.match(f[1].action, /waiting for its batch/);
  assert.match(f[2].detail, /500000000000000000 raw units/);
});

test("perps holdings: GMX positions, Lighter collateral, and Kwenta accounts are verified holdings", () => {
  const data = {
    items: [
      { protocol: "GMX", chain: "arbitrum", asset: "BTC/USD", amount: 500, usd: 500, kind: "position", detail: "Long BTC/USD" },
      { protocol: "Lighter", chain: "zklighter", asset: "USDC", amount: 250, usd: 250, kind: "deposit", detail: "subaccount 1" },
      { protocol: "Kwenta", chain: "optimism", asset: "sUSD", amount: 100, usd: 100, kind: "deposit", detail: "account 0x123" },
      { protocol: "Dust", chain: "arbitrum", asset: "DUST", amount: 0.001, usd: 0.001, kind: "position" },
    ],
  };
  const h = F.perpsHoldings(data, { minUsd: 1 });
  assert.equal(h.length, 3);
  assert.equal(h[0].protocol, "GMX");
  assert.equal(h[0].chain, "arbitrum");
  assert.equal(h[1].protocol, "Lighter");
  assert.equal(h[1].chain, "zklighter");
  assert.equal(h[2].protocol, "Kwenta");
  assert.equal(h[2].chain, "optimism");
  assert.ok(h.every((x) => x.verified && x.source === "holdings.perps"));
});

test("perps: GMX USD fields are 1e30-scaled; the row is the net value, named from the market list", async () => {
  const { COMPOSE } = await import("../compose.mjs");
  const pos = { marketAddress: "0xC25cEf6061Cf5dE5eb761b50E4743c1F5D7E5407", isLong: true, sizeInUsd: "7391386821450893275500000000000000",
    collateralUsd: "295743279060184500999179700000000", netValue: "285925730292476739872143625400000" }; // live answer 2026-10-20
  const ctx = { call: async (id, p) => ({ ok: true, data:
    id === "holdings.gmx_positions" ? (p.chain === "arbitrum" ? [pos] : [])
    : id === "holdings.gmx_markets" ? [{ marketTokenAddress: pos.marketAddress, symbol: "ARB/USD [ARB-USDC]" }]
    : id === "holdings.kwenta" ? { accounts: [] } : { sub_accounts: [] } }) };
  const { items } = await COMPOSE.perpsPositions({ address: V }, ctx);
  assert.equal(items.length, 1);
  assert.equal(items[0].asset, "ARB/USD [ARB-USDC]");
  assert.equal(Math.round(items[0].usd * 100) / 100, 285.93);
  assert.match(items[0].detail, /size \$7391/);
});
