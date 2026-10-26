// airdrops.test.mjs - the airdrop index on small local lists (no download), onchain reads stubbed, and the
// airdrop.index normalizer on a real answer captured 2026-10-15 (test/fixtures/airdrop-index.json)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import * as A from "../airdrops/index.mjs";
import * as F from "../findings.mjs";

const dir = mkdtempSync(join(tmpdir(), "ws-airdrops-"));
after(() => { A.reset(); rmSync(dir, { recursive: true, force: true }); });
const W = "0x00000000000000000000000000000000000000a1", W2 = "0xffffffffffffffffffffffffffffffffffffff02", NOBODY = "0x1230000000000000000000000000000000000000";
const DIST = "0xd15700000000000000000000000000000000d157", TOKEN = "0x70ce000000000000000000000000000000070ce0", SAFE_AIRDROP = "0xa0b937d5c8e32a80e3a8ed4227cd020221544ee6";

// three lists: header + amounts (gz, a repeated address), raw units, address only
writeFileSync(join(dir, "open.csv.gz"), gzipSync(`address,amount\n${W},400\n${W2},10\nnot-an-address,5\n${W.toUpperCase().replace("0X", "0x")},5\n`));
writeFileSync(join(dir, "old.csv"), `address,amount\n${W},2000000000000000000\n`);
writeFileSync(join(dir, "pairs.ts"), `export const D = [\n  {\n    "address": "${W}",\n    "earnings": ether(700),\n  },\n];\n{"address":"${W2}","earnings":"0xde0b6b3a7640000","reasons":"x"}\n`);
writeFileSync(join(dir, "safe.txt"), `${W}\n0x4560000000000000000000000000000000000000\n`);
const base = { source: "test", chainId: 1, chain: "ethereum", token: TOKEN, symbol: "TOK", link: "https://claim.example" };
const LISTS = [
  { ...base, id: "open", name: "Open drop", url: join(dir, "open.csv.gz"), hash: "a", from: [DIST] },
  { ...base, id: "old", name: "Old drop", url: join(dir, "old.csv"), hash: "b", raw: 18, from: [DIST], until: 1600000000 },
  { ...base, id: "pairs", name: "Pairs drop", url: join(dir, "pairs.ts"), hash: "d", format: "pairs", from: ["0x0000000000000000000000000000000000000000"] },
  { ...base, id: "safe", name: "Safe", url: join(dir, "safe.txt"), hash: "c", vesting: "safe", until: 1672135200 },
];

const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const e18 = 10n ** 18n;
function rpc(claims = {}) {
  return async (chainId, method, params) => {
    const p = params[0];
    if (method === "alchemy_getAssetTransfers") return { transfers: claims[`${p.fromAddress}:${p.toAddress}`] ? [{ hash: "0xc1a1", from: p.fromAddress, metadata: { blockTimestamp: "2021-01-01T00:00:00.000Z" } }] : [] };
    if (method === "eth_getLogs") return p.address === SAFE_AIRDROP && p.topics[2].endsWith(W.slice(2)) ? [{ topics: [p.topics[0], "0x" + "ab".repeat(32)], transactionHash: "0x01" }] : [];
    if (method === "eth_call") {
      const sel = p.data.slice(0, 10);
      if (sel === "0x70a08231" && p.to === TOKEN) return "0x" + word(1_000_000n * e18); // the claim contract still holds tokens
      if (sel === "0x313ce567") return "0x" + word(18);
      if (sel === "0xd7faa145") return "0x" + word(1000n * e18) + word(400n * e18); // vested 1000, claimed 400
      if (sel === "0x9fb0c41d") return "0x" + [W, 0, 0, 208, 1600000000, 1000n * e18, 400n * e18, 0, 0].map((x) => word(x)).join("");
      return "0x" + word(0);
    }
    throw new Error(`unexpected ${method}`);
  };
}
const fetchPrices = async () => new Map([[`ethereum:${TOKEN}`, { price: 2, confidence: 0.99 }], ["ethereum:0x5afe3855358e112b5647b952709e6165e1c1eeee", { price: 0.5, confidence: 0.5 }]]);

test("warm builds one file per list, then keeps them while the hashes match", async () => {
  const w = await A.warm({ dir, lists: LISTS });
  assert.deepEqual(w.errors, []);
  assert.equal(w.lists, 4);
  assert.deepEqual(w.built.sort(), ["old", "open", "pairs", "safe"]);
  assert.equal(w.records, 7); // open: 2 (W merged), old: 1, pairs: 2, safe: 2
  const again = await A.warm({ dir, lists: LISTS });
  assert.deepEqual(again.built, []);
  assert.equal(again.kept, 4);
});

test("lookup reads amounts from the files: repeats add up, raw units are scaled, address-only lists give null", () => {
  const hits = Object.fromEntries(A.lookup(W).map((h) => [h.id, h.amount]));
  assert.deepEqual(hits, { open: 405, old: 2, pairs: 700, safe: null }); // pairs: a .ts entry (ether(n)) and a JSON line (hex wei)
  assert.deepEqual(Object.fromEntries(A.lookup(W2).map((h) => [h.id, h.amount])), { open: 10, pairs: 1 });
  assert.deepEqual(A.lookup(NOBODY), []);
});

test("checkWallet: unclaimed + open, expired after the cutoff, claimed into a vesting with a vested leftover", async () => {
  const r = await A.checkWallet(W, { rpc: rpc(), fetchPrices, now: 1760000000 });
  const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.deepEqual(r.errors, []);
  assert.equal(by.open.status, "unclaimed");
  assert.equal(by.open.usd, 810);
  assert.equal(by.old.status, "expired");
  assert.equal(by.old.usd, null);
  assert.equal(by.safe.status, "claimed");
  assert.equal(by.safe_vesting.status, "unclaimed");
  assert.equal(by.safe_vesting.amount, 600);
  assert.equal(by.safe_vesting.vesting_end, "2024-09-08");
  assert.match(by.safe_vesting.detail, /thin market/);
});

test("checkWallet: a transfer from the claim contract = claimed; an empty claim contract = expired", async () => {
  const claimed = await A.checkWallet(W2, { rpc: rpc({ [`${DIST}:${W2}`]: true }), fetchPrices });
  assert.equal(claimed.items[0].status, "claimed");
  assert.equal(claimed.items[0].claimed_tx, "0xc1a1");
  const empty = rpc();
  const drained = await A.checkWallet(W2, { rpc: (c, m, p) => (m === "eth_call" && p[0].data.startsWith("0x70a08231") ? "0x" + word(0) : empty(c, m, p)), fetchPrices });
  assert.equal(drained.items[0].status, "expired");
  assert.match(drained.items[0].detail, /no longer holds/);
});

test("checkWallet refuses a bad address; with no Alchemy key it reads public RPCs + a keyless explorer (keyless.mjs)", async () => {
  await assert.rejects(A.checkWallet("0x123", { rpc: rpc() }), (e) => e.status === 400);
  const k = [process.env.ALCHEMY_API_KEY, process.env.ALCHEMY_KEY], realFetch = globalThis.fetch, seen = [];
  delete process.env.ALCHEMY_API_KEY; delete process.env.ALCHEMY_KEY;
  const pad = (a) => `0x${a.slice(2).padStart(64, "0")}`;
  globalThis.fetch = async (url, init) => {
    const u = new URL(url);
    seen.push(u.host);
    if (u.host.endsWith("publicnode.com")) { // eth_call: the claim contract holds tokens, 18 decimals
      const b = JSON.parse(init.body), sel = b.params[0].data.slice(0, 10);
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + word(sel === "0x313ce567" ? 18 : sel === "0x70a08231" ? 1_000_000n * e18 : 0) }));
    }
    if (u.host === "api.routescan.io") { // Transfer logs: DIST -> W2 of TOKEN = the claim
      const q = u.searchParams, hit = q.get("module") === "logs" && q.get("address") === TOKEN && q.get("topic1") === pad(DIST) && q.get("topic2") === pad(W2);
      return new Response(JSON.stringify(hit ? { message: "OK", status: "1", result: [{ address: TOKEN, blockNumber: "0x10", logIndex: "0x1", transactionIndex: "0x0", timeStamp: "0x5fee6600", data: "0x" + word(10n * e18), transactionHash: "0xc1a2", topics: [q.get("topic0"), pad(DIST), pad(W2), null] }] } : { message: "No logs found", status: "0", result: [] }));
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + word(0) }));
  };
  try {
    const r = await A.checkWallet(W2, { fetchPrices });
    const open = r.items.find((i) => i.id === "open");
    assert.equal(open.status, "claimed");
    assert.equal(open.claimed_tx, "0xc1a2");
    assert.equal(open.claimed_at, "2021-01-01T00:00:00.000Z");
    assert.ok(seen.includes("api.routescan.io") && seen.some((h) => h.endsWith("publicnode.com")), seen.join(","));
    assert.ok(!seen.some((h) => h.includes("alchemy.com")), seen.join(","));
  } finally {
    globalThis.fetch = realFetch;
    if (k[0]) process.env.ALCHEMY_API_KEY = k[0];
    if (k[1]) process.env.ALCHEMY_KEY = k[1];
  }
});

test("airdrop.index normalizer: only unclaimed items with an open window, high confidence; never claimed or expired", () => {
  const data = JSON.parse(readFileSync(new URL("./fixtures/airdrop-index.json", import.meta.url), "utf8"));
  const out = F.airdropIndex(data, { now: Date.parse("2026-10-15") });
  assert.equal(out.length, 1);
  const [f] = out;
  assert.equal(f.category, "airdrop");
  assert.equal(f.asset, "SHU");
  assert.equal(f.amount, 1000);
  assert.equal(f.confidence, "high");
  assert.equal(f.how_to_claim, "https://claim.shutter.network");
  assert.match(f.action, /withdraw the vested SHU/);
  // an unknown status is a low hint; past its deadline it is dropped
  const hint = F.airdropIndex({ items: [{ kind: "airdrop", id: "x", source: "rotki", name: "X", symbol: "X", status: "unknown", deadline: null }, { kind: "airdrop", id: "y", name: "Y", status: "unclaimed", deadline: "2020-01-01" }] });
  assert.equal(hint.length, 1);
  assert.equal(hint[0].confidence, "low");
});

test("dYdX-style cumulative lists and Sablier campaigns: array + merkle-tree files, getClaimed, indexer claims, unpriced = hint", async () => {
  const d2 = mkdtempSync(join(tmpdir(), "ws-airdrops2-"));
  const DYDX = "0xd1d1000000000000000000000000000000000d1d", TREASURY = "0x7ea5000000000000000000000000000000007ea5", SAB_TOKEN = "0x5ab0000000000000000000000000000000005ab0";
  writeFileSync(join(d2, "dydx.json"), JSON.stringify([[W, "5000000000000000000000"], [W2, "1000000000000000000"]]));
  // Sablier's IPFS file: the tree's leaf values are the raw amounts (the "recipients" amounts are not always raw)
  const tree = (rows) => JSON.stringify({ merkle_tree: JSON.stringify({ format: "standard-v1", tree: ["0x" + "ab".repeat(32)], values: rows.map(([a, v], i) => ({ value: [String(i), a, v], tree_index: i + 1 })), leaf_encoding: ["uint", "address", "uint256"] }), recipients: rows.map(([address]) => ({ address, amount: "1" })) });
  writeFileSync(join(d2, "sab.json"), tree([[W, "2500000"], [NOBODY, "7"]]));
  writeFileSync(join(d2, "sab2.json"), tree([[W, "9000000"]]));
  const L = [
    { ...base, id: "dydx", name: "dYdX", url: join(d2, "dydx.json"), hash: "e", format: "array", raw: 18, token: DYDX, symbol: "DYDX", cumulative: "0xd157000000000000000000000000000000000001", funds: TREASURY },
    { ...base, id: "sab", name: "Camp", url: join(d2, "sab.json"), hash: "f", format: "tree", raw: 6, chainId: 999, chain: "hyperevm", token: SAB_TOKEN, symbol: "SAB", campaign: "0xc0-999", until: 1900000000 },
    { ...base, id: "sab2", name: "Presale", url: join(d2, "sab2.json"), hash: "g", format: "tree", raw: 6, chainId: 999, chain: "hyperevm", token: "0x9999999999999999999999999999999999999999", symbol: "NOPE", campaign: "0xc1-999", until: null },
  ];
  try {
    const w = await A.warm({ dir: d2, lists: L });
    assert.deepEqual(w.errors, []);
    assert.deepEqual(Object.fromEntries(A.lookup(W).map((h) => [h.id, h.amount])), { dydx: 5000, sab: 2.5, sab2: 9 });
    const stub = (c, m, p) => {
      if (m === "eth_call" && p[0].data.startsWith("0xeb46260e")) return "0x" + word(1000n * e18); // 1000 DYDX claimed so far
      if (m === "eth_call" && p[0].data.startsWith("0x70a08231")) return "0x" + word(10n ** 6n * e18);
      return rpc()(c, m, p); // vesting reads: the shared stub
    };
    const queries = [];
    const sablierQuery = async (q, v) => { queries.push(v); return { Action: [], Campaign: [] }; };
    const px = async () => new Map([[`ethereum:${DYDX}`, { price: 0.1, confidence: 0.99 }], [`hyperliquid:${SAB_TOKEN}`, { price: 4, confidence: 0.99 }]]);
    const r = await A.checkWallet(W, { rpc: stub, sablierQuery, fetchPrices: px, now: 1760000000 });
    const by = Object.fromEntries(r.items.map((i) => [i.id, i]));
    assert.deepEqual(r.errors, []);
    assert.equal(queries.length, 1); // one indexer query for every Sablier hit
    assert.deepEqual(queries[0].ids.sort(), ["0xc0-999", "0xc1-999"]);
    assert.equal(by.dydx.status, "unclaimed");
    assert.equal(by.dydx.amount, 4000);
    assert.equal(by.dydx.usd, 400);
    assert.equal(by.sab.status, "unclaimed");
    assert.equal(by.sab.usd, 10);
    assert.equal(by.sab2.status, "unknown"); // no market price: only a hint
    assert.match(by.sab2.detail, /no market price/);
    const claimed = await A.checkWallet(W, { rpc: (c, m, p) => (p[0].data?.startsWith("0xeb46260e") ? "0x" + word(5000n * e18) : stub(c, m, p)), sablierQuery: async () => ({ Action: [{ campaign_id: "0xc0-999", hash: "0xcl", timestamp: "1700000000" }], Campaign: [{ id: "0xc1-999" }] }), fetchPrices: px, now: 1760000000 });
    const cb = Object.fromEntries(claimed.items.map((i) => [i.id, i]));
    assert.equal(cb.dydx.status, "claimed");
    assert.equal(cb.sab.status, "claimed");
    assert.equal(cb.sab.claimed_tx, "0xcl");
    assert.equal(cb.sab2.status, "expired"); // clawed back
  } finally { rmSync(d2, { recursive: true, force: true }); }
});
