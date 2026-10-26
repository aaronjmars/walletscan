// keyless.test.mjs - no HELIUS / ALCHEMY / ZERION key: the registry `keyless` stand-ins (public Solana RPC, Alchemy
// JSON-RPC answered by public RPCs + keyless explorers), sol.assets built from token accounts, stuck without a key, and
// skipped_for_keys on scans; with a key set the same calls still go to Helius / Alchemy. Upstreams are a stubbed fetch
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.RETRY_WAIT_MS = "10";
process.env.STUCK_CACHE_DIR = mkdtempSync(join(tmpdir(), "ws-keyless-stuck-"));
for (const k of ["HELIUS_API_KEY", "ALCHEMY_API_KEY", "ALCHEMY_KEY", "ZERION_API_KEY", "ETHERSCAN_API_KEY"]) delete process.env[k];

const S = "5hphCBzfdH8Xvw3QjagX7NaMRxkBneNZ9sQbBoCgkZBg", V = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const M1 = "Mint1111111111111111111111111111111111111111", TOKEN_PROG = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const json = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const rpcOk = (result) => json({ jsonrpc: "2.0", id: 1, result });

const alchemyOffNets = new Set();
const calls = [];
let explorer = () => ({ message: "No logs found", status: "0", result: [] });
let publicRpc = (b) => rpcOk(b.method === "eth_blockNumber" ? "0x10" : "0x" + word(0));
globalThis.fetch = async (url, opts = {}) => {
  const u = new URL(String(url));
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ host: u.host, url: String(url), method: body?.method });
  if (u.host === "api.mainnet-beta.solana.com" || u.host === "mainnet.helius-rpc.com") {
    if (body.method === "getTokenAccountsByOwner") {
      const legacy = body.params[1].programId === TOKEN_PROG;
      return rpcOk({ value: legacy ? [
        { pubkey: "Acc1", account: { lamports: 2039280, space: 165, data: { parsed: { info: { mint: M1, state: "initialized", tokenAmount: { amount: "5000000", decimals: 6, uiAmount: 5 } } } } } },
        { pubkey: "Acc2", account: { lamports: 2039280, space: 165, data: { parsed: { info: { mint: "Mint2222222222222222222222222222222222222222", state: "initialized", tokenAmount: { amount: "0", decimals: 6, uiAmount: 0 } } } } } },
      ] : [] });
    }
    if (body.method === "getMultipleAccounts") return rpcOk({ value: [{ lamports: 2_000_000_000, owner: "11111111111111111111111111111111", space: 0, data: ["", "base64"] }] });
    if (body.method === "getMinimumBalanceForRentExemption") return rpcOk(1488440);
    if (body.method === "getEpochInfo") return rpcOk({ epoch: 900 });
    return rpcOk([]); // getProgramAccounts: nothing
  }
  if (u.host === "api.jup.ag") return json([{ id: M1, symbol: "TKN", isVerified: true, usdPrice: 2, liquidity: 1e6, audit: {} }]);
  if (u.host === "coins.llama.fi") return json({ coins: { "coingecko:solana": { price: 150, confidence: 0.99 }, "coingecko:ethereum": { price: 2500, confidence: 0.99 }, "optimism:0x00000000000000000000000000000000000000aa": { price: 1, confidence: 0.99 } } });
  if (u.host.endsWith("publicnode.com")) return publicRpc(body);
  if (u.pathname.endsWith("/token-balances")) return json([{ token: { address_hash: "0x00000000000000000000000000000000000000Aa", decimals: "6", symbol: "USDX", name: "USD X", type: "ERC-20" }, value: "5000000" }, { token: { address_hash: "0x00000000000000000000000000000000000000bb", type: "ERC-721" }, value: "1" }]);
  if (u.host.endsWith("blockscout.com") || u.host === "api.routescan.io" || u.host === "explorer.optimism.io") {
    if (u.pathname.endsWith("/eth-rpc")) return publicRpc(body);
    return json(explorer(u.searchParams));
  }
  if (u.host === "api.merkl.xyz") return json([]);
  // a network turned off in the Alchemy app
  if (u.host.endsWith(".g.alchemy.com") && alchemyOffNets.has(u.host.split(".")[0])) return json({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: `${u.host.split(".")[0].toUpperCase().replace("-", "_")} is not enabled for this app. Visit this page to enable the network` } }, 403);
  return json({}, 404);
};
const R = await import("../registry.mjs");
const K = await import("../keyless.mjs");
const { callRoute, REG_BY_ID } = await import("../engine.mjs");
const call = (id, params, opts) => callRoute(REG_BY_ID.get(id), params, opts);
after(() => rmSync(process.env.STUCK_CACHE_DIR, { recursive: true, force: true }));
const since = (n) => calls.slice(n);

test("registry: a keyless stand-in is used only when the key is unset, and keeps the route live", () => {
  const e = R.byId("sol.token_accounts");
  const rq = R.buildRequest(e, { owner: S });
  assert.equal(rq.url, K.SOLANA_PUBLIC);
  assert.equal(rq.pace, "solana-owner");
  assert.equal(rq.key, undefined);
  assert.ok(R.routeLive(e) && R.routeLive(R.byId("evm.alchemy")) && R.routeLive(R.byId("bridge.stuck")) && R.routeLive(R.byId("sol.leftovers")));
  assert.ok(!R.routeLive(R.byId("sol.assets")) && !R.routeLive(R.byId("rewards.zerion")) && !R.routeLive(R.byId("sol.serum_open_orders")));
  assert.deepEqual(R.missingKeys(R.byId("holdings.zerion")), ["ZERION_API_KEY"]);
  assert.deepEqual(R.missingKeys(R.byId("sol.token_accounts")), []);
  process.env.HELIUS_API_KEY = "helius-test";
  try {
    const keyed = R.buildRequest(e, { owner: S });
    assert.equal(keyed.url, "https://mainnet.helius-rpc.com/?api-key=helius-test");
    assert.equal(keyed.pace, undefined);
    assert.deepEqual(keyed.key, { name: "HELIUS_API_KEY", slot: 0 });
    assert.equal(R.keylessOf(e), null);
  } finally { delete process.env.HELIUS_API_KEY; }
});

test("engine: Solana routes go to the public RPC without HELIUS_API_KEY, to Helius with it", async () => {
  let n = calls.length;
  const r = await call("sol.token_accounts", { owner: S }, { fresh: true });
  assert.equal(r.status, 200);
  assert.equal(r.data.result.value.length, 2);
  assert.deepEqual(since(n).map((c) => c.host), ["api.mainnet-beta.solana.com"]);
  process.env.HELIUS_API_KEY = "helius-test";
  try {
    n = calls.length;
    await call("sol.token_accounts", { owner: S }, { fresh: true });
    assert.deepEqual(since(n).map((c) => c.url), ["https://mainnet.helius-rpc.com/?api-key=helius-test"]);
  } finally { delete process.env.HELIUS_API_KEY; }
});

test("engine: Alchemy routes answer through evm.keyless_rpc without a key, to Alchemy with it", async () => {
  let n = calls.length;
  const r = await call("evm.alchemy_rpc", { network: "base-mainnet", method: "eth_blockNumber" });
  assert.equal(r.data.result, "0x10");
  assert.deepEqual(since(n).map((c) => c.host), ["base-rpc.publicnode.com"]);
  // full-history logs on a network with no keyless explorer: a JSON-RPC error that names the key, no upstream call
  n = calls.length;
  const logs = await call("evm.alchemy_rpc", { network: "base-mainnet", method: "eth_getLogs" });
  assert.equal(logs.data.error.data.needs_key, "ALCHEMY_API_KEY");
  assert.equal(since(n).length, 0);
  process.env.ALCHEMY_API_KEY = "alchemy-test";
  try {
    n = calls.length;
    await call("evm.alchemy_rpc", { network: "base-mainnet", method: "eth_blockNumber" });
    assert.deepEqual(since(n).map((c) => c.url), ["https://base-mainnet.g.alchemy.com/v2/alchemy-test"]);
    n = calls.length;
    await call("evm.alchemy", { method: "eth_blockNumber" });
    assert.deepEqual(since(n).map((c) => c.url), ["https://eth-mainnet.g.alchemy.com/v2/alchemy-test"]);
  } finally { delete process.env.ALCHEMY_API_KEY; }
  n = calls.length;
  await call("evm.alchemy", { method: "eth_blockNumber" });
  assert.deepEqual(since(n).map((c) => c.host), ["ethereum-rpc.publicnode.com"]);
});

test("key set but the network is off in the Alchemy app: that network goes keyless, once noted, others stay on Alchemy", async () => {
  process.env.ALCHEMY_API_KEY = "alchemy-test";
  alchemyOffNets.add("opt-mainnet");
  try {
    let n = calls.length;
    const r = await call("evm.alchemy_rpc", { network: "opt-mainnet", method: "eth_blockNumber" });
    assert.equal(r.data.result, "0x10");
    assert.deepEqual(since(n).map((c) => c.host), ["opt-mainnet.g.alchemy.com", "optimism-rpc.publicnode.com"]);
    n = calls.length;
    await call("evm.alchemy_rpc", { network: "opt-mainnet", method: "eth_blockNumber" });
    assert.deepEqual(since(n).map((c) => c.host), ["optimism-rpc.publicnode.com"]); // noted: Alchemy not asked again
    assert.ok(K.alchemyOff("opt-mainnet") && !K.alchemyOff("base-mainnet"));
    n = calls.length;
    await call("evm.alchemy_rpc", { network: "base-mainnet", method: "eth_blockNumber" });
    assert.deepEqual(since(n).map((c) => c.host), ["base-mainnet.g.alchemy.com"]);
  } finally { delete process.env.ALCHEMY_API_KEY; alchemyOffNets.clear(); }
});

test("keyless eth_getLogs: OR topics split into single-topic queries (side by side), pages walked from the last block, RPC log shape", async () => {
  const asked = [];
  explorer = (q) => {
    asked.push(Object.fromEntries(q));
    const from = Number(q.get("fromBlock")), t0 = q.get("topic0");
    // topic A: a full page (1000 logs) from block `from`, then 2 more; topic B: one log
    if (t0 === "0xaa") return { status: "1", message: "OK", result: from === 0 ? Array.from({ length: 1000 }, (_, i) => ({ address: "0xC0", topics: ["0xaa", null, "0x01", null], data: "0x", blockNumber: `0x${(1 + Math.floor(i / 10)).toString(16)}`, logIndex: `0x${(i % 10).toString(16)}`, transactionHash: `0x${i}`, transactionIndex: "0x0", timeStamp: "0x5fee6600" })) : [{ address: "0xC0", topics: ["0xaa", null, "0x01"], data: "0x", blockNumber: "0x64", logIndex: "0x9", transactionHash: "0x999", transactionIndex: "0x0" }, { address: "0xC0", topics: ["0xaa", null, "0x01"], data: "0x", blockNumber: "0x65", logIndex: "0x0", transactionHash: "0xnew", transactionIndex: "0x0" }] };
    if (t0 === "0xbb") return { status: "1", message: "OK", result: [{ address: "0xC0", topics: ["0xbb", "0x02", "0x01"], data: "0x01", blockNumber: "50", logIndex: "3", transactionHash: "0xb", transactionIndex: "1" }] };
    return { status: "0", message: "No logs found", result: [] };
  };
  try {
    const got = await K.keylessRpc("eth-mainnet", "eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest", topics: [["0xaa", "0xbb"], null, "0x01"] }]);
    assert.equal(got.length, 1002); // 1000 + the new one past the page cut + topic B (the repeated last log counted once)
    assert.deepEqual(asked.map((q) => [q.topic0, q.topic2, q.topic0_2_opr, q.fromBlock, q.address]).sort(), [["0xaa", "0x01", "and", "0", undefined], ["0xaa", "0x01", "and", "100", undefined], ["0xbb", "0x01", "and", "0", undefined]]);
    const b = got.find((l) => l.transactionHash === "0xb");
    assert.deepEqual([b.blockNumber, b.logIndex, b.transactionIndex, b.topics.length], ["0x32", "0x3", "0x1", 3]);
    assert.ok(got.every((l, i) => i === 0 || Number(l.blockNumber) >= Number(got[i - 1].blockNumber)));
  } finally { explorer = () => ({ message: "No logs found", status: "0", result: [] }); }
});

test("keyless alchemy_getAssetTransfers: external from the tx list, erc20 from Transfer logs; old receipts from an archive RPC", async () => {
  explorer = (q) => (q.get("action") === "txlist"
    ? { status: "1", message: "OK", result: [{ hash: "0xd1", from: V.toLowerCase(), to: "0x00000000219ab540356cbb839cbe05303d7705fa", value: "32000000000000000000", blockNumber: "100", timeStamp: "1600000000", isError: "0" }, { hash: "0xd2", from: V.toLowerCase(), to: "0x1111111111111111111111111111111111111111", value: "1", blockNumber: "101", timeStamp: "1600000001", isError: "0" }] }
    : { status: "0", message: "No logs found", result: [] });
  publicRpc = (b) => rpcOk(b.method === "eth_getTransactionReceipt" ? null : "0x0");
  const n = calls.length;
  try {
    const t = await K.keylessRpc("eth-mainnet", "alchemy_getAssetTransfers", [{ fromAddress: V, toAddress: "0x00000000219ab540356cbb839cbe05303d7705fa", category: ["external"], excludeZeroValue: true }]);
    assert.deepEqual(t.transfers.map((x) => [x.hash, x.value, x.metadata.blockTimestamp]), [["0xd1", 32, "2020-09-13T12:26:40.000Z"]]);
    await assert.rejects(K.keylessRpc("eth-mainnet", "alchemy_getAssetTransfers", [{ fromAddress: V, category: ["internal"] }]), (e) => e.needs_key === "ALCHEMY_API_KEY");
    await K.keylessRpc("eth-mainnet", "eth_getTransactionReceipt", ["0xabc"]);
    assert.deepEqual(since(n).filter((c) => c.method === "eth_getTransactionReceipt").map((c) => c.host), ["ethereum-rpc.publicnode.com", "eth.drpc.org", "rpc.mevblocker.io"]);
  } finally {
    explorer = () => ({ message: "No logs found", status: "0", result: [] });
    publicRpc = (b) => rpcOk(b.method === "eth_blockNumber" ? "0x10" : "0x" + word(0));
  }
});

test("keyless tx list: a long history is read in 1,000-row pages side by side (10,000 max), a short one in one call", async () => {
  const pages = [];
  const row = (i, to = "0x2222222222222222222222222222222222222222") => ({ hash: `0x${i.toString(16)}`, from: V.toLowerCase(), to, value: "1000000000000000000", blockNumber: String(100 + i), timeStamp: "1600000000", isError: "0" });
  explorer = (q) => {
    if (q.get("action") !== "txlist") return { status: "0", message: "No logs found", result: [] };
    const n = Number(q.get("page"));
    pages.push([n, q.get("offset")]);
    if (n === 1) return { status: "1", message: "OK", result: Array.from({ length: 1000 }, (_, i) => row(i)) };
    if (n === 2) return { status: "1", message: "OK", result: [row(5000, "0x00000000219ab540356cbb839cbe05303d7705fa")] };
    return { status: "0", message: "No transactions found", result: [] };
  };
  try {
    const t = await K.keylessRpc("eth-mainnet", "alchemy_getAssetTransfers", [{ fromAddress: V, toAddress: "0x00000000219ab540356cbb839cbe05303d7705fa", category: ["external"] }]);
    assert.deepEqual(t.transfers.map((x) => x.hash), ["0x1388"]);
    assert.deepEqual(pages.sort((a, b) => a[0] - b[0]), Array.from({ length: 10 }, (_, i) => [i + 1, "1000"]));
    pages.length = 0;
    explorer = (q) => { pages.push(Number(q.get("page"))); return { status: "1", message: "OK", result: [row(1)] }; };
    await K.keylessRpc("eth-mainnet", "alchemy_getAssetTransfers", [{ fromAddress: V, category: ["external"] }]);
    assert.deepEqual(pages, [1]);
  } finally { explorer = () => ({ message: "No logs found", status: "0", result: [] }); }
});

test("keyless eth_getLogs the explorer cannot search ('use a narrower block range'): a skip for the key, and LlamaPay answers instead of failing", async () => {
  explorer = (q) => (q.get("module") === "logs" ? { status: "0", message: "NOTOK", result: "Timeout reached, please use a narrower block range" } : { status: "0", message: "No logs found", result: [] });
  try {
    const list = [];
    await K.KEY_NOTES.run({ id: "rewards.llamapay", list }, async () => {
      await assert.rejects(K.keylessRpc("eth-mainnet", "eth_getLogs", [{ fromBlock: "0x0", topics: ["0xaa", null, "0x01"] }]), (e) => e.needs_key === "ALCHEMY_API_KEY");
    });
    assert.deepEqual(list.map((x) => x.why), ["full-history event logs on eth-mainnet (too much history for the keyless explorer)"]);
    // every LlamaPay chain skipped for the key (Ethereum: too much history, the others: no keyless explorer)
    const r = await call("rewards.llamapay", { address: V });
    assert.equal(r.ok, true, JSON.stringify(r.data));
    assert.deepEqual([r.data.items, r.data.errors], [[], []]);
  } finally { explorer = () => ({ message: "No logs found", status: "0", result: [] }); }
});

test("keyless NFTs: an ERC721Enumerable owner reads its token ids on the public RPC", async () => {
  publicRpc = (b) => {
    const d = b.params[0].data;
    if (d.startsWith("0x70a08231")) return rpcOk("0x" + word(b.params[0].to.endsWith("11") ? 2 : 0));
    if (d.startsWith("0x2f745c59")) return rpcOk("0x" + word(700 + Number(BigInt("0x" + d.slice(-64)))));
    return rpcOk("0x");
  };
  try {
    const r = await K.keylessNfts("eth-mainnet", V, ["0x0000000000000000000000000000000000000011", "0x0000000000000000000000000000000000000022"]);
    assert.deepEqual(r.ownedNfts, [{ contractAddress: "0x0000000000000000000000000000000000000011", tokenId: "700" }, { contractAddress: "0x0000000000000000000000000000000000000011", tokenId: "701" }]);
  } finally { publicRpc = (b) => rpcOk(b.method === "eth_blockNumber" ? "0x10" : "0x" + word(0)); }
});

test("keyless token balances: native on the public RPC, ERC-20s from Blockscout v2, DefiLlama prices; none for a network without one", async () => {
  publicRpc = (b) => rpcOk(b.method === "eth_getBalance" ? "0xde0b6b3a7640000" : "0x0");
  try {
    const r = await call("holdings.alchemy_tokens", { address: V, networks: "opt-mainnet" });
    assert.deepEqual(r.data.data.tokens.map((t) => [t.tokenAddress, t.tokenBalance, t.tokenMetadata.symbol ?? null, t.tokenPrices[0]?.value ?? null]), [[null, "0xde0b6b3a7640000", null, "2500"], ["0x00000000000000000000000000000000000000aa", "0x4c4b40", "USDX", "1"]]);
    const list = [];
    const b = await K.KEY_NOTES.run({ id: "holdings.smart_wallets", list }, () => K.keylessTokens("base-mainnet", V));
    assert.equal(b.data.tokens.length, 1);
    assert.deepEqual(list.map((x) => x.why), ["ERC-20 balances on base-mainnet"]);
  } finally { publicRpc = (b) => rpcOk(b.method === "eth_blockNumber" ? "0x10" : "0x" + word(0)); }
});

test("a skipped part is noted for the source that ran it", async () => {
  const list = [];
  await K.KEY_NOTES.run({ id: "holdings.smart_wallets", list }, async () => {
    await assert.rejects(K.keylessRpc("bnb-mainnet", "eth_getLogs", [{ topics: ["0xaa"] }]), (e) => e.needs_key === "ALCHEMY_API_KEY");
    await assert.rejects(K.keylessRpc("bnb-mainnet", "eth_getLogs", [{ topics: ["0xbb"] }]));
  });
  assert.deepEqual(list, [{ id: "holdings.smart_wallets", key: "ALCHEMY_API_KEY", why: "full-history event logs on bnb-mainnet" }]);
});

const SOL_OTHERS = ["sol.stake_accounts", "sol.pump_creator_fees", "holdings.perps_sol", "bridge.wormholescan", "sol.vesting_streams", "rewards.sol_dead_apps", "sol.defi", "bridge.mayan", "bridge.debridge", "bridge.lifi", "airdrop.jupiter", "airdrop.parcl", "airdrop.streamflow", "token.goplus_sol"];
test("scan.sol without HELIUS_API_KEY: holdings from the token accounts + Jupiter, rent still found, what a key adds listed", async () => {
  const n = calls.length;
  const r = await call("scan.sol", { address: S, min_usd: "0", skip: SOL_OTHERS.join(",") });
  assert.equal(r.status, 200);
  const d = r.data;
  assert.equal(d.sources["sol.assets"], "ok");
  assert.equal(d.sources["sol.token_accounts"], "ok");
  assert.equal(d.partial, false);
  const tkn = d.holdings.find((h) => h.mint === M1), sol = d.holdings.find((h) => h.asset === "SOL");
  assert.deepEqual([tkn.asset, tkn.amount, tkn.usd, tkn.verified], ["TKN", 5, 10, true]);
  assert.deepEqual([sol.amount, sol.usd], [2, 300]);
  assert.ok(d.findings.some((f) => f.category === "solana_rent"));
  assert.deepEqual(d.skipped_for_keys.map((x) => `${x.id}:${x.key}`).sort(), ["sol.assets:HELIUS_API_KEY", "sol.leftovers:HELIUS_API_KEY"]);
  assert.match(d.skipped_for_keys.find((x) => x.id === "sol.leftovers").why, /Serum/);
  assert.ok(!since(n).some((c) => c.host.includes("helius")));
});

test("scan.evm without keys: Zerion sources are listed in skipped_for_keys, totals and partial as before", async () => {
  const keep = new Set(["rewards.zerion", "holdings.zerion", "rewards.merkl"]);
  const skip = R.REGISTRY.map((e) => e.id).filter((id) => !keep.has(id));
  const r = await call("scan.evm", { address: V, skip: skip.join(",") });
  assert.equal(r.status, 200);
  const d = r.data;
  assert.equal(d.sources["rewards.zerion"], "not configured");
  assert.equal(d.sources["rewards.merkl"], "ok");
  assert.equal(d.partial, false);
  assert.deepEqual(d.failed_sources, []);
  assert.deepEqual(d.skipped_for_keys.map((x) => `${x.id}:${x.key}`), ["rewards.zerion:ZERION_API_KEY", "holdings.zerion:ZERION_API_KEY"]);
  assert.match(d.skipped_for_keys[0].why, /Zerion DeFi positions/);
  assert.equal(d.totals.claimable_usd, 0);
});

test("stuck without a key: a bridge whose history needs Alchemy is skipped (not an error), warm resolves", async () => {
  const { checkWallet, warm } = await import("../stuck/index.mjs");
  const r = await checkWallet(V, { bridges: ["base"] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.skipped[0].bridge, "base");
  assert.equal(r.skipped[0].key, "ALCHEMY_API_KEY");
  assert.match(r.skipped[0].why, /base-mainnet/);
  assert.deepEqual(r.bridges_checked, []);
  // Starknet's index reads 68 topic combinations of Ethereum logs: past what a keyless explorer can serve, so warm
  // lists it in skipped (with the key and why) and resolves
  publicRpc = (b) => rpcOk(b.method === "eth_blockNumber" ? "0x1400000" : "0x" + word(0));
  try {
    const w = await warm();
    assert.ok(Array.isArray(w.errors) && Array.isArray(w.warmed));
    const sk = w.skipped.find((x) => x.bridge === "starknet");
    assert.equal(sk.key, "ALCHEMY_API_KEY");
    assert.match(sk.why, /eth-mainnet \(68 topic \/ address combinations\)/);
    assert.ok(!w.warmed.includes("starknet") && !w.errors.some((e) => e.bridge === "starknet"));
  } finally { publicRpc = (b) => rpcOk(b.method === "eth_blockNumber" ? "0x10" : "0x" + word(0)); }
});
