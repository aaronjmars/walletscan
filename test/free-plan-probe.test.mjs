// free-plan-probe.test.mjs - the one 16-block eth_getLogs a scan sends first: a Free plan key is marked before any
// source runs; a paid key, no key or no answer leaves it unmarked. Upstreams are a stubbed fetch (no network)
import { test } from "node:test";
import assert from "node:assert/strict";

const FREE = { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x1, 0xa]. Upgrade to PAYG for expanded block range." } };
let answer = () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: [] }));
const sent = [];
globalThis.fetch = async (url, opts) => { sent.push({ url: String(url), body: JSON.parse(opts.body) }); return answer(); };
const K = await import("../keyless.mjs");

test("probeLogsCap: no key sends nothing; a paid key, a dead upstream leave it unmarked; a Free key marks it once", async () => {
  assert.equal(await K.probeLogsCap(""), false);
  assert.equal(sent.length, 0);
  assert.equal(await K.probeLogsCap("paidKEY0123456789"), false);
  assert.deepEqual(sent[0].body.params[0], { fromBlock: "0x1", toBlock: "0x10", address: "0x0000000000000000000000000000000000000000" });
  answer = () => { throw new Error("fetch failed"); };
  assert.equal(await K.probeLogsCap("paidKEY0123456789"), false);
  answer = () => new Response(JSON.stringify(FREE), { status: 400 });
  const err = console.error, said = [];
  console.error = (m) => said.push(String(m));
  try {
    assert.equal(await K.probeLogsCap("freeKEY0123456789"), true);
    assert.equal(K.logsCapped(), true);
    const n = sent.length;
    assert.equal(await K.probeLogsCap("freeKEY0123456789"), true);
    assert.equal(sent.length, n, "known: no second probe");
  } finally { console.error = err; }
  assert.equal(said.filter((m) => /Free plan/.test(m)).length, 1);
});
