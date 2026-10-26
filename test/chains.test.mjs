import { test } from "node:test";
import assert from "node:assert/strict";
import { alchemyTokens, ALCHEMY_IDS } from "../chains/alchemy.mjs";

// one fake Portfolio API page per group: a priced token, an unpriced spam token, a priced token with a link-like name,
// a zero balance and a native row
const page = (networks) => ({
  data: {
    tokens: networks.includes("eth-mainnet") ? [
      { network: "eth-mainnet", tokenAddress: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", tokenBalance: "0x" + (2_000_000n).toString(16), tokenMetadata: { symbol: "USDC", name: "USD Coin", decimals: 6 }, tokenPrices: [{ currency: "usd", value: "1.0", lastUpdatedAt: new Date().toISOString() }] },
      { network: "eth-mainnet", tokenAddress: "0x1111111111111111111111111111111111111111", tokenBalance: "0x10", tokenMetadata: { symbol: "Visit claim-usdc.xyz", name: "x", decimals: 18 }, tokenPrices: [] },
      { network: "eth-mainnet", tokenAddress: "0x35fa164735182de50811e8e2e824cfb9b6118ac2", tokenBalance: "0x64", tokenMetadata: { symbol: "eETH", name: "ether.fi ETH", decimals: 18 }, tokenPrices: [{ currency: "usd", value: "4000", lastUpdatedAt: new Date(Date.now() - 5 * 86400000).toISOString() }] },
      { network: "eth-mainnet", tokenAddress: "0x2222222222222222222222222222222222222222", tokenBalance: "0x0", tokenMetadata: { symbol: "ZERO", decimals: 18 } },
      { network: "eth-mainnet", tokenAddress: null, tokenBalance: "0x5", tokenMetadata: { symbol: "ETH", decimals: 18 } },
    ] : [],
  },
});

test("alchemyTokens keeps real tokens, drops unpriced spam, ignores stale prices", async () => {
  const real = globalThis.fetch, calls = [];
  globalThis.fetch = async (url, init) => { const b = JSON.parse(init.body); calls.push(b.addresses[0].networks); return { ok: true, json: async () => page(b.addresses[0].networks) }; };
  try {
    const tokens = new Map(), added = [];
    const addToken = (m, id, t) => { added.push([id, t]); (m.get(id) || m.set(id, new Map()).get(id)).set(t.token.toLowerCase(), t); };
    const stats = await alchemyTokens("0x1111111111111111111111111111111111111111", tokens, Date.now() + 20000, { addToken, key: "k" });
    assert.equal(stats.calls, 4);
    assert.equal(new Set(calls.flat()).size, calls.flat().length); // every network asked once
    assert.ok(calls.every((n) => n.length <= 20));
    assert.deepEqual(added.map(([id, t]) => `${id}:${t.symbol}`), ["1:USDC", "1:eETH"]);
    assert.equal(added[0][1].alchemy_price, 1);
    assert.equal(added[0][1].raw, "2000000");
    assert.equal(added[1][1].alchemy_price, null); // 5 days old
    assert.equal(stats.spam, 1);
    assert.ok(ALCHEMY_IDS.has(8453) && ALCHEMY_IDS.has(137));
  } finally { globalThis.fetch = real; }
});

test("alchemyTokens does nothing without a key", async () => {
  assert.deepEqual(await alchemyTokens("0x1111111111111111111111111111111111111111", new Map(), Date.now() + 1000, { addToken: () => assert.fail(), key: "" }), { skipped: "no key" });
});
