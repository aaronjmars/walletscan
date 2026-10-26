// batch-c-io.mjs - record / replay for the perps/ venue readers (not a test file itself).
// Capture a fixture from the real upstreams (keys from env, e.g. HELIUS_API_KEY for Solana program reads):
//   node test/batch-c-io.mjs <venue> <address>
// writes test/fixtures/batch-c-<venue>.json { venue, address, captured, calls[] } and prints the items.
// Tests run the reader on replay(fixture): every io call answers what the upstream answered at capture time.
import { readFileSync, writeFileSync } from "node:fs";
import { REGISTRY, buildRequest } from "../registry.mjs";
import { makeIo } from "../perps/rpc.mjs";

const BY_ID = new Map(REGISTRY.map((e) => [e.id, e]));
// BigInt-safe JSON: bigints become { $n: "123" }
const enc = (v) => JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? { $n: x.toString() } : x)));
const dec = (v) => JSON.parse(JSON.stringify(v), (_, x) => (x && typeof x === "object" && Object.keys(x).length === 1 && typeof x.$n === "string" ? BigInt(x.$n) : x));
const keyOf = (kind, args) => `${kind}:${JSON.stringify(enc(args), (k, x) => (k === "abi" ? undefined : x))}`;
// a ctx that runs plain registry routes straight against the upstream (no engine: no pacing, no cache). ok follows
// the engine's rule (engine.mjs softError): a 200 that carries a JSON-RPC error is a failed call
const softError = (d) => !!d && typeof d === "object" && !Array.isArray(d) && ((d.jsonrpc && d.error && d.result == null) || (Array.isArray(d.errors) && d.errors.length > 0 && !d.data));
export function liveCtx() {
  return {
    async call(id, params, over = {}) {
      const e = BY_ID.get(id);
      if (!e) throw { status: 500, error: `unknown step ${id}` };
      if (e.compose) throw { status: 500, error: `${id} is a compose route` };
      const rq = buildRequest(e, { ...params }, over);
      const r = await fetch(rq.url, { method: rq.method, headers: rq.headers, body: rq.body ? JSON.stringify(rq.body) : undefined, signal: AbortSignal.timeout((rq.timeout || 30) * 1000) });
      const text = await r.text();
      let data;
      try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 4000), _note: "upstream returned non-JSON" }; }
      return { status: r.status, ok: r.ok && !softError(data), data };
    },
    live: (id) => BY_ID.has(id),
  };
}

// wrap an io: every call and its answer lands in log[]
export function record(io, log) {
  const wrap = (kind) => async (...args) => {
    try {
      const out = await io[kind](...args);
      log.push({ key: keyOf(kind, args), out: enc(kind === "prices" ? Object.fromEntries(out) : out) });
      return out;
    } catch (e) {
      log.push({ key: keyOf(kind, args), throws: enc({ error: e?.error || e?.message || String(e) }) });
      throw e;
    }
  };
  return Object.fromEntries(["call", "get", "rpc", "multicall", "prices"].map((k) => [k, wrap(k)]));
}

// an io that answers from a captured fixture; a call that was not captured throws (the test then fails loudly)
export function replay(fixture, { strict = true } = {}) {
  const byKey = new Map();
  for (const c of fixture.calls) byKey.set(c.key, c);
  const wrap = (kind) => async (...args) => {
    const c = byKey.get(keyOf(kind, args));
    if (!c) {
      if (strict) throw { error: `not in fixture: ${keyOf(kind, args).slice(0, 200)}` };
      return kind === "multicall" ? args[1].map(() => null) : kind === "prices" ? new Map() : null;
    }
    if (c.throws) throw dec(c.throws);
    const out = dec(c.out);
    return kind === "prices" ? new Map(Object.entries(out)) : out;
  };
  return Object.fromEntries(["call", "get", "rpc", "multicall", "prices"].map((k) => [k, wrap(k)]));
}

export const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

// CLI: capture one venue
if (import.meta.url === `file://${process.argv[1]}`) {
  const [venue, address] = process.argv.slice(2);
  const { EVM_VENUES, SOL_VENUES } = await import("../perps/index.mjs");
  const read = EVM_VENUES[venue] || SOL_VENUES[venue];
  if (!read || !address) { console.error(`usage: node test/batch-c-io.mjs <venue> <address>\nvenues: ${[...Object.keys(EVM_VENUES), ...Object.keys(SOL_VENUES)].join(", ")}`); process.exit(2); }
  const log = [];
  const items = await read(address, record(makeIo(liveCtx()), log));
  const out = { venue, address, captured: new Date().toISOString(), calls: log };
  writeFileSync(new URL(`./fixtures/batch-c-${venue}.json`, import.meta.url), JSON.stringify(out, null, 1) + "\n");
  console.log(JSON.stringify(items, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
}
