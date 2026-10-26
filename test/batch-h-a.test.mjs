// batch-h-a.test.mjs - hiddenfunds gaps, group A: Nucleus vault shares (forgotten/nucleus.mjs) and Mooniswap LPs
// (forgotten/mooniswap.mjs + data/mooniswap.json), replayed on real answers captured 2026-10-21
// (test/fixtures/batch-h-a-*.json). The example wallets were proven with eth_call simulations from the holder:
// bulkWithdraw on the unifiETH teller pays 109.705 pufETH, withdraw on the ETH-WBTC pool 114.444 ETH + 3.40289 WBTC
import { test, beforeEach } from "node:test";
beforeEach((t) => t.mock.timers.enable({ apis: ["Date"], now: new Date("2026-10-22T00:00:00Z") }));
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as F from "../findings.mjs";
import { FORGOTTEN } from "../forgotten/index.mjs";
import { NUCLEUS_VAULTS, coverage } from "../forgotten/nucleus.mjs";
import { MOONISWAP } from "../forgotten/mooniswap.mjs";
import { COMPOSE } from "../compose.mjs";
import { REGISTRY } from "../registry.mjs";
import { HF_SOURCES } from "../forgotten/hf-findings.mjs";

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

// ---- rewards.nucleus_vaults ----
test("nucleus: unifiETH shares the vault's pufETH pays in full are a high token_migration row at the accountant rate", async () => {
  const d = await FORGOTTEN.nucleusVaults({ address: "0x8769d82dd0d2eb1ee3d8e617378eca39fdd87b31" }, replay("batch-h-a-nucleus"));
  assert.deepEqual(d.errors, []);
  const [f, ...rest] = F.hfClaims(d, { source: "rewards.nucleus_vaults" });
  assert.equal(rest.length, 0);
  assert.equal(f.category, "token_migration");
  assert.equal(f.chain, "ethereum");
  assert.equal(f.protocol, "Nucleus");
  assert.equal(f.asset, "unifiETH");
  assert.equal(f.token, "0x196ead472583bc1e9af7a05f860d9857e1bd3dcc");
  assert.equal(f.amount, 112.87237615);
  assert.ok(f.usd > 150000 && f.usd < 600000, `usd ${f.usd}`); // about 119.1 WETH
  assert.equal(f.confidence, "high");
  assert.match(f.action, /bulkWithdraw\(0xD9A442856C234a39a81a089C06451EBAa4306a72, 112872376148858733439, 0, your address\)/);
  assert.match(f.action, /pays about 109\.705\d* pufETH/);
  assert.equal(f.how_to_claim, "https://etherscan.io/address/0x08eb2eccdf6ebd7aba601791f23ec5b5f68a1d53#writeContract");
  assert.match(f.detail, /119\.10\d* WETH at the accountant rate/);
});

test("nucleus: earnETH, whose teller lost the vault's exit role, is a low hint with no usd; unifiUSD next to it is high", async () => {
  const d = await FORGOTTEN.nucleusVaults({ address: "0xd9d3dd56936f90ea4c7677f554dfefd45ef6df0f" }, replay("batch-h-a-nucleus-mixed"));
  const by = Object.fromEntries(F.hfClaims(d, { source: "rewards.nucleus_vaults" }).map((f) => [f.asset, f]));
  assert.deepEqual(Object.keys(by).sort(), ["earnETH", "unifiUSD"]);
  assert.equal(by.earnETH.confidence, "low");
  assert.equal(by.earnETH.usd, null);
  assert.equal(by.earnETH.amount, 8.14177717);
  assert.match(by.earnETH.action, /redemptions are shut on this vault/);
  assert.equal(by.unifiUSD.confidence, "high");
  assert.ok(by.unifiUSD.usd > 1500 && by.unifiUSD.usd < 1800, `usd ${by.unifiUSD.usd}`);
  assert.match(by.unifiUSD.action, /pays about 1641\.3\d* USDC/);
});

test("nucleus: unifiBTC owed more than the vault still holds = partial, medium, usd only for the covered part", async () => {
  const d = await FORGOTTEN.nucleusVaults({ address: "0x2e15d7aa0650de1009710fdd45c3468d75ae1392" }, replay("batch-h-a-nucleus-partial"));
  const [f] = F.hfClaims(d, { source: "rewards.nucleus_vaults" });
  assert.equal(f.asset, "unifiBTC");
  assert.equal(f.confidence, "medium");
  assert.equal(d.items[0].status, "partial");
  assert.match(f.detail, /cover only 9\d\.\d% of it/);
  assert.match(f.action, /split over the assets the vault still holds \(WBTC, LBTC\)/);
  assert.ok(f.usd > 20000 && f.usd < 80000, `usd ${f.usd}`);
});

test("nucleus: an empty wallet has no row and reads only the balances; a non-EVM address is a 400", async () => {
  const d = await FORGOTTEN.nucleusVaults({ address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }, replay("batch-h-a-nucleus-empty"));
  assert.deepEqual(d, { items: [], errors: [] });
  assert.equal(fx("batch-h-a-nucleus-empty").length, 1); // one Multicall3, no price call
  await assert.rejects(FORGOTTEN.nucleusVaults({ address: "nope" }, replay("batch-h-a-nucleus")), (e) => e.status === 400);
});

test("nucleus: coverage splits shares over the held payout assets and names the first that pays all of them alone", () => {
  const one = 10n ** 18n, e = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
  const a = (symbol, held, rate) => ({ symbol, token: symbol, dec: 18, held: e(held), rate: e(rate) });
  // 10 shares at 1.05: X pays 5 (4.76 shares), Y pays plenty
  let c = coverage(e(10), one, [a("X", 5, 1.05), a("Y", 100, 1.05)]);
  assert.equal(c.covered, e(10));
  assert.equal(c.whole.symbol, "Y");
  c = coverage(e(10), one, [a("X", 5, 1), a("Y", 2, 1)]);
  assert.equal(c.covered, e(7));
  assert.equal(c.whole, null);
  c = coverage(e(10), one, [{ symbol: "Z", held: e(50), rate: null }, a("W", 0, 1)]); // unreadable rate (paused accountant), empty asset
  assert.equal(c.covered, 0n);
});

test("nucleus: the vault list is the deprecated Ethereum vaults only, no Nest vault, every teller and accountant distinct", () => {
  assert.equal(NUCLEUS_VAULTS.length, 11);
  const addrs = NUCLEUS_VAULTS.map((v) => v.vault.toLowerCase());
  assert.equal(new Set(addrs).size, 11);
  for (const nest of ["0x593ccca4c4bf58b7526a4c164ceef4003c6388db", "0xe72fe64840f4ef80e3ec73a1c749491b5c938cb9", "0x119dd7daff816f29d7ee47596ae5e4bdc4299165"]) assert.ok(!addrs.includes(nest)); // nALPHA, nTBILL, nOPAL
  assert.equal(new Set(NUCLEUS_VAULTS.map((v) => v.teller.toLowerCase())).size, 11);
  assert.equal(new Set(NUCLEUS_VAULTS.map((v) => v.accountant.toLowerCase())).size, 11);
  assert.ok(NUCLEUS_VAULTS.every((v) => v.pays.length && v.pays.every(([, t]) => /^0x[0-9a-fA-F]{40}$/.test(t))));
});

// ---- rewards.mooniswap ----
test("mooniswap: a 1inch Liquidity Protocol ETH-WBTC LP is a high row; the ETH leg is the pool's own ETH balance", async () => {
  const d = await FORGOTTEN.mooniswapLps({ address: "0x152cc9606f4dc55f632f04a0c71e846bc190abaf" }, replay("batch-h-a-moon-v2"));
  assert.deepEqual(d.errors, []);
  assert.equal(d.pools_checked, MOONISWAP.pools.length);
  const [f] = F.hfClaims(d, { source: "rewards.mooniswap" });
  assert.equal(f.protocol, "1inch Liquidity Protocol (Mooniswap v2)");
  assert.equal(f.asset, "ETH-WBTC LP");
  assert.equal(f.token, "0x6a11f3e5a01d129e566d783a7b6e8862bfd66cca");
  assert.equal(f.confidence, "high");
  assert.deepEqual(f.legs.map((l) => [l.asset, l.amount]), [["ETH", 114.444007], ["WBTC", 3.40289]]);
  assert.equal(f.legs[0].token, "0x0000000000000000000000000000000000000000");
  assert.ok(f.usd > 300000 && f.usd < 1200000, `usd ${f.usd}`);
  assert.match(f.action, /withdraw\(104341887205779859918, \[\]\) on the pool contract 0x6a11f3e5a01d129e566d783a7b6e8862bfd66cca \(pays both tokens, ETH as ETH\)/i);
  assert.match(f.how_to_claim, /etherscan\.io\/address\/0x6a11f3e5a01d129e566d783a7b6e8862bfd66cca#writeContract/i);
});

test("mooniswap: a first-factory (v1) ETH-DAI LP reads the same way", async () => {
  const d = await FORGOTTEN.mooniswapLps({ address: "0x7a22edbebf63ba0954ace8342620a4953c40caf8" }, replay("batch-h-a-moon-v1"));
  const [f] = F.hfClaims(d, { source: "rewards.mooniswap" });
  assert.equal(f.protocol, "Mooniswap");
  assert.equal(f.asset, "ETH-DAI LP");
  assert.deepEqual(f.legs.map((l) => [l.asset, l.amount]), [["ETH", 10.903285], ["DAI", 27289.523713]]);
  assert.equal(f.confidence, "high");
});

test("mooniswap: a pool with a dead, unpriced token counts the priced leg only, medium", async () => {
  const d = await FORGOTTEN.mooniswapLps({ address: "0x139624aaeee52242bf033d622c30ae03f4e0e056" }, replay("batch-h-a-moon-oneleg"));
  const [f] = F.hfClaims(d, { source: "rewards.mooniswap" });
  assert.equal(f.asset, "ETH-xINCHa LP");
  assert.equal(f.confidence, "medium");
  assert.equal(f.legs.find((l) => l.asset === "xINCHa").usd, null);
  assert.equal(f.usd, f.legs.find((l) => l.asset === "ETH").usd);
  assert.match(f.detail, /1 leg without a trusted price/);
});

test("mooniswap: an empty wallet has no row; the data file lists only pools of the two factories, the bad Dollars quote left out", async () => {
  const d = await FORGOTTEN.mooniswapLps({ address: "0x7e57A1B2c3D4e5F60718293a4B5c6D7e8F90c0Fe" }, replay("batch-h-a-moon-empty")); // a bad mixed-case checksum still reads
  assert.deepEqual(d.items, []);
  assert.deepEqual(MOONISWAP.dexes.map((x) => x.factory), ["0x71CD6666064C3A1354a3B4dca5fA1E2D3ee7D303", "0xbAF9A5d4b0052359326A6CDAb54BABAa3a3A9643"]);
  assert.ok(MOONISWAP.pools.every((x) => MOONISWAP.dexes.some((dx) => dx.id === x.dex) && x.balance_usd >= 1000));
  assert.ok(MOONISWAP.bad_prices["0xd233d1f6fd11640081abb8db125f722b5dc729dc"]);
  assert.ok(!MOONISWAP.pools.some((x) => x.pool.toLowerCase() === "0xa54f47c67305069138c59b8f4e24d06cdf147175")); // Dollars-yCRV: only priced by the bad quote
});

test("mooniswap: Zerion's 1inch row of the same LP goes once rewards.mooniswap answered", () => {
  const ours = { source: "rewards.mooniswap", category: "token_migration", chain: "ethereum", protocol: "1inch Liquidity Protocol (Mooniswap v2)", asset: "ETH-WBTC LP", token: "0xpool", amount: 104.3, usd: 575000, legs: [{ asset: "ETH", amount: 114.444 }, { asset: "WBTC", amount: 3.40289 }] };
  const out = F.dropHfTwins({ findings: [ours], holdings: [{ kind: "deposit", chain: "ethereum", protocol: "1inch Network", asset: "ETH", amount: 114.4, usd: 287000 }, { kind: "deposit", chain: "ethereum", protocol: "Aave", asset: "ETH", amount: 114.4, usd: 287000 }] });
  assert.deepEqual(out.holdings.map((h) => h.protocol), ["Aave"]);
});

// ---- wiring ----
test("group A routes are registered, composed and in the EVM scan", () => {
  const scan = readFileSync(new URL("../compose.mjs", import.meta.url), "utf8");
  for (const [id, fn] of [["rewards.nucleus_vaults", "nucleusVaults"], ["rewards.mooniswap", "mooniswapLps"]]) {
    const e = REGISTRY.find((x) => x.id === id);
    assert.ok(e, id);
    assert.equal(e.compose, fn);
    assert.equal(typeof COMPOSE[fn], "function");
    assert.ok(scan.includes(`{ id: "${id}", run:`), `${id} in scan.evm`);
    assert.ok(HF_SOURCES.has(id), `${id} in the Zerion twin filter`);
  }
});
