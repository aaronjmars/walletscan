// bridges-taiko-opbnb-morph.test.mjs - Taiko, opBNB and Morph exits in bridge.stuck (stuck/bridges/{taiko,opbnb,morph}.mjs),
// replayed on real answers captured 2026-10-22 (test/fixtures/bridges-tom-*.json): Taiko relayer rows, L1 status, the
// checkpoint and storage proof, the simulated processMessage; NodeReal's opBNB explorer rows, receipts and BNB Chain
// portal facts; Morph indexer rows, receipt logs, proof, root and the simulated proveAndRelayMessage
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeFunctionData, parseAbi } from "viem";
import { getWithdrawals } from "viem/op-stack";
import * as F from "../findings.mjs";
import { classifyL2oo } from "../stuck/lib.mjs";
import * as taiko from "../stuck/bridges/taiko.mjs";
import * as opbnb from "../stuck/bridges/opbnb.mjs";
import * as morph from "../stuck/bridges/morph.mjs";
import { BRIDGES } from "../stuck/core.mjs";
import { BRIDGE_KEYS } from "../stuck/index.mjs";

// bigints were saved as "123n"
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"), (_, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
const TK = fx("bridges-tom-taiko"), OB = fx("bridges-tom-opbnb"), MO = fx("bridges-tom-morph");

// ---- Taiko ----
const BIG = "0x7EDA9486f0a942Eab0afB83532Bc68b4e171B123";
test("taiko: relayer rows -> items decoded from the raw L2 log (ETH value, ERC20Vault tokens on their Ethereum address)", () => {
  const [eth] = taiko.items(TK.rows[BIG]);
  assert.equal(eth.asset.kind, "native");
  assert.equal(eth.amount, 47954000000000000000n);
  assert.equal(eth.owner, BIG);
  assert.equal(eth.tx, "0x521849258e86d6801e7476736ca1aa8be6d739703a74b2c93896e5d552d77daf");
  assert.equal(eth.message.gasLimit, 0); // sent without a relayer fee: only the owner can claim
  const lrc = taiko.items(TK.rows["0xB66cd4B44B2BD97B8Cd50bc058db5e366f3683aA"]).find((i) => i.asset.symbol === "LRC");
  assert.equal(lrc.asset.address, "0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD"); // LRC on Ethereum
  assert.equal(lrc.amount, 10n * 10n ** 18n);
  assert.equal(lrc.owner, "0xB66cd4B44B2BD97B8Cd50bc058db5e366f3683aA");
  const tko = taiko.items(TK.rows["0x30A648C6B9a5637857D2405C2a9BEE902fE1ed9b"]).find((i) => i.asset.symbol === "TKO");
  assert.equal(tko.asset.address, "0x10dea67478c5F8C5E2D90e5E9B26dBe60c54d800");
  // a message to another chain or a malformed row is not a withdrawal
  assert.equal(taiko.items([{ data: { Raw: { ...TK.rows[BIG][0].data.Raw, address: "0x0000000000000000000000000000000000000001" } } }, {}]).length, 0);
});

test("taiko: the proof processMessage got is a storage proof of the message's signal slot at the checkpoint", () => {
  const [eth] = taiko.items(TK.rows[BIG]);
  const slot = taiko.signalSlot(eth.msgHash);
  assert.equal(TK.proof.storageProof[0].key, slot);
  assert.notEqual(TK.proof.storageProof[0].value, 0n); // the signal is set on Taiko
  const data = taiko.hopProof(TK.checkpoint, TK.proof);
  const abi = parseAbi([`function processMessage((uint64 id, uint64 fee, uint32 gasLimit, address from, uint64 srcChainId, address srcOwner, uint64 destChainId, address destOwner, address to, uint256 value, bytes data) _message, bytes _proof)`]);
  const call = decodeFunctionData({ abi, data: TK.processMessageData });
  assert.equal(call.args[1], data);
  assert.equal(call.args[0].value, eth.amount);
});

test("taiko: L1 status + checkpoint + simulation -> claimable, waiting, retry, recall on Taiko, claimed, paused", () => {
  const [eth] = taiko.items(TK.rows[BIG]);
  assert.equal(TK.status[eth.msgHash], 0); // NEW on Ethereum
  const base = { l1Status: 0, checkpoint: TK.checkpoint, block: eth.block };
  const r = taiko.classify({ ...base, sim: { status: TK.sim[0] } });
  assert.equal(r.status, "claimable");
  assert.match(r.detail, /simulated.*DONE/);
  assert.equal(taiko.classify({ ...base, checkpoint: { ...TK.checkpoint, block: eth.block - 1n } }).status, "waiting");
  assert.equal(taiko.classify({ ...base, checkpoint: null }).status, "waiting");
  assert.equal(taiko.classify({ ...base, sim: "B_INVALID_STATUS()" }).status, "unknown");
  assert.equal(taiko.classify({ l1Status: 1 }).status, "claimable");
  const tko = TK.rows["0x30A648C6B9a5637857D2405C2a9BEE902fE1ed9b"][0];
  assert.equal(TK.status[tko.msgHash], 3); // FAILED on Ethereum: refunded by a recall on Taiko
  const failed = taiko.classify({ l1Status: 3 });
  assert.equal(failed.claimChain, "taiko");
  assert.equal(failed.confidence, "medium");
  for (const s of [2, 4]) assert.equal(taiko.classify({ l1Status: s }).status, "claimed");
  assert.equal(taiko.classify({ ...base, paused: true }).status, "blocked");
});

// ---- opBNB ----
test("opbnb: explorer rows (unfinalized withdrawals) -> receipt withdrawals of the wallet in BNB; the portal facts classify them", () => {
  const user = "0xB7f8e1C04e70cb37533c5b5F184693B66890A482";
  const rows = OB.api[user].data.transfers;
  assert.equal(rows.length, 2);
  const all = rows.flatMap((x) => opbnb.items(OB.receipts[x.hash].logs, user, x.hash, OB.receipts[x.hash].blockNumber));
  assert.equal(all.length, 2);
  for (const it of all) assert.deepEqual(it.asset, opbnb.BNB);
  assert.deepEqual(all.map((i) => i.amount).sort(), [40000000000000000n, 50000000000000000n]);
  assert.equal(opbnb.items(OB.receipts[rows[0].hash].logs, "0x0000000000000000000000000000000000000001", rows[0].hash, 1n).length, 0);
  // both were proven on BNB Chain in 2023 and never finalized: ready to finalize (7-day window long past)
  for (const x of rows) {
    const [w] = getWithdrawals({ logs: OB.receipts[x.hash].logs });
    const r = classifyL2oo(OB.facts[w.withdrawalHash], OB.settings, OB.receipts[x.hash].blockNumber, OB.captured);
    assert.equal(r.status, "ready-to-finalize");
  }
  const other = OB.api["0xf700E1D6Ff419258cD73feE220f7633954A7ECA3"].data.transfers[0];
  const [w] = getWithdrawals({ logs: OB.receipts[other.hash].logs });
  assert.equal(classifyL2oo(OB.facts[w.withdrawalHash], OB.settings, OB.receipts[other.hash].blockNumber, OB.captured).status, "ready-to-prove");
  assert.equal(OB.settings.period, 604800);
});

// ---- Morph ----
test("morph: indexer row -> item; the receipt's SentMessage rebuilds the hash the proof's leaf holds", () => {
  const [it] = MO.indexer.items.map(morph.fromIndexer);
  assert.equal(it.asset.kind, "native");
  assert.equal(it.amount, 2993142000000000000n);
  assert.equal(it.owner, "0xf12a3Ea73f0776101723561fcc2d283F4eb7c40b");
  const m = morph.message(MO.logs, it.nonce);
  assert.equal(m.hash, MO.proof.leaf);
  assert.equal(morph.message(MO.logs, it.nonce + 1n), null);
  const usdc = morph.fromIndexer({ ...MO.indexer.items[0], l1Token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", l2Token: { symbol: "USDC", decimals: 6 }, amount: "5000000" });
  assert.equal(usdc.asset.address, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
  assert.equal(usdc.asset.decimals, 6);
});

test("morph: facts -> claimable (simulated), claimed, waiting, paused", () => {
  const m = morph.message(MO.logs, BigInt(MO.indexer.items[0].withdrawalNonce));
  const facts = { finalized: MO.finalized, hash: m.hash, proof: MO.proof, rootFinal: MO.rootFinal, sim: MO.sim };
  assert.equal(morph.classify(facts).status, "claimable");
  assert.equal(morph.classify({ ...facts, rootFinal: false }).status, "waiting");
  assert.equal(morph.classify({ ...facts, proof: { ...MO.proof, leaf: `0x${"11".repeat(32)}` } }).status, "waiting");
  assert.equal(morph.classify({ ...facts, sim: "Messenger: withdrawal has already been finalized" }).status, "claimed");
  assert.equal(morph.classify({ ...facts, paused: true }).status, "blocked");
  assert.equal(MO.claimed.finalized, true);
  assert.equal(morph.classify({ finalized: MO.claimed.finalized }).status, "claimed");
});

// ---- registry + findings ----
test("stuck: taiko, opbnb and morph are per-wallet keys (32 bridges)", () => {
  for (const k of ["taiko", "opbnb", "morph"]) {
    assert.ok(BRIDGE_KEYS.includes(k), k);
    assert.equal(BRIDGES[k].scan, false);
  }
  assert.ok(BRIDGE_KEYS.length >= 32);
});

test("stuck findings: opBNB is claimed on BNB Chain, Taiko and Morph on Ethereum, a failed Taiko message on Taiko (medium)", () => {
  const [o, t, m, f] = F.stuck({ items: [
    { key: "opbnb", bridge: "opBNB", status: "ready-to-finalize", symbol: "BNB", value: 0.05, usd: 36.5, tx: "0x0fa9d9cd", claimChain: "bsc" },
    { key: "taiko", bridge: "Taiko", status: "claimable", symbol: "ETH", value: 47.954, usd: 114415, tx: "0x52184925" },
    { key: "morph", bridge: "Morph", status: "claimable", symbol: "ETH", value: 2.993, usd: 7142, tx: "0x1c015fcf" },
    { key: "taiko", bridge: "Taiko", status: "claimable", symbol: "TKO", value: 1205, usd: 86.9, tx: "0x703032bf", claimChain: "taiko", confidence: "medium" },
  ] });
  assert.equal(o.chain, "bsc");
  assert.equal(o.how_to_claim, "https://opbnb-bridge.bnbchain.org/history");
  assert.equal(t.chain, "ethereum");
  assert.equal(t.how_to_claim, "https://bridge.taiko.xyz/transactions");
  assert.equal(t.confidence, "high");
  assert.equal(m.chain, "ethereum");
  assert.equal(m.how_to_claim, "https://bridge.morph.network");
  assert.equal(f.chain, "taiko");
  assert.equal(f.confidence, "medium");
});
