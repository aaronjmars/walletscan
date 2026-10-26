import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { base58 } from "@scure/base";
import { discoverClmmPositions } from "../forgotten/soldefi.mjs";
import { findPda, seed } from "../solana.mjs";

const ORCA = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";
const OWNER = "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq";
const mint = (i) => base58.encode(createHash("sha256").update(`position-mint-${i}`).digest());
const pda = (m) => findPda([seed("position"), m], ORCA).address;
const bundlePda = (m) => findPda([seed("position_bundle"), m], ORCA).address;
const bundledPda = (m, bit) => findPda([seed("bundled_position"), m, seed(String(bit))], ORCA).address;
const account = (data) => ({ owner: ORCA, data: [data.toString("base64"), "base64"] });
function position(m) {
  const b = Buffer.alloc(216);
  createHash("sha256").update("account:Position").digest().copy(b, 0, 0, 8);
  Buffer.from(base58.decode(mint(500))).copy(b, 8);
  Buffer.from(base58.decode(m)).copy(b, 40);
  b.writeBigUInt64LE(10n, 112); // already owed token A; enough to keep an otherwise empty position
  return account(b);
}
function ctx(mints, accounts) {
  return { call: async (id, p) => {
    if (id === "sol.token_accounts") return { ok: true, status: 200, data: { result: { value: p.program_id ? [] : mints.map((m) => ({ account: { data: { parsed: { info: { mint: m, tokenAmount: { amount: "1", decimals: 0 } } } } } })) } } };
    assert.equal(id, "sol.accounts");
    return { ok: true, status: 200, data: { result: { value: p.pubkeys.split(",").map((a) => accounts.get(a) || null) } } };
  } };
}

test("position discovery finds a real position after 150 unrelated NFTs", async () => {
  const mints = Array.from({ length: 151 }, (_, i) => mint(i));
  const d = await discoverClmmPositions(ctx(mints, new Map([[pda(mints[150]), position(mints[150])]])), OWNER);
  assert.equal(d.pos.length, 1);
  assert.equal(d.pos[0].nft, mints[150]);
  assert.equal(d.coverage.status, "complete");
  assert.equal(d.coverage.checked, 151);
});

test("Orca bundle bitmap discovers first and last positions; a foreign bundle mint is ignored", async () => {
  const m = mint(1), b = Buffer.alloc(136);
  createHash("sha256").update("account:PositionBundle").digest().copy(b, 0, 0, 8);
  Buffer.from(base58.decode(m)).copy(b, 8);
  b[40] = 1; b[71] = 128;
  const records = new Map([[bundlePda(m), account(b)], [bundledPda(m, 0), position(m)], [bundledPda(m, 255), position(m)]]);
  const d = await discoverClmmPositions(ctx([m], records), OWNER);
  assert.deepEqual(d.pos.map((x) => x.bundle_index), [0, 255]);
  assert.equal(d.coverage.bundles, 1);
  Buffer.from(base58.decode(mint(2))).copy(b, 8);
  records.set(bundlePda(m), account(b));
  const foreign = await discoverClmmPositions(ctx([m], records), OWNER);
  assert.equal(foreign.pos.length, 0);
});

test("position discovery preserves completed work and says how many NFTs were unchecked when the budget ends", async () => {
  const mints = Array.from({ length: 151 }, (_, i) => mint(i));
  const d = await discoverClmmPositions(ctx(mints, new Map([[pda(mints[0]), position(mints[0])]])), OWNER, { budgetMs: 0 });
  assert.equal(d.pos.length, 1);
  assert.equal(d.coverage.status, "truncated");
  assert.equal(d.coverage.checked, 100);
  assert.equal(d.coverage.total, 151);
});
