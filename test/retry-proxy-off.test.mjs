// retry-proxy-off.test.mjs - Parcl's claim APIs are retried on a cold-start 502 / 504, other routes never retry a
// 502; with PROXY_URL unset a proxy:true route (Reya) calls the upstream directly, as before. Upstreams are a stubbed fetch
import { test } from "node:test";
import assert from "node:assert/strict";

process.env.RETRY_WAIT_MS = "10";
delete process.env.PROXY_URL;

const seen = []; // upstream urls, in call order
const plan = new Map(); // url part -> statuses to answer in turn (the last one repeats)
globalThis.fetch = async (url) => {
  const u = String(url);
  seen.push(u);
  const key = [...plan.keys()].find((k) => u.includes(k));
  const list = key ? plan.get(key) : [404];
  const status = list.length > 1 ? list.shift() : list[0];
  return new Response(status === 200 ? JSON.stringify({ ok: 1 }) : "<html>bad gateway</html>", { status });
};

const { callRoute, REG_BY_ID } = await import("../engine.mjs");
const call = (id, params = {}) => callRoute(REG_BY_ID.get(id), params, { fresh: true });
const hits = (part) => seen.filter((u) => u.includes(part)).length;

const SOL = "4N363FdtEGqG5YbeBiuTyDypJGLwoTWC7meWZgQft6bK";

test("Parcl claim API: a cold-start 502 then 504 is retried until it answers", async () => {
  plan.set("gnome-api-mainnet.fly.dev", [502, 504, 200]);
  const r = await call("airdrop.parcl_gnome", { address: SOL });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.data, { ok: 1 });
  assert.equal(hits("gnome-api-mainnet.fly.dev"), 3);
});

test("Parcl S3 API: a 502 is retried too, at most `retry` times", async () => {
  plan.set("express-prod.parcl-api.com", [502]);
  const r = await call("airdrop.parcl_s3", { address: SOL });
  assert.equal(r.ok, false);
  assert.equal(hits("express-prod.parcl-api.com"), 4); // 1 call + 3 retries
});

test("a route without retryOn never retries a 502", async () => {
  plan.set("api.rise.trade", [502, 200]);
  const r = await call("holdings.risex", { address: "0x69Be108a2aaA3e06Df75F854DF08d215ACf0Ca7A" });
  assert.equal(r.ok, false);
  assert.equal(hits("api.rise.trade"), 1);
});

test("PROXY_URL unset: Reya is called directly", async () => {
  plan.set("api.reya.xyz", [200]);
  const r = await call("holdings.reya_prices");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(hits("api.reya.xyz/v2/assetOraclePrices"), 1);
});
