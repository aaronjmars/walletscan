// proxy.test.mjs - with PROXY_URL set, proxy:true routes (Reya) open a CONNECT tunnel through it with the URL's
// credentials, other routes keep calling fetch directly, and a failed tunnel never shows the proxy password.
// The proxy is a local CONNECT server that records each tunnel and refuses it (no TLS upstream in tests)
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";

const PASSWORD = "proxy-secret-pass-9f8e7d";
const tunnels = [];
const proxy = createServer();
proxy.on("connect", (req, sock) => {
  tunnels.push({ target: req.url, auth: req.headers["proxy-authorization"] || "" });
  sock.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
});
await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));

process.env.PROXY_URL = `http://user-DE-rotate:${PASSWORD}@127.0.0.1:${proxy.address().port}`;

const seen = [];
globalThis.fetch = async (url) => {
  seen.push(String(url));
  return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
};

const { callRoute, REG_BY_ID } = await import("../engine.mjs");
const call = (id, params = {}) => callRoute(REG_BY_ID.get(id), params, { fresh: true });
after(() => proxy.close());

test("Reya goes through PROXY_URL with its credentials, never through plain fetch", async () => {
  const out = await call("holdings.reya_prices");
  assert.equal(out.ok, false);
  assert.ok(tunnels.length >= 1);
  assert.equal(tunnels[0].target, "api.reya.xyz:443");
  assert.equal(tunnels[0].auth, `Basic ${Buffer.from(`user-DE-rotate:${PASSWORD}`).toString("base64")}`);
  assert.ok(!seen.some((u) => u.includes("api.reya.xyz")), seen.join("\n"));
  assert.ok(!JSON.stringify(out).includes(PASSWORD), JSON.stringify(out));
});

test("a route without proxy:true does not use the proxy", async () => {
  const before = tunnels.length;
  const out = await call("holdings.risex", { address: "0x69Be108a2aaA3e06Df75F854DF08d215ACf0Ca7A" });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(tunnels.length, before);
  assert.ok(seen.some((u) => u.includes("api.rise.trade")));
});
