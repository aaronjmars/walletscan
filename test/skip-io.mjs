// skip-io.mjs - record a compose source's upstream answers as a fixture in the hf shape (not a test file itself).
//   node test/skip-io.mjs <module path> <export name> <address> <fixture name> [extra params as JSON]
// e.g. node test/skip-io.mjs forgotten/pinklock.mjs pinkLocks 0xabc... skip-pinklock
// runs the function on live upstreams (keys from env, e.g. ALCHEMY_API_KEY; ROUTES=<module> adds draft route entries
// it exports as ROUTES) and writes
// test/fixtures/<fixture name>.json: [{ id, params, body_sha, status, data }], the shape hf.test.mjs replays.
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { liveCtx } from "./batch-c-io.mjs";
import { buildRequest } from "../registry.mjs";

const sha = (b) => createHash("sha1").update(JSON.stringify(b)).digest("hex");

// a live ctx whose every call lands in log[] (the same call twice is stored once)
// extra: draft route entries not in apis.mjs yet (ROUTES=<module exporting ROUTES> on the CLI)
export function recordCtx(log, extra = []) {
  const live = liveCtx(), seen = new Set(), mine = new Map(extra.map((e) => [e.id, e]));
  const draft = async (e, params, over) => {
    const rq = buildRequest(e, { ...params }, over);
    const res = await fetch(rq.url, { method: rq.method, headers: rq.headers, body: rq.body ? JSON.stringify(rq.body) : undefined, signal: AbortSignal.timeout((rq.timeout || 30) * 1000) });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 4000), _note: "upstream returned non-JSON" }; }
    return { status: res.status, ok: res.ok && !(data?.jsonrpc && data.error && data.result == null) && !(Array.isArray(data?.errors) && data.errors.length && !data.data), data };
  };
  return {
    live: () => true, local: () => [],
    async call(id, params, over = {}) {
      const r = mine.has(id) ? await draft(mine.get(id), params, over) : await live.call(id, params, over);
      const row = { id, params: params || {}, body_sha: over.body == null ? null : sha(over.body), status: r.status, data: r.data };
      const k = `${id}|${JSON.stringify(row.params)}|${row.body_sha}`;
      if (!seen.has(k)) { seen.add(k); log.push(row); }
      return r;
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [mod, fn, address, name, extra] = process.argv.slice(2);
  if (!mod || !fn || !address || !name) { console.error("usage: node test/skip-io.mjs <module path> <export name> <address> <fixture name> [extra params JSON]"); process.exit(2); }
  const m = await import(pathToFileURL(resolve(mod)).href);
  const routes = process.env.ROUTES ? (await import(pathToFileURL(resolve(process.env.ROUTES)).href)).ROUTES : [];
  const log = [];
  const out = await m[fn]({ address, ...(extra ? JSON.parse(extra) : {}) }, recordCtx(log, routes));
  writeFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), JSON.stringify(log) + "\n");
  console.log(JSON.stringify(out, (_, x) => (typeof x === "bigint" ? x.toString() : x), 2));
}
