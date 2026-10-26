// batch-c.test.mjs - perp exchange balances (perps/): live venues become holdings, closed venues findings, account
// hints low findings; each venue reader replays the upstream answers captured on 2026-10-20 (test/fixtures/batch-c-*)
import { test } from "node:test";
import assert from "node:assert/strict";
import * as F from "../findings.mjs";
import { REGISTRY, buildRequest } from "../registry.mjs";
import { RPC_HOSTS } from "../perps/rpc.mjs";
import { replay, fixture } from "./batch-c-io.mjs";
import { SOL } from "../perps/solana.mjs";
import { EVM as VAULTS } from "../perps/evm-vaults.mjs";
import { EVM as ONCHAIN } from "../perps/evm-onchain.mjs";
import { EVM as REST } from "../perps/rest.mjs";
import { readVenues } from "../perps/index.mjs";

const item = (o) => ({ protocol: "X", chain: "arbitrum", asset: "USDC", amount: 10, usd: 10, kind: "deposit", ...o });

test("perps: live venues are holdings, closed venues are findings, hints are low findings without an amount", () => {
  const data = { items: [
    item({ status: "live", usd: 50, amount: 50 }),
    item({ protocol: "GMX", detail: "GMX v2 row without a status" }),
    item({ status: "live", usd: 0.4, amount: 0.4 }),
    item({ status: "closed", confidence: "high", usd: 7202.88, amount: 7202.882682, action: "withdraw", how_to_claim: "https://x", deadline: "2027-07-01" }),
    item({ status: "closed", amount: 0, usd: 0 }),
    item({ status: "hint", amount: null, usd: null, action: "open the app", detail: "account registered" }),
  ] };
  const h = F.perpsHoldings(data, { minUsd: 1 });
  assert.equal(h.length, 2); // dust under min_usd and every non-live row stay out
  assert.ok(h.every((x) => x.verified && x.source === "holdings.perps"));
  const f = F.perpsFindings(data);
  assert.equal(f.length, 2); // the emptied closed row is dropped
  const [closed, hint] = f;
  assert.deepEqual([closed.category, closed.confidence, closed.amount, closed.deadline], ["exchange_balance", "high", 7202.882682, "2027-07-01"]);
  assert.deepEqual([hint.confidence, hint.amount, hint.usd], ["low", null, null]);
  const s = F.summarize(f.map((x) => F.withNet(x, {})), h);
  assert.equal(s.totals.claimable_usd, 7202.88); // the hint never counts
  assert.equal(s.totals.holdings_usd, 60);
});

test("perps: a closed row without its own confidence is medium (our estimate), Solana rows keep their source", () => {
  const f = F.perpsFindings({ items: [item({ status: "closed", chain: "solana" })] }, { source: "holdings.perps_sol" });
  assert.deepEqual([f[0].confidence, f[0].source], ["medium", "holdings.perps_sol"]);
});

test("holdings.perps_rpc only reaches the fixed RPC hosts", () => {
  const e = REGISTRY.find((r) => r.id === "holdings.perps_rpc");
  for (const host of RPC_HOSTS) assert.match(buildRequest(e, { host, method: "eth_chainId" }).url, new RegExp(`^https://${host.replace(/\./g, "\\.")}/`));
  for (const host of ["evil.example", "rpc.orderly.network.evil.example", "169.254.169.254", "rpc.orderly.network/../x"]) {
    assert.throws(() => buildRequest(e, { host, method: "eth_chainId" }), (x) => x.status === 400);
  }
  assert.throws(() => buildRequest(e, { host: "mainnet.megaeth.com", path: "admin", method: "eth_chainId" }), (x) => x.status === 400);
});

// ---- Solana venues (perps/solana.mjs)
{
  const run = (name, edit) => {
    const fx = fixture(`batch-c-${name}.json`);
    if (edit) for (const c of fx.calls) edit(c);
    return SOL[fx.venue](fx.address, replay(fx));
  };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
  const outOf = (name, route) => fixture(`batch-c-${name}.json`).calls.find((c) => c.key.includes(`"${route}"`)).out;

  test("drift: only unclaimed rows, DFX at Jupiter price with $1 par in detail, clawback date per tree", async () => {
    // 8 eligibility rows, 7 already claimed (claimable 0): one DFX row left
    assert.equal(outOf("drift", "holdings.drift_eligibility").data.length, 8);
    const items = await run("drift");
    assert.equal(items.length, 1);
    const [dfx] = items;
    const price = outOf("drift", "token.jup_info")[0].usdPrice;
    assert.equal(dfx.asset, "DFX");
    assert.equal(dfx.amount, 1904.924899); // claimable_amount 1904924899, 6 decimals
    near(dfx.usd, 1904.924899 * price);
    assert.equal(dfx.status, "closed");
    assert.equal(dfx.confidence, "high");
    assert.equal(dfx.deadline, "2028-01-01");
    assert.equal(dfx.how_to_claim, "https://dfx.drift.trade/");
    assert.match(dfx.detail, /par \$1 each \(\$1904\.92 of verified loss\)/);
    assert.match(dfx.action, /DFX/);
  });

  test("drift: Insurance Fund SOL refund uses 9 decimals and the IF tree clawback", async () => {
    const items = await run("drift-if");
    const sol = items.find((i) => i.asset === "SOL");
    const price = outOf("drift-if", "token.jup_info").find((t) => t.symbol === "SOL").usdPrice;
    assert.equal(sol.amount, 2.336266882);
    near(sol.usd, 2.336266882 * price);
    assert.equal(sol.deadline, "2027-07-01");
    assert.match(sol.action, /Insurance Fund refund/);
    assert.equal(items.find((i) => i.asset === "DFX").amount, 2.276225);
  });

  test("flashtrade: staked FLP at pool equity / LP supply (medium) and unclaimed USDC (high)", async () => {
    const [flp, usdc] = await run("flashtrade");
    assert.equal(flp.asset, "FLP");
    assert.equal(flp.amount, 132.394873);
    near(flp.usd / flp.amount, 0.19091930316684827); // Community.3: 401.196425 equity / 2101.392674 LP
    assert.equal(flp.confidence, "medium");
    assert.match(flp.detail, /pool Community\.3/);
    assert.equal(usdc.asset, "USDC");
    assert.equal(usdc.amount, 27.56397);
    assert.equal(usdc.usd, 27.56397);
    assert.equal(usdc.confidence, "high");
    for (const i of [flp, usdc]) {
      assert.equal(i.status, "closed");
      assert.match(i.action, /burn FLP on flash\.trade\/earn/);
    }
  });

  test("flashtrade: a stake whose pool account is gone keeps its LP amount, unpriced and low", async () => {
    const items = await run("flashtrade", (c) => { if (c.key.includes('"sol.accounts"')) c.out.result.value[0] = null; });
    const flp = items.find((i) => i.asset === "FLP");
    assert.equal(flp.usd, null);
    assert.equal(flp.confidence, "low");
    assert.match(flp.detail, /not redeemable/);
  });

  test("adrena: open position collateral, closed venue, medium (no PnL)", async () => {
    const [p] = await run("adrena");
    assert.equal(p.asset, "SOL-PERP");
    assert.equal(p.usd, 2075.351488); // collateral_usd u64 2075351488
    assert.equal(p.kind, "position");
    assert.equal(p.status, "closed");
    assert.equal(p.confidence, "medium");
    assert.match(p.detail, /short SOL, size \$2573\.83, USDC collateral/);
    assert.match(p.how_to_claim, /^https:\/\/solscan\.io\/account\/HxDquJ5/);
  });

  test("jupiter: positions at valueUsd (collateral + PnL), live", async () => {
    const items = await run("jupiter");
    const raw = outOf("jupiter", "holdings.jupiter_perps_positions").dataList;
    assert.deepEqual(items.map((i) => i.asset), ["SOL-PERP", "BTC-PERP"]);
    items.forEach((i, k) => {
      assert.equal(i.usd, Number(raw[k].valueUsd) / 1e6);
      assert.equal(i.kind, "position");
      assert.equal(i.status, "live");
    });
    assert.equal(items[0].usd, 34473.404958);
  });

  test("jupiter: unfilled limit order collateral in token units; executed orders and non-positive values dropped", async () => {
    const [o] = await run("jupiter-orders");
    assert.equal(o.asset, "SOL");
    assert.equal(o.amount, 20); // collateralTokenAmount 20000000000, 9 decimals
    assert.equal(o.usd, 2126.69695);
    assert.equal(o.kind, "deposit");
    assert.equal(o.status, "live");
    const none = await run("jupiter-orders", (c) => {
      if (c.key.includes("orders")) c.out.dataList[0].executed = true;
      if (c.key.includes("positions")) c.out.dataList = [{ asset: "SOL", valueUsd: "-5000000", sizeUsd: "0", collateralUsd: "0", pnlAfterFeesUsd: "-5000000" }];
    });
    assert.deepEqual(none, []);
  });

  test("pacifica: account equity, withdrawable in detail, position kind when trades are open", async () => {
    const [a] = await run("pacifica");
    assert.equal(a.usd, 1060625.282129);
    assert.equal(a.amount, a.usd);
    assert.equal(a.kind, "position");
    assert.equal(a.status, "live");
    assert.match(a.detail, /875390\.472658 USDC withdrawable now, 2 open position/);
  });

  test("phoenix: effective collateral from the trader view (collateral + PnL)", async () => {
    const [p] = await run("phoenix");
    assert.equal(p.usd, 23254.250063);
    assert.equal(p.kind, "position");
    assert.equal(p.status, "live");
    assert.match(p.detail, /collateral 23175\.638656 USDC \+ unrealized PnL 78\.611407/);
  });

  test("phoenix: without the trader view, snapshot collateral / 1e6", async () => {
    const [p] = await run("phoenix", (c) => { if (c.key.includes("phoenix_trader\"")) c.out = { status: 404, ok: false, data: {} }; });
    assert.equal(p.usd, 23175.638656);
    assert.match(p.detail, /excludes PnL/);
  });

  test("empty wallet: every venue answers [] (404 = no account)", async () => {
    for (const v of ["drift", "flashtrade", "adrena", "jupiter", "pacifica", "phoenix"]) assert.deepEqual(await run(`${v}-empty`), [], v);
  });
}

// ---- EVM vault venues (perps/evm-vaults.mjs)
{
  const EVM = VAULTS;
  const run = (name) => {
    const fx = fixture(`batch-c-${name}.json`);
    return EVM[fx.venue](fx.address, replay(fx));
  };
  const cents = (x) => Math.round(x * 100) / 100;

  test("gmx-v1: Avalanche shorts = collateral + the vault's own getPositionDelta, closed medium, v1 portal", async () => {
    const items = await run("gmx-v1");
    assert.equal(items.length, 2);
    const avax = items.find((x) => x.asset === "WAVAX-PERP");
    assert.equal(avax.chain, "avalanche");
    assert.equal(cents(avax.usd), 111.09); // collateral $18.78 (1e30) + profit $92.31
    assert.equal(avax.amount, avax.usd);
    assert.match(avax.detail, /short WAVAX \(USDC collateral\), size \$188; collateral \$18\.78 \+ PnL \$92\.31/);
    assert.equal(avax.kind, "position");
    assert.equal(avax.status, "closed");
    assert.equal(avax.confidence, "medium");
    assert.equal(avax.how_to_claim, "https://v1.app.gmx.io/#/v1");
    assert.match(avax.action, /^close the GMX v1 position/);
    assert.equal(cents(items.find((x) => x.asset === "BTC.b-PERP").usd), 268.58); // a USD figure: labelled as the market, never "268.58 BTC.b"
  });

  test("gmx-v1: a wallet with no v1 position gives nothing on either chain", async () => {
    assert.deepEqual(await run("gmx-v1-empty"), []);
  });

  test("fulcrom: live positions on Cronos and zkSync; PnL from vault prices since Fulcrom has no getPositionDelta", async () => {
    const items = await run("fulcrom");
    assert.equal(items.length, 12);
    assert.ok(items.every((x) => x.status === "live" && x.kind === "position" && !x.confidence));
    assert.deepEqual([...new Set(items.map((x) => x.chain))].sort(), ["cronos", "zksync"]);
    const eth = items.find((x) => x.chain === "zksync" && x.asset === "WETH-PERP");
    assert.match(eth.detail, /long WETH \(WETH collateral\), size \$2379; collateral \$426\.2\d [+-] PnL \$/);
    const btc = items.find((x) => x.chain === "cronos" && x.asset === "WBTC-PERP");
    assert.equal(cents(btc.usd), 267.68); // collateral $292.15 - loss $24.47
  });

  test("mummy: a loss is taken off the collateral (signed delta)", async () => {
    const [p] = await run("mummy");
    assert.equal(p.chain, "optimism");
    assert.equal(cents(p.usd), 32.47); // $48.80 - $16.33
    assert.match(p.detail, /collateral \$48\.8 - PnL \$16\.33/);
    assert.equal(p.status, "closed");
    assert.equal(p.how_to_claim, "https://mummy.finance");
  });

  test("morphex: dead Fantom oracle -> collateral only, PnL unknown", async () => {
    const [p] = await run("morphex");
    assert.equal(p.chain, "fantom");
    assert.equal(cents(p.usd), 11.92);
    assert.match(p.detail, /collateral \$11\.92, PnL unknown/);
    assert.equal(p.confidence, "medium");
  });

  test("perpetual-protocol: free collateral (6 decimals) is withdrawable now -> closed, high", async () => {
    const [p] = await run("perpetual-protocol");
    assert.equal(p.amount, 7199.432);
    assert.equal(p.usd, 7199.432);
    assert.equal(p.asset, "USDC");
    assert.equal(p.kind, "deposit");
    assert.equal(p.status, "closed");
    assert.equal(p.confidence, "high");
    assert.match(p.detail, /free collateral \$7199\.43 \(withdrawable now\); account value \$7199\.43/);
    assert.match(p.how_to_claim, /optimistic\.etherscan\.io\/address\/0xAD7b4C162707E0B2b5f6fdDbD3f8538A5fbA0d60#writeProxyContract/);
    assert.deepEqual(await run("perpetual-protocol-empty"), []);
  });

  test("vela: VUSD has 30 decimals; zero Base balance is dropped", async () => {
    const items = await run("vela");
    assert.equal(items.length, 1);
    assert.equal(items[0].chain, "arbitrum");
    assert.equal(cents(items[0].usd), 973.41); // 973408114700718030119722791993082 / 1e30
    assert.equal(items[0].status, "closed");
    assert.equal(items[0].confidence, "medium");
    assert.match(items[0].how_to_claim, /arbiscan\.io\/address\/0xC4ABADE3a15064F9E3596943c699032748b13352#writeContract/);
  });

  test("kiloex: margin 1e8 + price PnL, live positions on BSC and opBNB, nothing on Manta", async () => {
    const items = await run("kiloex");
    assert.equal(items.length, 6);
    assert.ok(items.every((x) => x.status === "live" && x.kind === "position"));
    assert.ok(!items.some((x) => x.chain === "manta"));
    const p13 = items.find((x) => x.chain === "bsc" && x.asset === "product 13");
    assert.equal(p13.usd, 3.79); // margin 333333333 / 1e8 at 18x, oracle 1.33486530 vs entry 1.32476153
    assert.match(p13.detail, /long product 13, 18x, margin \$3\.33 \+ PnL \$0\.46/);
  });

  test("jojo: net value (6 decimals) of the main account, stuck -> closed, low, contact support", async () => {
    const [p] = await run("jojo");
    assert.equal(p.usd, 1782.174355);
    assert.equal(p.kind, "position"); // exposure > 0
    assert.equal(p.status, "closed");
    assert.equal(p.confidence, "low");
    assert.equal(p.category, undefined); // exchange_balance by default, not bridge_blocked
    assert.match(p.action, /contact JOJO support/);
    assert.match(p.detail, /USDC credit \$1981\.98/);
  });

  test("jojo: subaccounts from the factory are read; an empty master is skipped", async () => {
    const items = await run("jojo-sub");
    assert.equal(items.length, 1);
    assert.equal(items[0].usd, 0.791655);
    assert.equal(items[0].kind, "deposit");
    assert.match(items[0].detail, /subaccount 0x17D5EB61aba749D453c8Ba73396877aBFb2062AF/);
  });
}

// ---- EVM onchain venues (perps/evm-onchain.mjs)
{
  const EVM = ONCHAIN;
  const run = (name, edit) => {
    const fx = fixture(`batch-c-${name}.json`);
    if (edit) edit(fx);
    return EVM[fx.venue](fx.address, replay(fx));
  };
  const cents = (x) => Math.round(x * 100) / 100;
  const VITALIK = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";

  test("synfutures: abandoned Arbitrum Gate deposits are closed findings, high, Gate write page", async () => {
    const items = await run("synfutures");
    assert.equal(items.length, 2);
    const usdc = items.find((x) => x.asset === "USDC.e");
    assert.equal(usdc.amount, 205.57129); // reserveOf 205571290, 6 decimals
    assert.equal(cents(usdc.usd), 205.54);
    const weth = items.find((x) => x.asset === "WETH");
    assert.equal(weth.amount, 0.4384973970633691); // 18 decimals
    assert.equal(cents(weth.usd), 1074.86);
    for (const x of items) {
      assert.equal(x.chain, "arbitrum");
      assert.equal(x.kind, "deposit");
      assert.equal(x.status, "closed");
      assert.equal(x.confidence, "high");
      assert.equal(x.deadline, null);
      assert.equal(x.how_to_claim, "https://arbiscan.io/address/0x6A372dBc1968f4a07cf2ce352f410962A972c257#writeContract");
      assert.match(x.action, /^call withdraw on the SynFutures Gate/);
      assert.match(x.detail, /abandoned/);
    }
  });

  test("synfutures: Base Gate deposit is a live holding", async () => {
    const [x, ...rest] = await run("synfutures-base");
    assert.equal(rest.length, 0);
    assert.equal(x.chain, "base");
    assert.equal(x.asset, "USDC");
    assert.equal(x.amount, 27835.78165);
    assert.equal(cents(x.usd), 27831.09);
    assert.equal(x.status, "live");
    assert.equal(x.kind, "deposit");
    assert.equal(x.confidence, undefined);
    assert.match(x.detail, /Gate on base: 27,835\.78 USDC idle deposit/);
  });

  test("synfutures: a priced reserve under a cent is dropped", async () => {
    const items = await run("synfutures", (fx) => { fx.calls[0].out[1] = { $n: "1000" }; }); // 1e-15 WETH
    assert.deepEqual(items.map((x) => x.asset), ["USDC.e"]);
  });

  test("mux: deterministic subaccounts on Arbitrum, collateral priced per asset, size > 0 = position", async () => {
    const items = await run("mux");
    assert.equal(items.length, 5);
    assert.ok(items.every((x) => x.chain === "arbitrum" && x.status === "live" && x.kind === "position" && !x.confidence));
    assert.equal(cents(items.reduce((s, x) => s + x.usd, 0)), 6315.36);
    const usdc = items.find((x) => x.asset === "USDC");
    assert.equal(usdc.amount, 502.04876423); // 1e18 units whatever the token's decimals
    assert.match(usdc.detail, /long ETH subaccount, 502\.05 USDC collateral, size 2\.82 ETH; PnL and funding not included/);
    assert.ok(items.some((x) => x.asset === "ETH" && /short BTC subaccount, 0\.8516 ETH collateral/.test(x.detail)));
  });

  // real wallets found from the pools' own position logs (Routescan / Fantom RPC, 2026-10-22): of 3,483 Avalanche
  // subaccounts 13 still hold collateral, this one the most; of 1,153 Fantom subaccounts only one does (0.02 FTM)
  test("mux: Avalanche still trades, so an open position there is a live holding", async () => {
    const items = await run("mux-avalanche");
    assert.equal(items.length, 1);
    const [x] = items;
    assert.deepEqual([x.chain, x.asset, x.amount, x.kind, x.status, x.confidence], ["avalanche", "USDT", 799.041231824, "position", "live", undefined]);
    assert.equal(cents(x.usd), 798.18);
    assert.match(x.detail, /^MUX v1 avalanche: long ETH subaccount, 799\.04 USDT collateral, size 0\.6324 ETH; PnL and funding not included$/);
  });

  test("mux: a Fantom subaccount is a closed finding, read through the FTM asset id; under a cent it is dropped", async () => {
    assert.deepEqual(await run("mux-fantom"), []); // 0.02 FTM at $0.05: dust
    const ftm = (fx) => { fx.calls.at(-1).out["coingecko:fantom"] = 100; };
    const items = await run("mux-fantom", ftm);
    assert.equal(items.length, 1);
    const [x] = items;
    assert.deepEqual([x.chain, x.asset, x.amount, x.status, x.confidence, x.deadline], ["fantom", "FTM", 0.019981121519299545, "closed", "medium", null]);
    assert.equal(cents(x.usd), 2);
    assert.match(x.action, /^close the position and withdraw the FTM collateral in the MUX app on fantom$/);
    assert.match(x.detail, /long ETH subaccount, 0\.01998 FTM collateral/);
  });

  test("gains: Base trades summed per collateral, live positions with pair names", async () => {
    const [x, ...rest] = await run("gains");
    assert.equal(rest.length, 0);
    assert.equal(x.chain, "base");
    assert.equal(x.asset, "USDC");
    assert.equal(x.amount, 94.02); // 41 trades, raw collateral in 6 decimals
    assert.equal(cents(x.usd), 94);
    assert.equal(x.kind, "position");
    assert.equal(x.status, "live");
    assert.match(x.detail, /^gTrade base: 41 open trades \(RAY\/USD long 100x, AERO\/USD long 100x, AI\/USD long 100x\), 94\.02 USDC collateral/);
  });

  test("gains: ApeChain WAPE collateral in 18 decimals, priced as apecoin", async () => {
    const [x] = await run("gains-apechain");
    assert.equal(x.asset, "WAPE");
    assert.equal(cents(x.amount), 6154.76);
    assert.equal(cents(x.usd), 902.04);
    assert.match(x.detail, /1 open trade \(APE\/USD long 1\.185x\)/);
  });

  test("aevo: every collateral with a balance, USDC and aeUSD priced as USDC", async () => {
    const items = await run("aevo");
    assert.deepEqual(items.map((x) => [x.asset, x.amount]), [["USDC", 90.779193], ["aeUSD", 15.21903]]);
    assert.ok(items.every((x) => x.chain === "aevo" && x.status === "live" && x.kind === "deposit"));
    assert.equal(cents(items[0].usd), 90.76);
    assert.match(items[0].detail, /settled collateral \(unrealized PnL not included\)/);
  });

  test("aevo: a negative balance stays signed and says it is borrowed", async () => {
    const items = await run("aevo", (fx) => { fx.calls[1].out[0] = { $n: "-25000000" }; });
    const usdc = items.find((x) => x.asset === "USDC");
    assert.equal(usdc.amount, -25);
    assert.ok(usdc.usd < -24.9);
    assert.match(usdc.detail, /-25 USDC balance, borrowed against other collateral/);
  });

  test("orderly: broker accounts from the API, USDC from the L2 ledger, detail names the broker", async () => {
    const [x, ...rest] = await run("orderly");
    assert.equal(rest.length, 0);
    assert.equal(x.amount, 1514.290081);
    assert.equal(cents(x.usd), 1514.03);
    assert.equal(x.chain, "orderly");
    assert.equal(x.status, "live");
    assert.equal(x.kind, "deposit");
    assert.match(x.detail, /broker raydium: 1,514\.29 USDC/);
  });

  test("variational: a confirmed settlement pool is a low hint with no amount, pool USDC as upper bound", async () => {
    const [x, ...rest] = await run("variational");
    assert.equal(rest.length, 0);
    assert.equal(x.status, "hint");
    assert.equal(x.confidence, "low");
    assert.equal(x.amount, null);
    assert.equal(x.usd, null);
    assert.match(x.detail, /^Variational Omni account registered \(settlement pool 0x33f720ef/);
    assert.match(x.detail, /holds 1,684\.47 USDC incl\. OLP margin, an upper bound/);
    assert.doesNotMatch(x.detail, /funds found/);
  });

  test("variational: a pool that does not list the wallet as its counterparty is ignored", async () => {
    assert.deepEqual(await run("variational", (fx) => { fx.calls[1].out[0] = false; }), []);
  });

  for (const v of ["synfutures", "gains", "aevo", "orderly", "variational"]) {
    test(`${v}: a wallet that never used it gives nothing`, async () => {
      const fx = fixture(`batch-c-${v}-empty.json`);
      assert.equal(fx.address, VITALIK);
      assert.deepEqual(await EVM[v](fx.address, replay(fx)), []);
    });
  }
}

// ---- REST venues (perps/rest.mjs)
{
  const EVM = REST;
  const run = (name, edit) => {
    const fx = fixture(`batch-c-${name}.json`);
    if (edit) for (const c of fx.calls) edit(c);
    return EVM[fx.venue](fx.address, replay(fx));
  };
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);
  const one = (items) => (assert.equal(items.length, 1), items[0]);

  test("empty wallets: every venue answers [] (Aster privacy 'enabled' and 'account does not exist' included)", async () => {
    for (const v of ["aster", "ostium", "veranta", "reya", "nado", "risex", "ethereal", "derive", "edgex", "apex-pro"]) assert.deepEqual(await run(`${v}-empty`), [], v);
    assert.deepEqual(await run("aster-noaccount"), []);
  });

  test("aster: one equity row sums the margin assets and adds unrealized PnL", async () => {
    const i = one(await run("aster"));
    close(i.usd, 20070.92670781 + 117.49669511 + 760.9282136501683); // walletBalance per asset + unrealizedProfit
    assert.equal(i.amount, i.usd);
    assert.deepEqual([i.status, i.kind, i.asset, i.chain], ["live", "position", "USD", "aster"]);
    assert.match(i.detail, /20,070\.93 USDC, 117\.5 USDT, 1 open position \(DOODUSDT\)/);
  });

  test("aster: a negative USDT balance (backed by USDC) nets against the USDC, it is not a separate debt", async () => {
    const neg = (c) => { for (const a of c.out?.data?.result?.perpAssets || []) if (a.asset === "USDT") a.walletBalance = "-4.49843386"; };
    const i = one(await run("aster", neg));
    close(i.usd, 20070.92670781 - 4.49843386 + 760.9282136501683);
    assert.match(i.detail, /-4\.5 USDT/);
  });

  test("aster: staking is its own ASTER row, priced from Aster's ASTERUSDT ticker", async () => {
    const items = await run("aster-staking");
    const stake = items.find((i) => /staking/.test(i.detail));
    assert.equal(stake.amount, 1);
    close(stake.usd, 0.7155);
    const spot = items.find((i) => /spot/.test(i.detail));
    assert.deepEqual([spot.asset, spot.amount], ["ASTER", 0.00838262]);
    close(items.find((i) => /equity/.test(i.detail)).usd, 0.00020155);
  });

  test("ostium: open trades at net value (collateral + PnL - fees), resting limit orders at collateral", async () => {
    const t = one(await run("ostium"));
    close(t.usd, 3249.653933);
    assert.deepEqual([t.kind, t.asset, t.chain, t.status], ["position", "USDC", "arbitrum", "live"]);
    assert.match(t.detail, /6 open trades.*2,963\.42 USDC collateral/);
    const l = one(await run("ostium-limits"));
    assert.deepEqual([l.kind, l.amount, l.usd], ["deposit", 66.40676, 66.40676]);
    // a trade past liquidation counts 0, never a debt
    const neg = await run("ostium", (c) => c.out?.trades?.forEach((x) => (x.netValue = -5)));
    assert.deepEqual(neg, []);
  });

  test("veranta: raw 6-decimal USDC collateral summed over open positions", async () => {
    const i = one(await run("veranta"));
    close(i.usd, 96.351019);
    assert.deepEqual([i.kind, i.chain], ["position", "base"]);
    assert.match(i.detail, /8 open positions, collateral only/);
  });

  test("reya: realBalance summed per asset across margin accounts, zero accounts left out", async () => {
    const i = one(await run("reya"));
    close(i.amount, 494.36783 + 94.549037);
    assert.equal(i.asset, "RUSD");
    assert.match(i.detail, /accounts 28639, 136544:/);
  });

  test("nado: healths[2] / 1e18 per subaccount; an underwater subaccount is left out", async () => {
    const i = one(await run("nado"));
    close(i.usd, 6286.113641331056);
    assert.deepEqual([i.kind, i.chain], ["position", "ink"]);
    assert.match(i.detail, /"default": net value incl\. 1 open perp position/);
    assert.deepEqual(await run("nado", (c) => { if (c.out?.data?.healths) c.out.data.healths[2].health = "-5000000000000000000"; }), []);
  });

  test("risex: total_account_value, open positions named", async () => {
    const i = one(await run("risex"));
    close(i.usd, 10553.552796290522);
    assert.deepEqual([i.kind, i.chain, i.asset], ["position", "rise", "USDC"]);
    assert.match(i.detail, /10,317\.38 USDC balance, 1 open position/);
  });

  test("ethereal: subaccount USDe balance; the 0.0000001 seed every subaccount gets is dropped", async () => {
    const i = one(await run("ethereal"));
    assert.deepEqual([i.amount, i.usd, i.asset], [10, 10, "USDe"]);
    assert.match(i.detail, /"primary"/);
    assert.deepEqual(await run("ethereal", (c) => c.out?.data?.forEach((b) => { if (b.amount) b.amount = "0.0000001"; })), []);
  });

  test("derive: margin_watch subaccount_value per subaccount, zero subaccounts skipped", async () => {
    const items = await run("derive");
    assert.deepEqual(items.map((i) => i.detail.match(/subaccount (\d+)/)[1]), ["72961", "74410", "75215", "107864", "107874"]);
    close(items.reduce((s, i) => s + i.usd, 0), 820.2999601668 + 0.058525544888 + 240.429144580273 + 388.90158283765 + 351.086212895052);
    assert.ok(items.every((i) => i.status === "live" && i.chain === "derive" && !/first 20/.test(i.detail)));
  });

  test("apex-pro and edgex: existence only, worded 'account registered', no amount", async () => {
    for (const v of ["apex-pro", "edgex"]) {
      const i = one(await run(v));
      assert.deepEqual([i.status, i.amount, i.usd, i.confidence], ["hint", null, null, "low"]);
      assert.match(i.detail, /account registered, open the app to check the balance/);
      assert.doesNotMatch(i.detail, /funds found/i);
    }
    const apex = one(await run("apex-pro"));
    assert.match(apex.action, /forced withdrawal/);
    assert.match(apex.how_to_claim, /apex\.exchange\/blog/);
  });
}

test("readVenues: a venue past its time limit is an error, the others still answer", async () => {
  const venues = { hung: () => new Promise(() => {}), quick: async () => [{ protocol: "Q", chain: "base", asset: "USDC", amount: 5, usd: 5, kind: "deposit", status: "live" }] };
  const out = await readVenues("0x0000000000000000000000000000000000000001", {}, venues, { ms: 50 });
  assert.deepEqual(out.items.map((i) => i.venue), ["quick"]);
  assert.deepEqual(out.errors, [{ venue: "hung", error: "hung took over 0.05s" }]);
  assert.equal(out.venues_checked, 2);
});
