// engine.test.mjs - engine.callRoute with no upstream calls: local routes, caller errors, an unset key
import { test } from "node:test";
import assert from "node:assert/strict";

const seen = [];
globalThis.fetch = async (url) => { seen.push(String(url)); return new Response("{}", { status: 404 }); };
const { callRoute, REG_BY_ID } = await import("../engine.mjs");
const call = (id, params = {}) => callRoute(REG_BY_ID.get(id), params);
const refused = (id, params, re) => assert.rejects(call(id, params), (e) => e.status === 400 && (!re || re.test(e.error)));

test("deadline.list answers from data/ and hides closed windows", async () => {
  const r = await call("deadline.list");
  assert.equal(r.ok, true);
  assert.ok(r.data.every((d) => !d.closes || d.closes >= new Date().toISOString().slice(0, 10)));
  const all = await call("deadline.list", { open: "0" });
  assert.ok(all.data.length >= r.data.length);
});

test("scan routes refuse a bad address before any upstream call", async () => {
  const n = seen.length;
  await refused("scan.all", { address: "hello" }, /not a supported wallet address/);
  await refused("scan.all", { address: "vitalik.eth" }, /names are not resolved/);
  await refused("scan.evm", { address: "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq" });
  await refused("scan.sol", {});
  assert.equal(seen.length, n);
});

test("holdings.chains refuses a bad address before probing anything", async () => {
  const n = seen.length;
  await refused("holdings.chains", { address: "hello" }, /EVM 0x/);
  assert.equal(seen.length, n);
});

test("a route with an unset key says so", async () => {
  delete process.env.ZERION_API_KEY;
  await assert.rejects(call("rewards.zerion", { address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" }), (e) => e.status === 400 && e.detail.join() === "ZERION_API_KEY");
});
