// batch-h-c.test.mjs - OP Stack exits from the hiddenfunds.xyz gaps (stuck/): Mantle v2 and v1 (bridges/mantle.mjs),
// Manta Pacific (bridges/manta.mjs), Mode, BOB and DBK Chain (core OP_CHAINS on public RPCs), replayed on real answers
// captured 2026-10-21 (test/fixtures/batch-h-c-*.json): Routescan logs, receipt logs, portal and oracle reads
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeEventLog, parseAbiItem, encodeAbiParameters, pad } from "viem";
import { getWithdrawals } from "viem/op-stack";
import * as F from "../findings.mjs";
import { classifyL2oo } from "../stuck/lib.mjs";
import * as mantle from "../stuck/bridges/mantle.mjs";
import * as manta from "../stuck/bridges/manta.mjs";
import { BRIDGES, scanClient } from "../stuck/core.mjs";
import { BRIDGE_KEYS } from "../stuck/index.mjs";

// bigints were saved as "123n"
const fx = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"), (_, v) => (typeof v === "string" && /^\d+n$/.test(v) ? BigInt(v.slice(0, -1)) : v));
const MT = fx("batch-h-c-mantle"), MP = fx("batch-h-c-manta");

// ---- Mantle ----
test("mantle: Routescan bridge logs -> items, v1 and v2 alike, tokens on their Ethereum address", () => {
  const [v1] = mantle.items(MT.logs.v1.result.map(mantle.fromExplorer), []);
  assert.equal(v1.tx, "0x027be9b9bd2e404710a3e3e5c2d046df54e76fa9fd974778031db5791cd8b948");
  assert.equal(v1.asset.address, "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"); // USDC
  assert.equal(v1.amount, 49844201954n);
  assert.equal(v1.owner.toLowerCase(), "0xcb38df7492252eaef253c61b9aed40ec0d06619b");
  assert.equal(typeof v1.logIndex, "number");
  const v2 = mantle.items(MT.logs.v2.result.map(mantle.fromExplorer), []);
  assert.equal(v2.length, 4);
  const meth = v2.find((i) => i.tx === "0x59a7d3015fa26bc46ebca5406e6a8e2bc2636ed2c12db053d55e0b08102ae2b5");
  assert.equal(meth.asset.address, "0xd5F7838F5C461fefF7FE49ea5ebaF7728bB0ADfa"); // mETH on Ethereum
  assert.equal(meth.amount, 2540000000000000000n);
});

test("mantle: a v1 message rebuilds to the version-0 withdrawal the upgrade stored (in sentMessages, proven on L1)", () => {
  const ev = parseAbiItem("event SentMessage(address indexed target, address sender, bytes message, uint256 messageNonce, uint256 gasLimit)");
  const [log] = MT.sent;
  const m = decodeEventLog({ abi: [ev], data: log.data, topics: log.topics }).args;
  const w = mantle.migrate(m);
  assert.equal(w.hash, "0xef5e4c581ddd06adfbde3b33a6259c41dce65554564a0df5c2a026c15aa5283d");
  assert.equal(w.gasLimit, 1309129n);
  assert.equal(w.eth, 0n); // an ERC-20 (mETH) withdrawal moves no ETH or MNT on the portal
  assert.equal(w.mnt, 0n);
  assert.ok(MT.facts[w.hash].provenAt > 0);
});

test("mantle: a direct message-passer withdrawal pays MNT and ETH as two items; the bridge's own messages are skipped", () => {
  const passed = (sender, mnt, eth) => ({
    address: mantle.MANTLE.passer, logIndex: 3, blockNumber: 1n, transactionHash: "0xab",
    topics: ["0x5da382596b838a63b4248e533d8e399b3b0f13ba6c6679f670489d44716cb173", pad("0x01"), pad(sender), pad("0x93a692fe5477902c3cf5f6997c1cf59a3712ced4")],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bytes" }, { type: "bytes32" }], [mnt, eth, 100000n, "0x", pad("0xab")]),
  });
  const got = mantle.items([], [passed("0x93a692fe5477902c3cf5f6997c1cf59a3712ced4", 5n * 10n ** 18n, 10n ** 17n)]);
  assert.equal(got.length, 2);
  assert.equal(got[0].asset.address, mantle.MANTLE.l1Mnt);
  assert.equal(got[0].amount, 5n * 10n ** 18n);
  assert.equal(got[1].asset.kind, "native");
  assert.equal(got[1].amount, 10n ** 17n);
  assert.equal(mantle.items([], [passed(mantle.MANTLE.messenger, 1n, 0n)]).length, 0);
});

// ---- the shared L2OutputOracle reader (Mantle, Manta) ----
test("l2oo: portal facts -> claimed, prove, prove again, waiting, finalize, paused", () => {
  const S = MT.settings, t = MT.facts_at;
  assert.equal(S.period, 43200);
  const v1 = MT.facts["0xef5e4c581ddd06adfbde3b33a6259c41dce65554564a0df5c2a026c15aa5283d"];
  assert.equal(classifyL2oo(v1, S, 0n, t).status, "waiting"); // proven the day before capture, 12 h window
  assert.equal(classifyL2oo(v1, S, 0n, t + 86400).status, "ready-to-finalize");
  // proven in 2024-03 against an output the OP Succinct oracle still holds: finalizes (eth_call of finalizeWithdrawalTransaction passed)
  assert.equal(classifyL2oo(MT.facts["0xe9ffdb9d986ced89649a905f6f95e90d6e222bba0c926583deb6486134d6b160"], S, 0n, t).status, "ready-to-finalize");
  assert.equal(classifyL2oo({ finalized: true }, S, 0n, t).status, "claimed");
  assert.equal(classifyL2oo({ finalized: false, provenAt: 0 }, S, 5n, t).status, "ready-to-prove");
  assert.equal(classifyL2oo({ finalized: false, provenAt: 0 }, S, S.latest + 1n, t).status, "waiting"); // no output past it yet
  for (const bad of [{ provenAt: S.start - 1 }, { output: null }, { output: { ...v1.output, root: `0x${"00".repeat(32)}` } }]) {
    const r = classifyL2oo({ ...v1, ...bad }, S, 0n, t + 86400);
    assert.equal(r.status, "ready-to-prove", JSON.stringify(bad));
    assert.match(r.detail, /prove again/);
  }
  assert.equal(classifyL2oo({ finalized: false, provenAt: 0 }, { ...S, paused: true }, 0n, t).status, "blocked");
});

// ---- Manta Pacific ----
test("manta: index rows from raw eth_getLogs; the messenger's own MessagePassed is not a second withdrawal", () => {
  const rows = MP.logs.map(manta.row).filter(Boolean);
  const mine = rows.filter((r) => r[1] === "0x069be9b9054a4a6b334c53e16a2ff25e062c1fbe720b569ea4d11b1bb1faa161");
  assert.equal(mine.length, 1);
  const [it] = manta.mine(mine, "0xC545293fDE5c35e4E64Be5bf2fC0aCE1Cab00618");
  assert.equal(it.asset.kind, "native");
  assert.equal(it.amount, 1930000000000000000n);
  assert.equal(it.owner.toLowerCase(), "0xc545293fde5c35e4e64be5bf2fc0ace1cab00618");
  assert.equal(manta.mine(mine, "0x0000000000000000000000000000000000000001").length, 0);
});

test("manta: the receipt's withdrawal hash, unproven on the portal -> ready-to-prove (3-day window)", () => {
  const [w] = getWithdrawals({ logs: MP.receiptLogs });
  assert.equal(w.withdrawalHash, MP.hash);
  assert.equal(MP.settings.period, 259200);
  const r = classifyL2oo(MP.facts, MP.settings, 2000000n, MP.facts_at);
  assert.equal(r.status, "ready-to-prove");
});

// ---- registry, public RPCs, findings ----
test("stuck: Mantle, Manta, Mode, BOB and DBK are per-wallet keys; Mode, BOB and DBK read their public RPCs", () => {
  for (const k of ["mantle", "manta", "mode", "bob", "dbk"]) assert.ok(BRIDGE_KEYS.includes(k), k);
  assert.ok(BRIDGE_KEYS.length >= 29);
  assert.ok(!BRIDGE_KEYS.includes("karak")); // K2's portal only pays by Merkle claim now
  assert.equal(scanClient(BRIDGES.dbk).transport.url, "https://rpc.mainnet.dbkchain.io");
  assert.equal(scanClient(BRIDGES.mode).transport.url, "https://mainnet.mode.network");
  assert.equal(scanClient(BRIDGES.bob).chain.contracts.disputeGameFactory[1].address, "0x96123dbFC3253185B594c6a7472EE5A21E9B1079");
  assert.equal(BRIDGES.manta.scan, false);
  assert.equal(typeof BRIDGES.manta.warm, "function");
});

test("stuck findings: a Mantle v1 or DBK withdrawal is a high bridge_stuck finding claimed on Ethereum", () => {
  const [m, d] = F.stuck({ items: [
    { key: "mantle", bridge: "Mantle", status: "ready-to-prove", symbol: "USDC", value: 49844.2, usd: 49839, tx: "0x027be9b9", action: "Mantle v1 withdrawal ..." },
    { key: "dbk", bridge: "DBK Chain", status: "ready-to-prove", symbol: "ETH", value: 32.4785, usd: 82014, tx: "0x31469405" },
  ] });
  assert.equal(m.category, "bridge_stuck");
  assert.equal(m.chain, "ethereum");
  assert.equal(m.how_to_claim, "https://app.mantle.xyz/bridge");
  assert.equal(d.chain, "ethereum");
  assert.match(d.how_to_claim, /0x63CA00232F471bE2A3Bf3C4e95Bc1d2B3EA5DB92/);
  assert.equal(d.confidence, "high");
});
