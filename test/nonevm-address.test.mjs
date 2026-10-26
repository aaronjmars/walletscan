// nonevm-address.test.mjs - address kinds (nonevm/address.mjs) and the routing in scan.all / scan.wallets: each kind
// goes to its own scan, look-alike formats stay apart, names and unknown strings get a clear 400. No network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { addressKind, toSs58, isName } from "../nonevm/address.mjs";
import { COMPOSE, walletList, SCANNED_KINDS } from "../compose.mjs";
import { CHAINS } from "../nonevm/index.mjs";

const K = (s) => addressKind(s)?.kind ?? null;

test("addressKind: every supported shape, with the normalized address", () => {
  assert.equal(K("0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"), "evm");
  assert.equal(K("CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq"), "solana");
  assert.deepEqual(addressKind("1KYiKJEfdJtap9QX2v9BXJMpz2SfU4pgZw"), { kind: "bitcoin", address: "1KYiKJEfdJtap9QX2v9BXJMpz2SfU4pgZw", type: "p2pkh", hash: "cb71a5b80cfc05f2920248186c8d6a4a8f49ee8e" });
  assert.equal(addressKind("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy").type, "p2sh");
  // bech32 is case-insensitive: an all-caps segwit address is the same lowercase one
  const sw = addressKind("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4");
  assert.deepEqual([sw.kind, sw.address, sw.type], ["bitcoin", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "p2wpkh"]);
  const tr = addressKind("bc1ptpd8h6hmk60khjr8cg3538zmxsxvpqcvjq0y6gq3y0nwp3pvk05s97lf38");
  assert.deepEqual([tr.type, tr.program.length], ["p2tr", 64]);
  assert.deepEqual(addressKind("TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G"), { kind: "tron", address: "TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G", hex: "4189cbcb2372e1c2fbc00f24895a406a0c722c89f3" });
  assert.equal(K("root.near"), "near");
  assert.equal(K("alice.tg"), "near");
  assert.equal(K("6e8b4a35fc1f4a2db3e57d4a6a4c4a5e1b2c3d4e5f60718293a4b5c6d7e8f901"), "near");
  assert.deepEqual(addressKind("0x00000000000000000000000000000000000000000000000000000000000000A5"), { kind: "sui", address: "0x00000000000000000000000000000000000000000000000000000000000000a5" });
  const dot = addressKind("13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB"), ksm = addressKind("F3opxRbN5ZbjJNU511Kj2TLuzFcDq9BGduA9TgiECafpg29");
  assert.deepEqual([dot.kind, dot.prefix, ksm.kind, ksm.prefix], ["polkadot", 0, "polkadot", 2]);
  assert.equal(dot.account, ksm.account); // the Polkadot and Kusama treasuries are one account
  assert.equal(toSs58(dot.account, 2), "F3opxRbN5ZbjJNU511Kj2TLuzFcDq9BGduA9TgiECafpg29");
  const ton = addressKind("EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N");
  assert.deepEqual([ton.kind, ton.address, ton.bounceable], ["ton", "0:83dfd552e63729b472fcbcc8c45ebcc6691702558b68ec7527e1ba403a0f31a8", true]);
  assert.equal(addressKind("0:83DFD552E63729B472FCBCC8C45EBCC6691702558B68EC7527E1BA403A0F31A8").address, ton.address);
  // Harmony one1 = the same 20 bytes as a 0x address
  assert.deepEqual(addressKind("one1pdv9lrdwl0rg5vglh4xtyrv3wjk3wsqket7zxy"), { kind: "evm", address: "0x0b585f8daefbc68a311fbd4cb20d9174ad174016", from: "one1pdv9lrdwl0rg5vglh4xtyrv3wjk3wsqket7zxy", note: "a Harmony one1 address: scanned as its 0x twin" });
});

test("addressKind: look-alikes stay apart and broken checksums are refused", () => {
  // EVM 0x+40 vs Sui 0x+64 vs NEAR implicit 64 hex without 0x
  assert.equal(K(`0x${"ab".repeat(20)}`), "evm");
  assert.equal(K(`0x${"ab".repeat(32)}`), "sui");
  assert.equal(K("ab".repeat(32)), "near");
  assert.equal(K(`0x${"ab".repeat(31)}`), null);
  // one changed character breaks the base58check / bech32 / SS58 / crc16 checksum
  assert.equal(K("1KYiKJEfdJtap9QX2v9BXJMpz2SfU4pgZx"), null);
  assert.equal(K("TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32H"), null);
  assert.equal(K("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5"), null);
  assert.equal(K("13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTC"), null);
  assert.equal(K("EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2O"), null);
  // other chains and plain words are no kind
  for (const s of ["hello", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh", "ltc1qg82tdwc2ejdpwf4w6ls6v3r7eh2pjtfz2n3w5f", "cosmos1hsk6jryyqjfhp5dhc55tc9jtckygx0eph6dd02", "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L", "near", "foo.com"]) assert.equal(K(s), null, s);
  assert.equal(isName("vitalik.eth"), true);
  assert.equal(isName("toly.sol"), true);
  assert.equal(isName("root.near"), false);
});

// a fake ctx that answers every scan route with a stub naming the route it was called on
function routeCtx() {
  const calls = [];
  return { calls, live: () => true, local: () => [], call: async (id, p) => { calls.push([id, p.address]); return { status: 200, ok: true, data: { kind: id, address: p.address } }; } };
}

test("scan.all sends each address kind to its own scan, with the normalized address", async () => {
  const want = { evm: "scan.evm", solana: "scan.sol", ...Object.fromEntries(Object.entries(CHAINS).map(([k, s]) => [k, s.id])) };
  const samples = {
    evm: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", solana: "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq", bitcoin: "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
    tron: "TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G", near: "root.near", sui: `0x${"AB".repeat(32)}`, polkadot: "13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB", ton: "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N",
  };
  for (const kind of SCANNED_KINDS) {
    const ctx = routeCtx();
    const d = await COMPOSE.scanAll({ address: samples[kind] }, ctx);
    assert.equal(d.kind, want[kind], kind);
    assert.equal(ctx.calls[0][1], addressKind(samples[kind]).address, kind);
  }
  assert.ok(SCANNED_KINDS.includes("bitcoin"));
  // the Harmony one1 address is scanned as its 0x twin and the answer names what was pasted
  const ctx = routeCtx();
  const one = await COMPOSE.scanAll({ address: "one1pdv9lrdwl0rg5vglh4xtyrv3wjk3wsqket7zxy" }, ctx);
  assert.deepEqual([one.kind, one.address, one.pasted_address], ["scan.evm", "0x0b585f8daefbc68a311fbd4cb20d9174ad174016", "one1pdv9lrdwl0rg5vglh4xtyrv3wjk3wsqket7zxy"]);
});

test("scan.all: names, unknown strings and unscanned kinds are a 400 that says what is supported", async () => {
  const ctx = routeCtx();
  await assert.rejects(COMPOSE.scanAll({ address: "vitalik.eth" }, ctx), (e) => e.status === 400 && /names are not resolved/.test(e.error));
  await assert.rejects(COMPOSE.scanAll({ address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh" }, ctx), (e) => e.status === 400 && e.error === "not a supported wallet address" && e.detail.supported.length === SCANNED_KINDS.length);
  await assert.rejects(COMPOSE.scanAll({}, ctx), (e) => e.status === 400);
  assert.equal(ctx.calls.length, 0);
});

test("walletList: mixed kinds, duplicates dropped per kind (bech32 case, one SS58 account under two prefixes, one1 = its 0x)", () => {
  const list = walletList([
    "0x0B585F8DaEfBC68a311FbD4cB20d9174aD174016", "one1pdv9lrdwl0rg5vglh4xtyrv3wjk3wsqket7zxy",
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4",
    ...(SCANNED_KINDS.includes("polkadot") ? ["13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB", "F3opxRbN5ZbjJNU511Kj2TLuzFcDq9BGduA9TgiECafpg29"] : []),
  ]);
  assert.deepEqual(list, ["0x0B585F8DaEfBC68a311FbD4cB20d9174aD174016", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", ...(SCANNED_KINDS.includes("polkadot") ? ["13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB"] : [])]);
  assert.throws(() => walletList("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4,vitalik.eth"), (e) => e.status === 400 && /1 address is neither/.test(e.error) && e.detail[0] === "vitalik.eth");
});
