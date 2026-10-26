// batch-b.test.mjs - money left in old Ethereum contracts (oldeth/): the four checks replayed on real answers
// captured 2026-10-20 (test/fixtures/batch-b-rpc.json: index entries, eth_call / log / receipt / beacon answers),
// edge cases by changing one answer, and the normalizers on the real route answers (batch-b-routes.json)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as O from "../oldeth/index.mjs";
import * as F from "../findings.mjs";

const REC = JSON.parse(readFileSync(new URL("./fixtures/batch-b-rpc.json", import.meta.url), "utf8"));
const ROUTES = JSON.parse(readFileSync(new URL("./fixtures/batch-b-routes.json", import.meta.url), "utf8"));
const W = {
  games: "0x0c4e8517a5bb5cddce27ffb2f370dac893caef3c", // PoWH3D, LYNIA, Zethr, Fomo3D Quick + one contract with no reader
  mixed: "0xd83a1f53e43a45c32cc4209dc67910f2e081d2aa", // ENS deed, IDEX dust, PoWH3D, Mesa (no reader)
  ens: "0x9a02ed4ca9ad55b75ff9a05debb36d5eb382e184", // 4 ENS deeds (1700.26 + 555 + 0.01 + 0.01 ETH)
  vitalik: "0xd8da6bf26964af9d7eed9e03e53415d37aa96045", // BitConnect v3 + an ENS deed
  idex: "0xabfb31d72ce786d6498e70bcc5bbfb8e91d75612", // 22.04 ETH on IDEX v1
  scd: "0xffd855f70c3d012e24d482f2810496398278cc4a", // SAI vault #12844 owned by its DSProxy
  argent: "0x13d7997bd15ea4c6be7453c43adb58063789add0", // owner of Argent wallet 0x15855bb8...
  val: "0xac29ef7a7f4325ffa564de9abf67e5ace46c88f8", // depositor of 10 exited validators still on 0x00
};

// the captured index entries as a local mirror (no download: the manifest says it was checked just now)
const dir = mkdtempSync(join(tmpdir(), "ws-oldeth-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const shards = {};
for (const [a, e] of Object.entries(REC.shard)) (shards[a.slice(2, 4)] ??= {})[a] = e;
for (const [s, body] of Object.entries(shards)) writeFileSync(join(dir, `${s}.json`), JSON.stringify(body));
writeFileSync(join(dir, "protocols.json"), JSON.stringify(REC.protocols));
writeFileSync(join(dir, "manifest.json"), JSON.stringify({ shas: {}, checked: Date.now() }));

// replays the captured answers; `over` swaps single answers (key -> hex) for the edge cases
const word = (v) => "0x" + BigInt(v).toString(16).padStart(64, "0");
function io(over = {}) {
  const miss = (what) => { throw new Error(`no captured answer for ${what}`); };
  return {
    call: async (to, data, from) => {
      const k = `${to.toLowerCase()}|${data}|${from || ""}`, r = k in over ? over[k] : REC.call[k];
      if (r == null) miss(k);
      if (r.error) throw { error: r.error };
      return r;
    },
    balance: async (a) => BigInt(over[`balance|${a.toLowerCase()}`] ?? REC.balance[a.toLowerCase()] ?? miss(`balance ${a}`)),
    alchemy: async (m, p) => { const k = `${m}|${JSON.stringify(p)}`; return over[k] ?? REC.alchemy[k] ?? miss(k); },
    beacon: async (ids) => over[`beacon|${ids.join(",")}`] ?? REC.beacon[ids.join(",")] ?? miss(`beacon ${ids}`),
    zerion: async (a) => REC.zerion[a.toLowerCase()] ?? [],
    ethUsd: async () => 2450,
  };
}
// the captured eth_call key for (contract, selector, first argument)
const callKey = (to, sel, arg = "") => { const p = `${to}|${sel}${arg ? arg.slice(2).padStart(64, "0") : ""}`; return Object.keys(REC.call).find((c) => c.startsWith(p)) || `${p}|`; };
const POWH3D = "0xb3775fb83f7d12a36e0475abdd1fca35c091efbe", SAI_TUB = "0x448a5065aebb8e423f0896e6c5d525c040f59af3";
const byProto = (out, name) => out.items.filter((i) => i.protocol === name);
const sum = (rows) => rows.reduce((t, r) => t + r.amount, 0);

test("old contracts: index hits are read back onchain, wei scaled to ETH, no reader = low hint", async () => {
  const out = await O.oldContracts(W.games, io(), { dir });
  assert.deepEqual(out.errors, []);
  const powh = byProto(out, "PoWH3D")[0];
  // PoWH clones: dividends + what selling the tokens pays, read now (the index said 0.00727)
  assert.equal(powh.confidence, "high");
  assert.ok(Math.abs(powh.amount - 0.007265114353083383) < 1e-12);
  assert.equal(powh.how_to_claim, "https://etherscan.io/address/0xB3775fB83F7D12A36E0475aBdD1FCA35c091efBe#writeContract");
  assert.equal(byProto(out, "Fomo3D Quick")[0].amount.toFixed(9), "0.003953631");
  const hint = byProto(out, "ArbitrageETHStaking")[0];
  assert.equal(hint.confidence, "low");
  assert.equal(hint.amount, 0.6226724022525726); // the index amount, not read onchain
  assert.match(hint.detail, /not read back onchain/);
});

test("old contracts: a hit read back as 0 was taken out since the index was built and is dropped", async () => {
  const k = callKey(POWH3D, "0x0065318b", W.games); // dividendsOf(wallet)
  const kb = callKey(POWH3D, "0x70a08231", W.games); // balanceOf(wallet): its tokens
  const out = await O.oldContracts(W.games, io({ [k]: word(0), [kb]: word(0) }), { dir });
  assert.equal(byProto(out, "PoWH3D").length, 0);
  assert.equal(byProto(out, "LYNIA").length, 1);
});

test("old contracts: a failed read falls back to the low hint, never to high", async () => {
  const k = callKey(POWH3D, "0x0065318b", W.games);
  const out = await O.oldContracts(W.games, io({ [k]: { error: "execution reverted" } }), { dir });
  const powh = byProto(out, "PoWH3D");
  assert.equal(powh.length, 1);
  assert.equal(powh[0].confidence, "low");
  assert.equal(out.errors.length, 1);
});

test("old contracts: EtherDelta/IDEX ETH read directly; index keys read elsewhere are not counted twice", async () => {
  const out = await O.oldContracts(W.idex, io(), { dir });
  assert.deepEqual(out.items.map((i) => [i.protocol, i.amount]), [["IDEX v1", 22.044141782009998]]);
  assert.match(out.items[0].action, /withdraw\(0x0{40}, amount\)/);
  // this wallet's index entry has idex, ens_old, powh3d, mesa: one row each, IDEX and the deed from the direct reads
  const mixed = await O.oldContracts(W.mixed, io(), { dir });
  assert.deepEqual(mixed.items.map((i) => i.protocol).sort(), ["ENS (2017 registrar)", "IDEX v1", "Mesa / Gnosis Protocol v1", "PoWH3D"]);
  assert.equal(byProto(mixed, "IDEX v1")[0].amount, 0.00351004218527273);
});

test("ENS deeds: deposits owned by the wallet, from the index and its own HashRegistered logs", async () => {
  const out = await O.oldContracts(W.ens, io(), { dir });
  const deeds = byProto(out, "ENS (2017 registrar)");
  assert.equal(deeds.length, 4);
  assert.equal(sum(deeds).toFixed(6), "2255.276252");
  assert.ok(deeds.every((d) => d.confidence === "high" && d.how_to_claim === "https://etherscan.io/address/0x6090A6e47849629b7245Dfa1Ca21D94cd15878Ef#writeContract"));
  assert.match(deeds.find((d) => d.amount > 1000).action, /releaseDeed\(0x[0-9a-f]{64}\)/);
  const v = await O.oldContracts(W.vitalik, io(), { dir });
  assert.match(byProto(v, "ENS (2017 registrar)")[0].action, /vitalik-buterin\.eth/);
});

test("ENS deeds: a deed sold to someone else or already emptied is dropped", async () => {
  const deed = "0xd5b4298248466c889f2ec643892ee9fa9c70027d";
  const ownerKey = callKey(deed, "0x8da5cb5b");
  const sold = await O.oldContracts(W.vitalik, io({ [ownerKey]: word("0x1111111111111111111111111111111111111111") }), { dir });
  assert.equal(byProto(sold, "ENS (2017 registrar)").length, 0);
  const empty = await O.oldContracts(W.vitalik, io({ [`balance|${deed}`]: "0x0" }), { dir });
  assert.equal(byProto(empty, "ENS (2017 registrar)").length, 0);
});

test("Maker SCD: PETH x per() in WETH, high with no debt; a debt is settled at the cage price first (medium)", async () => {
  const out = await O.makerScd(W.scd, io());
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].amount.toFixed(4), "473.6043"); // 450.4374 PETH x 1.05143
  assert.equal(out.items[0].confidence, "high");
  assert.match(out.items[0].detail, /#12844.*DSProxy 0x87B221b32bcAc8e3F12b8765a8e2de57e997dE2C/);
  // the same vault with 1,000 SAI of debt: tab x RAY / tag PETH go first
  const cupKey = callKey(SAI_TUB, "0xfdac0025");
  const [lad, ink] = [REC.call[cupKey].slice(2, 66), REC.call[cupKey].slice(66, 130)];
  const tabKey = `${SAI_TUB}|0xf7c8d634${cupKey.split("|")[1].slice(10)}|`;
  const tag = BigInt(REC.call[`${SAI_TUB}|0x51f91066|`]);
  const debt = await O.makerScd(W.scd, io({ [cupKey]: "0x" + lad + ink + word(1000n * 10n ** 18n).slice(2) + word(0).slice(2), [tabKey]: word(1000n * 10n ** 18n) }));
  const owe = Number(1000n * 10n ** 18n * 10n ** 27n / tag) / 1e18;
  assert.equal(debt.items[0].confidence, "medium");
  assert.ok(Math.abs(debt.items[0].amount - (450.4373940035946 - owe) * 1.0514320936020717) < 1e-6);
});

test("Argent: wallets the address still owns; ETH high, Zerion token reads medium; an owner change drops it", async () => {
  const out = await O.argentWallets(W.argent, io());
  assert.deepEqual(out.wallets, ["0x15855bb8e1ea1d8c143a8b2a26d6e85c7e449c12"]);
  const ethRow = out.items.find((i) => i.asset === "ETH");
  assert.equal(ethRow.amount.toFixed(2), "13342.08");
  assert.equal(ethRow.confidence, "high");
  assert.deepEqual(out.items.filter((i) => i.asset !== "ETH").map((i) => [i.asset, i.confidence]), [["UNI", "medium"], ["LINK", "medium"]]);
  const moved = await O.argentWallets(W.argent, io({ [callKey("0x15855bb8e1ea1d8c143a8b2a26d6e85c7e449c12", "0x8da5cb5b")]: word("0x2222222222222222222222222222222222222222") }));
  assert.equal(moved.items.length, 0);
});

test("validators: exited ones still on 0x00 are one finding (gwei scaled), credentials changed to 0x01 drop out", async () => {
  const out = await O.validators0x00(W.val, io());
  assert.equal(out.validators.length, 10);
  assert.equal(out.items.length, 1);
  assert.equal(out.items[0].amount.toFixed(6), "393.461546");
  assert.equal(out.items[0].confidence, "medium");
  assert.match(out.items[0].detail, /#25053/);
  const ids = Object.keys(REC.beacon)[0];
  const vals = REC.beacon[ids].map((v, i) => i === 0 ? { ...v, validator: { ...v.validator, withdrawal_credentials: "0x01" + v.validator.withdrawal_credentials.slice(4) } }
    : i === 1 ? { ...v, status: "active_ongoing", balance: "33500000000" } : v);
  const mixed = await O.validators0x00(W.val, io({ [`beacon|${ids}`]: vals }));
  assert.equal(mixed.validators.length, 9);
  const [exited, skim] = [mixed.items.find((i) => i.category === "unstake_ready"), mixed.items.find((i) => i.category === "reward")];
  assert.equal(skim.amount, 1.5); // above 32 ETH on the active one
  assert.deepEqual(mixed.holdings.map((h) => [h.kind, h.amount]), [["staked", 32]]);
  assert.ok(Math.abs(exited.amount - (393.461545565 - 39.453082695 - 39.069941771)) < 1e-9);
});

test("normalizers: real route answers -> findings, holdings and totals", async () => {
  const ens = F.oldEthereum(ROUTES["rewards.old_contracts"][W.ens], { source: "rewards.old_contracts" });
  assert.equal(ens.length, 4);
  assert.ok(ens.every((f) => f.chain === "ethereum" && f.category === "unstake_ready" && f.deadline === null && f.source === "rewards.old_contracts"));
  const val = F.validators0x00(ROUTES["rewards.validators_0x00"]);
  const argent = F.oldEthereum(ROUTES["rewards.argent_wallets"], { source: "rewards.argent_wallets" });
  const scd = F.oldEthereum(ROUTES["rewards.maker_scd"], { source: "rewards.maker_scd" });
  const t = F.summarize([...ens, ...val.findings, ...argent, ...scd], val.holdings);
  const usd = (rows, c) => rows.filter((f) => f.confidence === c).reduce((s, f) => s + f.usd, 0);
  assert.equal(t.totals.claimable_usd.toFixed(0), (usd(ens, "high") + usd(argent, "high") + usd(scd, "high")).toFixed(0));
  assert.equal(t.totals.likely_usd.toFixed(0), (usd(val.findings, "medium") + usd(argent, "medium")).toFixed(0)); // validators: medium, out of claimable
  assert.equal(F.oldEthereum({ items: [{ amount: 1, confidence: "certain" }] }, { source: "x" })[0].confidence, "low");
});
