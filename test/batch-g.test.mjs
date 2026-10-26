// batch-g.test.mjs - ERC-4337 smart accounts an EOA owns (forgotten/erc4337.mjs inside holdings.smart_wallets) and the
// more_wallets guide on every scan. Real accounts replayed from answers captured 2026-10-22
// (test/fixtures/batch-g-aa.json.gz, gzipped: 4.6 MB of mostly-zero Multicall3 answers); the branches no real wallet
// showed (owner moved, unclear owner) run on a fake chain that answers Multicall3 calls by function
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { decodeFunctionData, encodeFunctionResult, parseAbi, toFunctionSelector, pad, keccak256, toHex } from "viem";
import * as F from "../findings.mjs";
import { FORGOTTEN } from "../forgotten/index.mjs";
import { ownedAccounts, ACCOUNTS, BIG_TOKENS, LOG_CAP } from "../forgotten/erc4337.mjs";
import { COMPOSE, MORE_WALLETS } from "../compose.mjs";

const fx = (name) => {
  const gz = new URL(`./fixtures/${name}.json.gz`, import.meta.url);
  return JSON.parse(existsSync(gz) ? gunzipSync(readFileSync(gz)).toString("utf8") : readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
};
const fixtures = new Map();
const sha = (b) => createHash("sha1").update(JSON.stringify(b)).digest("hex");
const replay = (name) => {
  const k = (id, p, sh) => `${id}|${JSON.stringify(p || {})}|${sh || ""}`;
  if (!fixtures.has(name)) fixtures.set(name, new Map(fx(name).map((r) => [k(r.id, r.params, r.body_sha), r])));
  const m = fixtures.get(name);
  return {
    live: () => true, local: () => [],
    call: async (id, p, over = {}) => { const r = m.get(k(id, p, over.body == null ? "" : sha(over.body))); if (!r) throw { error: `no fixture for ${id}` }; return { status: r.status, ok: r.status >= 200 && r.status < 300 && !r.data?.error, data: r.data }; },
  };
};

// ---- real accounts: one per type, found from the owner EOA alone (re-captured 2026-10-22, with the owner logs) ----
// salt null = found through the owner's setup logs (a random salt no derivation can guess); deployed false = an
// undeployed account holding money, seen only through the factory's counterfactual address
const REAL = [
  ["base", "0x0862c44f1a1af0cec8bc68f394b9d59b627d211f", "0x96454e3dA45C1D5f8B28A83f0EDfc92da90a6177", "Coinbase Smart Wallet", "v1.1", 0, true],
  ["ethereum", "0x2e8fe4c24cdf81632e52a80dd9a746359f90a744", "0x64E689BaA6CB797f12832D15bC37306E2BC23083", "Coinbase Smart Wallet", "v1", 0, true],
  ["base", "0x854790885974ed0bd7570f77d1eba9adbc41767b", "0xe6e649b71e9af6e7f9e7027a53b455dcd82a1ed9", "Coinbase Smart Wallet", "v1.1", 0, false],
  ["polygon", "0xC5e452a52a04043A2093D4ae596F7285518cA002", "0x7dfb0cce95e2707db110408c462c1ba3ea2a7db9", "Alchemy LightAccount", "v1.0.1", 0, true],
  ["polygon", "0x0808C9814451a81B1Eb7967dE4c31091920480CC", "0x98ef39c9ee2691f1c548af654e72bcc79d823cdf", "Alchemy LightAccount", "v1.0.2", 0, true],
  ["base", "0xFd1134dBBCfB83386D0158Ce40D4a3CCFe4ABb5d", "0x50bE14411C9b10f8b32f84A7A5bFd0d358822F44", "Alchemy LightAccount", "v1.1.0", 0, true],
  ["base", "0x8268804aee0ED20a38B76599da458f82F95cF9EA", "0x1f1106c9476de99883410845b9fa0f3f8bd45a1b", "Alchemy LightAccount", "v2.0.0", 0, true],
  ["base", "0xF877518377b95308939738b6a6eD1Ae84Bda9EFA", "0xaa326647526d5189ec91b38ee0a02223dfd968ed", "Alchemy LightAccount", "v2.0.0", null, true],
  ["base", "0x729dE06aaCBd1958865686Eb1f5c92A6611B908d", "0x95a43b8dd678ba8b1afb47975b6771197621464d", "SimpleAccount", "v0.6", 0, true],
  ["base", "0xa6084be9fD003cb09E1a9A9a6F4108DE190DCfA1", "0xcABe28002ccdD918e72C5451ceF2b3445a951C3c", "SimpleAccount", "v0.7", 0, true],
  ["base", "0x21b6198E9B103B78cE4e455f3D076A3fb58ACcf7", "0xfeeecb2f6d265bf13abe2d33f92463c4301914fc", "SimpleAccount", "v0.8", 0, true],
  ["polygon", "0xd920C6C1516E317A8Db65F8fA786D7d1ac2C8af0", "0x463e3c5B9AF8A565bC3967D9b7c8279c326Cc884", "thirdweb", "v0.6", 0, true],
  ["base", "0xBF66a6eBe71d42445a5307BC7832A6DA5382513F", "0x9882e99071f5a5a868c4c7025f90d6c4f83233a9", "thirdweb", "v0.7", 0, true],
  ["polygon", "0x0e39c7a3ad7f9e39931c54f6a741cc4635b6fa30", "0x975cd0f46322d9342261409d7e6d9f3ccaad38fd", "ZeroDev Kernel", "v2.0-2.1", 0, true],
  ["polygon", "0x75eA34622f9C7F39461aC920c906B5022643B395", "0xe32Ee63554c7A684D8e6a3d26bD60B07C9EC4F72", "ZeroDev Kernel", "v2.2-2.4", 0, true],
  ["polygon", "0x21558f5a202902b8c5d0dad9e0cf8e5d8fded915", "0x14899b614327f0ac39c3be3ebce1d56e1d4e884e", "ZeroDev Kernel", "v3.0", 0, true],
  ["arbitrum", "0xe541fd360945084634f28a338757790224b40722", "0xa8328883ae1d3b75b9be42575aa270eb38a0cd11", "ZeroDev Kernel", "v3.1", 0, true],
  // its root moved to a permission whose ECDSA signer is the same owner, in the deploy transaction
  ["base", "0xecf41c734feed704343e2205895dd5bb28e7a4db", "0x033cb1ae47194e3c33fba3231de0db089f60000d", "ZeroDev Kernel", "v3.1", 0, true],
  ["base", "0x0cc7970b68b99fde251c0e7f70a58bb2fae11507", "0x8b4ac65ba92ca9bb28f162c5b4eaf5f746500e0e", "ZeroDev Kernel", "v3.2", 0, true],
  // a v3.3 account at a random salt, deployed through ZeroDev's FactoryStaker: the version is the validator's range
  ["base", "0x2316c3eef004cc8be23b5037d672c62ceb0c10a2", "0xfaa53eecc3a857ec851b31590d6b587079fac29d", "ZeroDev Kernel", "v3.1-3.3", null, true],
  ["base", "0xBcD8f0c6046F2eC46b42715C6B9De175E421bcF5", "0x5eCdf92c9f8aaCf73df7C8Ee0ad80c4FA325f37F", "Biconomy", "v2", 0, true],
  ["arbitrum", "0xF0327A202003BdE4b41f349F6694C70BCcAE16C4", "0x3849e1AAB654434B59e97dD8740D586719Cf0eCe", "Biconomy", "Nexus (attested)", 0, true],
  ["arbitrum", "0x940Df0c8316a2153978CC3306E6d9725cb55Dfa4", "0x05bd0e687c7bcfe06202accbca745289475d87c0", "Biconomy", "Nexus (attested)", 0, true],
  ["ethereum", "0x39D0289E2EDFd2De201D9395adEfE1115E459b5f", "0xc5478a1597597648a7e19a8f314c5c6314e3e126", "Biconomy", "Nexus (attested)", 0, true],
  ["base", "0x14b90625e590b7894ebf39d4c453056090db2776", "0x2998eea7e310c823cd1f5542ff7091d7d25115a6", "Biconomy", "Nexus (attested)", null, true],
  ["base", "0x15c181c15173ced4869f51b0cc2657785d6b7beb", "0x3e76bb790145e97b1b4d98950cba49d5d5038928", "Biconomy", "Nexus MEE v2.1.0", 0, true],
  ["base", "0x1e580430072Fe2451E2ed15650035d60C8546626", "0x453d018def234dbbd96a7211f4af11ee1ccb62cb", "Alchemy Modular Account", "v1", 0, true],
  ["base", "0xAEa97907502FA34FbeCa06CEceD723bC65eF0A43", "0x9346b57b0e01ff7a21790f811f221ac1ab99d78b", "Alchemy Modular Account", "v2", 0, true],
  ["base", "0x30ce48dab62770141501a824e4662f725ad4fa56", "0xd3ee754ba6669a80e78a031e6b80c7c028b770ed", "Alchemy Modular Account", "v2", null, true],
  ["polygon", "0x1cb7CD84081eB5f0304D99F2E4e7B88706234bA2", "0xe0992c45dc2fb876219d1bdab942183bdb5df4c0", "Alchemy Modular Account", "v2", 0, false],
  ["ethereum", "0x87B29cC13F930a2d058c79038FA0b6E1ea177f08", "0x4a0686ec784276da828a8f9a2e1c84209bc1dad5", "Safe", "4337 (Safe SDK)", "47809613043268281324563426428075425901584063434030871717623213294129061929462", true],
  ["ethereum", "0x55f32CCb12177A249563A9f4c3040138624f4Cfa", "0x21580e2f0affb26249f3a19a037fc0e87d89e3ec", "Safe", "4337 (permissionless)", 0, true],
  ["ethereum", "0x15Ff7613Cd094eeEa4a861D4b713678EB10c05e5", "0xe810be541ee9aa4d4898d41921c26928ad747b8d", "Safe", "4337 v0.2.0", 0, true],
];
for (const [chain, owner, wallet, kind, version, salt, deployed] of REAL) {
  test(`4337: the ${kind} ${version} account on ${chain} comes back from its owner${salt === null ? " through its setup log" : ""}${deployed ? ", ownership read onchain" : ", not deployed yet and holding money"}`, async () => {
    const d = await ownedAccounts(replay("batch-g-aa"), owner, { chains: [chain] });
    assert.deepEqual(d.hints, []);
    assert.ok(d.errors.every((e) => /not checked|not read/.test(e)), d.errors.join("; "));
    const a = d.accounts.find((x) => x.wallet.toLowerCase() === wallet.toLowerCase());
    assert.ok(a, `found ${JSON.stringify(d.accounts)}`);
    assert.deepEqual([a.kind, a.version, a.deployed, a.salt], [kind, version, deployed, salt]);
  });
}

test("smart wallets: a Coinbase Smart Wallet's USDC is a verified holding of its owner, named by kind and version", async () => {
  const d = await FORGOTTEN.smartWallets({ address: "0x0862c44f1a1af0cec8bc68f394b9d59b627d211f" }, replay("batch-g-aa"));
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.wallets.filter((w) => w.version), [{ chain: "base", wallet: "0x96454e3dA45C1D5f8B28A83f0EDfc92da90a6177", kind: "Coinbase Smart Wallet", version: "v1.1", deployed: true }]);
  const h = F.smartWallets(d);
  const usdc = h.find((x) => x.asset === "USDC");
  assert.equal(usdc.chain, "base");
  assert.equal(usdc.protocol, "Coinbase Smart Wallet");
  assert.ok(usdc.amount > 1 && usdc.usd > 1, `usdc ${usdc.amount} ${usdc.usd}`);
  assert.match(usdc.detail, /your Coinbase Smart Wallet v1\.1 smart account 0x96454e3dA45C1D5f8B28A83f0EDfc92da90a6177 on base$/);
  assert.deepEqual(F.smartWalletHints(d), []);
});

test("smart wallets: an undeployed Coinbase Smart Wallet's 796 USDC on Base is a holding of its owner that says it is not deployed", async () => {
  const d = await FORGOTTEN.smartWallets({ address: "0x854790885974ed0bd7570f77d1eba9adbc41767b" }, replay("batch-g-aa"));
  assert.deepEqual(d.errors, []);
  // the same address is deployed on Ethereum (where the owner used it) and still counterfactual on Base
  assert.deepEqual(d.wallets.filter((w) => w.version).map((w) => [w.chain, w.kind, w.version, w.deployed]), [["base", "Coinbase Smart Wallet", "v1.1", false], ["ethereum", "Coinbase Smart Wallet", "v1.1", true]]);
  const usdc = F.smartWallets(d).find((x) => x.chain === "base" && x.asset === "USDC");
  assert.ok(usdc.amount > 700 && usdc.usd > 700, `usdc ${usdc.amount} ${usdc.usd}`);
  assert.match(usdc.detail, /0xE6e649B71e9af6e7F9E7027a53b455dCD82a1ed9 on base \(not deployed there yet/);
});

// ---- a fake chain for the branches real wallets did not show ----
const OWNER = "0x1111111111111111111111111111111111111111", OTHER = "0x2222222222222222222222222222222222222222";
const W = { cb: "0xc0000000000000000000000000000000000000c1", light: "0xc0000000000000000000000000000000000000c2", kernel: "0xc0000000000000000000000000000000000000c3", simple: "0xc0000000000000000000000000000000000000c4", empty: "0xc0000000000000000000000000000000000000c5",
  lightlog: "0xc0000000000000000000000000000000000000c6", spam: "0xc0000000000000000000000000000000000000c7", badfac: "0xc0000000000000000000000000000000000000c8", fakekernel: "0xc0000000000000000000000000000000000000c9", sma: "0xc0000000000000000000000000000000000000ca" };
const mc = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }", "function aggregate3(Call3[] calls) payable returns (Result[] returnData)"]);
const fac = (kind, version) => ACCOUNTS.find((t) => t.kind === kind && t.version === version).factory.toLowerCase();
const SIG = (s) => toFunctionSelector(s);
const one = (sig, v) => encodeFunctionResult({ abi: parseAbi([`function f() view returns (${sig})`]), functionName: "f", result: v });
// Coinbase v1 salt 0: not deployed, 5 USDC on Base. LightAccount v2.0.0: deployed, owner moved to OTHER (dropped).
// Kernel v3.1: deployed, its ECDSA validator names OWNER but the root validator is another one (hint).
// SimpleAccount v0.7: has code that answers no owner(), holds ETH (hint). Kernel v2.2: an empty counterfactual (dropped)
function chainAnswer(to, data) {
  const sel = data.slice(0, 10), t = to.toLowerCase();
  const salt0 = (args) => args.at(-1) === 0n || args.at(-1) === pad("0x0");
  const addrOf = { [fac("Coinbase Smart Wallet", "v1")]: W.cb, [fac("Alchemy LightAccount", "v2.0.0")]: W.light, [fac("ZeroDev Kernel", "v3.1")]: W.kernel, [fac("SimpleAccount", "v0.7")]: W.simple, [fac("ZeroDev Kernel", "v2.2-2.4")]: W.empty }[t];
  if (addrOf) {
    const abi = parseAbi([ACCOUNTS.find((x) => x.factory.toLowerCase() === t).address(OWNER, 0n).abi[0]]);
    const { args } = decodeFunctionData({ abi, data });
    return salt0(args) ? one("address", addrOf) : "0x";
  }
  if (sel === SIG("getEthBalance(address)")) return one("uint256", data.toLowerCase().includes(W.simple.slice(2).toLowerCase()) ? 10n ** 17n : 0n);
  if (sel === SIG("balanceOf(address)")) return one("uint256", t === BIG_TOKENS.base[0].toLowerCase() && data.toLowerCase().includes(W.cb.slice(2).toLowerCase()) ? 5_000_000n : 0n);
  if (t === W.light.toLowerCase() && sel === SIG("owner()")) return one("address", OTHER);
  if (t === W.kernel.toLowerCase() && sel === SIG("rootValidator()")) return one("bytes21", "0x02000000000000000000000000000000000000aaaa");
  if (sel === SIG("ecdsaValidatorStorage(address)") && [W.kernel, W.fakekernel].some((w) => data.toLowerCase().includes(w.slice(2)))) return one("address", OWNER);
  // the accounts only the owner logs show: every one of them answers that OWNER controls it
  if (sel === SIG("owner()") && [W.lightlog, W.spam, W.badfac].includes(t)) return one("address", OWNER);
  if (sel === SIG("getFallbackSignerData()") && (t === W.sma || t.startsWith("0xd0"))) return encodeFunctionResult({ abi: parseAbi(["function f() view returns (address, bool)"]), functionName: "f", result: [OWNER, false] });
  return "0x"; // no code at this address, or a factory not on this chain
}
// the owner's setup logs: LightAccountInitialized from a real LightAccount v2 (its AccountDeployed names the factory),
// from a contract never deployed through an EntryPoint (spam) and from one another factory made; OwnerRegistered from
// a contract that is no Kernel validator; Modular Account v2's own SemiModularAccountDeployed (no AccountDeployed
// needed). many = that many more Modular Account v2 accounts, past the cap
const ev = (s) => keccak256(toHex(s)), word = (a) => pad(a.toLowerCase());
const MA2 = fac("Alchemy Modular Account", "v2"), EP07 = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
function ownerLogs(many) {
  const log = (address, topics, n) => ({ address, topics, data: "0x", blockNumber: toHex(1000 + n) });
  const light = (w, n) => log(w, [ev("LightAccountInitialized(address,address)"), word(EP07), word(OWNER)], n);
  return [light(W.lightlog, 5), light(W.spam, 4), light(W.badfac, 3),
    log("0x9999999999999999999999999999999999999999", [ev("OwnerRegistered(address,address)"), word(W.fakekernel), word(OWNER)], 2),
    log(MA2, [ev("SemiModularAccountDeployed(address,address,uint256)"), word(W.sma), word(OWNER)], 1),
    ...Array.from({ length: many }, (_, i) => log(MA2, [ev("SemiModularAccountDeployed(address,address,uint256)"), word(`0xd0${String(i).padStart(38, "0")}`), word(OWNER)], 100 + i))];
}
function deployedLogs(senders) {
  const factory = { [W.lightlog]: fac("Alchemy LightAccount", "v2.0.0"), [W.badfac]: "0x000000000000000000000000000000000000dead" };
  return senders.map((s) => `0x${s.slice(26)}`).filter((s) => factory[s]).map((s) => ({ address: EP07, topics: [ev("AccountDeployed(bytes32,address,address,address)"), pad("0x01"), word(s)], data: `${word(factory[s])}${"0".repeat(64)}`, blockNumber: "0x1" }));
}
const fakeChain = ({ logs = false, many = 0 } = {}) => ({
  live: () => true, local: () => [],
  call: async (id, p, { body } = {}) => {
    if (id === "evm.alchemy_rpc") {
      const f = body.params[0];
      const result = !logs ? [] : Array.isArray(f.topics[0]) ? ownerLogs(many) : deployedLogs(f.topics[2]);
      return { status: 200, ok: true, data: { jsonrpc: "2.0", id: 1, result } };
    }
    if (id === "holdings.alchemy_tokens") {
      const tokens = { [W.cb]: [{ network: "base-mainnet", tokenAddress: BIG_TOKENS.base[0], tokenBalance: "0x4c4b40", tokenMetadata: { symbol: "USDC", name: "USD Coin", decimals: 6 }, tokenPrices: [{ currency: "usd", value: "1" }] }],
        [W.simple]: [{ network: "base-mainnet", tokenAddress: null, tokenBalance: "0x16345785d8a0000", tokenMetadata: {}, tokenPrices: [{ currency: "usd", value: "3000" }] }] }[p.address.toLowerCase()] || [];
      return { status: 200, ok: true, data: { data: { tokens } } };
    }
    if (id !== "evm.rpc") return { status: 404, ok: false, data: { error: `no answer for ${id}` } };
    if (p.chain !== "base") return { status: 404, ok: false, data: { error: "only base here" } };
    if (body.method === "eth_getCode") return { status: 200, ok: true, data: { jsonrpc: "2.0", id: 1, result: body.params[0].toLowerCase() === W.simple.toLowerCase() ? "0x6080" : "0x" } };
    const { args: [calls] } = decodeFunctionData({ abi: mc, data: body.params[0].data });
    const result = calls.map((c) => { const r = chainAnswer(c.target, c.callData); return { success: true, returnData: r }; });
    return { status: 200, ok: true, data: { jsonrpc: "2.0", id: 1, result: encodeFunctionResult({ abi: mc, functionName: "aggregate3", result }) } };
  },
});

test("4337: an undeployed account with money counts (the factory binds the owner); a moved owner and an empty one are dropped", async () => {
  const d = await ownedAccounts(fakeChain(), OWNER, { chains: ["base"] });
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.accounts.map((a) => [a.wallet.toLowerCase(), a.kind, a.version, a.deployed]), [[W.cb, "Coinbase Smart Wallet", "v1", false]]);
  assert.ok(!JSON.stringify(d).toLowerCase().includes(W.light) && !JSON.stringify(d).toLowerCase().includes(W.empty));
});

test("4337: unclear owners are hints, never accounts: a Kernel that moved its root validator, code that skips owner()", async () => {
  const d = await ownedAccounts(fakeChain(), OWNER, { chains: ["base"] });
  assert.deepEqual(d.hints.map((h) => [h.wallet.toLowerCase(), h.kind, h.version]), [[W.simple, "SimpleAccount", "v0.7"], [W.kernel, "ZeroDev Kernel", "v3.1"]]);
  assert.match(d.hints.find((h) => h.wallet.toLowerCase() === W.kernel).why, /another validator/);
  assert.match(d.hints.find((h) => h.wallet.toLowerCase() === W.simple).why, /does not answer the owner check/);
});

test("4337 logs: a setup log counts only from a trusted emitter or with the EntryPoint naming one of our factories", async () => {
  const d = await ownedAccounts(fakeChain({ logs: true }), OWNER, { chains: ["base"] });
  assert.deepEqual(d.errors, []);
  const found = d.accounts.filter((a) => a.salt === null).map((a) => [a.wallet.toLowerCase(), a.kind, a.version, a.deployed]);
  assert.deepEqual(found, [[W.lightlog, "Alchemy LightAccount", "v2.0.0", true], [W.sma, "Alchemy Modular Account", "v2", true]]);
  // spam (never deployed through an EntryPoint), another factory's account, an untrusted validator: not even hints
  for (const w of [W.spam, W.badfac, W.fakekernel]) assert.ok(!JSON.stringify(d).toLowerCase().includes(w), w);
});

test("4337 logs: an owner that hundreds of accounts name (an app's signer) gets the newest ones and a note", async () => {
  const d = await ownedAccounts(fakeChain({ logs: true, many: LOG_CAP + 10 }), OWNER, { chains: ["base"] });
  // 36 Modular Account v2 logs (the newest) + the 3 LightAccount ones are 39 candidates: the newest 25 are checked
  assert.equal(d.accounts.filter((a) => a.salt === null).length, LOG_CAP);
  assert.deepEqual(d.errors, [`4337 base: 14 more accounts name this owner in their setup logs, not checked (the newest ${LOG_CAP} were)`]);
});

test("smart wallets: hint tokens are one low finding out of the totals; the undeployed account's tokens are holdings", () => {
  const items = [
    { kind: "token", chain: "base", protocol: "Coinbase Smart Wallet", wallet: W.cb, asset: "USDC", token: BIG_TOKENS.base[0].toLowerCase(), amount: 5, usd: 5, verified: true, detail: "held by your Coinbase Smart Wallet v1 smart account ... (not deployed there yet ...)" },
    { kind: "token", chain: "base", protocol: "SimpleAccount", wallet: W.simple, asset: "ETH", token: "native", amount: 0.1, usd: 300, verified: true, hint: true, why: "it has code that does not answer the owner check", detail: "held by SimpleAccount v0.7 smart account ..." },
    { kind: "token", chain: "base", protocol: "SimpleAccount", wallet: W.simple, asset: "USDC", token: BIG_TOKENS.base[0].toLowerCase(), amount: 20, usd: 20, verified: true, hint: true, detail: "held by SimpleAccount v0.7 smart account ..." },
  ];
  const h = F.smartWallets({ items });
  assert.deepEqual(h.map((x) => [x.asset, x.usd]), [["USDC", 5]]);
  const [f] = F.smartWalletHints({ items });
  assert.deepEqual([f.category, f.confidence, f.usd, f.asset, f.amount, f.source], ["reward", "low", 320, "ETH +1", null, "holdings.smart_wallets"]);
  assert.match(f.action, new RegExp(W.simple));
  const s = F.summarize([f], h);
  assert.equal(s.totals.claimable_usd + s.totals.likely_usd, 0);
  assert.equal(s.totals.holdings_usd, 5);
});

test("smart wallets: on the fake chain, the undeployed account's USDC is a holding that says so, the unclear one a low hint", async () => {
  const d = await FORGOTTEN.smartWallets({ address: OWNER }, fakeChain());
  assert.ok(d.errors.every((e) => !/^4337 base|tokens base/.test(e)), d.errors.join("; "));
  const [usdc] = F.smartWallets(d);
  assert.deepEqual([usdc.chain, usdc.protocol, usdc.asset, usdc.amount, usdc.usd], ["base", "Coinbase Smart Wallet", "USDC", 5, 5]);
  assert.match(usdc.detail, /not deployed there yet/);
  const hints = F.smartWalletHints(d);
  assert.deepEqual(hints.map((h) => [h.protocol, h.asset, h.usd, h.confidence]), [["SimpleAccount", "ETH", 300, "low"]]);
  assert.match(hints[0].detail, /check who controls it/);
});

// ---- the more_wallets guide ----
test("more_wallets: every scan answer carries the guide to per-app embedded wallets", async () => {
  const ctx = { live: () => false, local: async () => [], call: async () => ({ status: 404, ok: false, data: {} }) };
  for (const [fn, address] of [["scanEvm", OWNER], ["scanSol", "So11111111111111111111111111111111111111112"]]) {
    const d = await COMPOSE[fn]({ address }, ctx);
    assert.deepEqual(d.more_wallets, MORE_WALLETS);
  }
  assert.deepEqual(MORE_WALLETS.where.map((w) => w.provider), ["Privy", "Magic", "Coinbase Smart Wallet", "Para"]);
  for (const w of MORE_WALLETS.where) assert.match(w.url, /^https:\/\//);
  assert.ok(JSON.stringify(MORE_WALLETS).length < 1500, "kept short");
  assert.ok(!/[–—]/.test(JSON.stringify(MORE_WALLETS)));
});
