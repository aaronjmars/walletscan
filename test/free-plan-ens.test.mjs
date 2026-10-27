// free-plan-ens.test.mjs - an Alchemy Free plan key (eth_getLogs over 10 blocks at most): wide log reads move to the
// keyless explorer once, narrow ones and other methods stay on the key; ENS names in the CLI resolve to their address.
// Upstreams are a stubbed fetch (no network)
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

process.env.RETRY_WAIT_MS = "10";
process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "ws-free-config-"));
process.env.ALCHEMY_API_KEY = "freeplanKEY0123456789";
const V = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const FREE = { jsonrpc: "2.0", id: 1, error: { code: -32600, message: "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 block range. Based on your parameters, this block range should work: [0x0, 0x9]. Upgrade to PAYG for expanded block range." } };
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url)), body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ host: u.host, method: body?.method, action: u.searchParams.get("action") });
  if (u.host.endsWith(".g.alchemy.com")) {
    if (body?.method !== "eth_getLogs") return json({ jsonrpc: "2.0", id: 1, result: "0x10" });
    const f = body.params[0], wide = f.toBlock === "latest" || BigInt(f.toBlock) - BigInt(f.fromBlock ?? 0) >= 10n;
    return wide ? json(FREE, 400) : json({ jsonrpc: "2.0", id: 1, result: [] });
  }
  if (u.host === "api.routescan.io") return json({ status: "0", message: "No logs found", result: [] });
  return json({}, 404);
};
const K = await import("../keyless.mjs");
const { callRoute, REG_BY_ID } = await import("../engine.mjs");
const logsBody = (fromBlock, toBlock) => ({ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock, toBlock, topics: ["0x" + "11".repeat(32)] }] });

test("wideLogs: over 10 blocks, an open end or no range at all is wide; a block hash or <= 10 blocks is not", () => {
  assert.equal(K.wideLogs({ fromBlock: "0x0", toBlock: "latest" }), true);
  assert.equal(K.wideLogs({}), true);
  assert.equal(K.wideLogs({ fromBlock: "0x10", toBlock: "0x19" }), false);
  assert.equal(K.wideLogs({ fromBlock: "0x10", toBlock: "0x1a" }), true);
  assert.equal(K.wideLogs({ blockHash: "0xab" }), false);
  assert.equal(K.freeLogsCap(JSON.stringify(FREE)), true);
  assert.equal(K.freeLogsCap("up to a 10,000 block range"), false);
});

test("Free plan key: a wide eth_getLogs goes keyless after the first 400, later ones skip Alchemy, narrow ones and other methods stay keyed", async () => {
  const err = console.error, said = [];
  console.error = (m) => said.push(String(m));
  try {
    const r = await callRoute(REG_BY_ID.get("evm.alchemy"), {}, { body: logsBody("0x0", "latest") });
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.result, []);
    assert.ok(calls.some((c) => c.host === "api.routescan.io" && c.action === "getLogs"));
    assert.equal(K.logsCapped(), true);
    assert.equal(said.filter((m) => /Free plan/.test(m)).length, 1);

    const before = calls.length;
    await callRoute(REG_BY_ID.get("evm.alchemy_rpc"), { network: "eth-mainnet" }, { body: logsBody("0x0", "latest") });
    assert.ok(!calls.slice(before).some((c) => c.host.endsWith(".g.alchemy.com")), "no Alchemy call once capped");

    const mid = calls.length;
    const narrow = await callRoute(REG_BY_ID.get("evm.alchemy"), {}, { body: logsBody("0x10", "0x12") });
    assert.equal(narrow.ok, true);
    assert.ok(calls.slice(mid).some((c) => c.host === "eth-mainnet.g.alchemy.com" && c.method === "eth_getLogs"));
    const n = await callRoute(REG_BY_ID.get("evm.alchemy"), {}, { body: { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] } });
    assert.equal(n.data.result, "0x10");
  } finally { console.error = err; }
});

test("Free plan key: a network with no keyless log source is a skip that names the paid plan, not a missing key", async () => {
  const r = await callRoute(REG_BY_ID.get("evm.alchemy_rpc"), { network: "arb-mainnet" }, { body: logsBody("0x0", "latest") });
  assert.match(JSON.stringify(r.data), /needs a paid Alchemy plan/);
});

test("resolveNames: an ENS name becomes its address, addresses and NEAR accounts are kept, a name with no address is a bad address", async () => {
  const { resolveNames, looksLikeName } = await import("../ens.mjs");
  const { addressKind } = await import("../nonevm/address.mjs");
  const isAddr = (a) => !!addressKind(a);
  const fake = async (n) => ({ "vitalik.eth": V }[n] ?? null);
  const r = await resolveNames(["Vitalik.eth", V, "alice.near"], isAddr, fake);
  assert.deepEqual(r.list, [V, V, "alice.near"]);
  assert.deepEqual(r.names, { [V.toLowerCase()]: "vitalik.eth" });
  await assert.rejects(resolveNames(["nobody-here.eth"], isAddr, fake), (e) => e.status === 400 && /no ETH address/.test(e.error));
  await assert.rejects(resolveNames(["down.eth"], isAddr, async () => { throw new Error("HTTP request failed."); }), (e) => e.status === 502);
  assert.equal(looksLikeName("hello"), false);
  assert.equal(looksLikeName("nick.base.eth"), true);
});

test("CLI: an ENS name that does not resolve exits 2 before any scan; a resolved one is logged with its address", async () => {
  const { main } = await import("../cli.mjs");
  const sink = () => ({ text: "", isTTY: false, write(s, cb) { this.text += s; if (typeof cb === "function") cb(); return true; } });
  const io = { stdout: sink(), stderr: sink(), stdin: Readable.from([]), resolveNames: async () => { throw { status: 400, error: "nobody.eth has no ETH address set in ENS" }; } };
  assert.equal(await main(["nobody.eth", "--quiet"], io), 2);
  assert.match(io.stderr.text, /nobody\.eth has no ETH address set in ENS/);
  const { render } = await import("../cli.mjs");
  const out = render({ address: V, kind: "evm", totals: {}, findings: [] }, { names: { [V.toLowerCase()]: "vitalik.eth" } });
  assert.match(out.split("\n")[0], /\(vitalik\.eth, evm\)/);
});
