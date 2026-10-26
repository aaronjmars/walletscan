// registry.mjs - the API map dispatcher.
//
// The registry DATA lives in apis.mjs (one entry per upstream API). This file holds the templating +
// request-building logic engine.mjs uses: callRoute(entry, params) fills {placeholders} from the params, injects
// $ENV keys, fetches, and passes the raw upstream body straight back. Adding an API = one entry in apis.mjs.
//
// Entry shape:
//   id        unique route id (group.name)
//   group     bucket for the catalog
//   method    upstream HTTP method (GET | POST)
//   url       upstream URL; may contain {param} / {param=default} and $ENV
//   query     extra query params appended to url (values templated)
//   headers   request headers (values templated; $ENV for secrets)
//   body      POST body object (values templated) -> sent as JSON
//   form      optional true: the body goes form-urlencoded instead (an upstream that takes no JSON, e.g. Omni Explorer)
//   type      "json" (default) | "text"
//   auth      env var that must be set for this route to work (null = keyless)
//   keyless   optional stand-in when no `auth` key is set (the route stays live; with a key nothing changes):
//             "<url>" or {url, pace} = the same request (body, templating) goes to a keyless upstream, paced in that
//             engine.mjs HOST_RPS bucket (public Solana RPC for the Helius routes); {route, params} = the call runs
//             that keyless route instead, with the caller's params + `params` and the body this route would send
//             (evm.keyless_rpc answers Alchemy JSON-RPC from public RPCs + explorers, see keyless.mjs); true = a
//             compose route that runs without the key itself and notes what it skipped (bridge.stuck, airdrop.index)
//   keyWhy    optional: what the key adds, said in a scan's skipped_for_keys when the route was skipped for it
//   input     { param: "doc" }   - documentation only
//   returns   short note on the response shape - documentation only
//   note      optional extra caveat - documentation only
//   pattern   optional { param: "regex" } format check
//   timeout   optional per-route upstream timeout in seconds (default CALL_TIMEOUT)
//   example   sample params for a live check of the route (scan sources must have one); check: how often such a
//             check is worth running, "daily" (default) | "weekly" | "skip"
//   local     optional dataset name in engine.mjs LOCAL: answered in-process from a file in data/ (no upstream call)
//   compose   optional name of a multi-step route in compose.mjs COMPOSE: the route runs other routes
//             and returns the joined answer (url is documentation only); list them in `uses`
//   uses      route ids a compose route runs: it is live only when all of them are (`usesAny`: when one is)
//   cache     optional seconds: repeat calls with the same resolved request are answered from a short in-memory
//             cache (cache.mjs) for that long. opts.fresh always calls the upstream
//   cacheMaxKb optional per-entry size cap in KB for this route's cache (default CACHE_ENTRY_MAX_KB, 1024)
//   retry     optional cap on 429 / 503 retries for this route (default RETRY_MAX)
//   retryOn   optional extra statuses retried the same way, e.g. [502, 504] for an upstream that answers that
//             while it cold-starts (Parcl's claim APIs on fly.dev); other routes never retry a 502 / 504
//   retrySoft optional: also retry an HTTP 200 that carries a JSON-RPC error (Helius DAS database timeouts)
//   proxy     optional true: call the upstream through PROXY_URL when it is set (an upstream that blocks some
//             regions, e.g. Reya); with PROXY_URL unset the route calls the upstream directly
//   pace      optional pacing bucket name in engine.mjs HOST_RPS
//   blocked   optional reason string: the upstream refuses our plan, so the route is not live and a call throws
//             503 without spending a request; delete the field once the plan is fixed
//
// Templating:
//   {name}         value from the caller's param `name`, URL-encoded
//   {name=default} same, but falls back to `default` when the caller omits it
//   $ENV_NAME      replaced by process.env.ENV_NAME (secret, not encoded)
//   {name:int} / {name:int=default}  body/header only, and only as the WHOLE string value: becomes a JSON number
//   {name:list} / {name:list=a,b}    same rules: comma-separated value becomes a JSON array of strings
//   {name:opt}     same rules: the key is dropped from the JSON body when the caller omits it. Also in a url,
//                  as a whole query value (`&next={next:opt}`): an omitted param drops `next=` with its &
// A missing required {param} -> 400. A route whose $ENV is unset -> 400 (not configured), unless it has `keyless`.
import { REGISTRY } from "./apis.mjs";
export { REGISTRY };
const BY_ID = new Map(REGISTRY.map((e) => [e.id, e]));

// resolve {param} / {param=default} from caller params, URL-encoding the value
function fillParams(str, params, encode) {
  const missing = [];
  const out = str.replace(/\{([a-zA-Z0-9_]+)(?:=([^}]*))?\}/g, (_, name, def) => {
    let v = params[name];
    if (v == null || v === "") v = def;
    if (v == null) {
      missing.push(name);
      return "";
    }
    return encode ? encodeURIComponent(v) : String(v);
  });
  return { out, missing };
}

// {name:opt} in a url: as a whole query value it is dropped with its key and one separator when the
// caller omits it; anywhere else it becomes the value or ""
const OPT_QS_RE = /([?&])([^?&=#{}]+)=\{([a-zA-Z0-9_]+):opt\}(?=[&#]|$)/g;
const OPT_RE = /\{([a-zA-Z0-9_]+):opt\}/g;
export function fillUrlOpt(url, params) {
  const has = (n) => params[n] != null && params[n] !== "";
  return url
    .replace(OPT_QS_RE, (_, sep, key, name) => (has(name) ? `${sep}${key}=${encodeURIComponent(params[name])}` : sep === "?" ? "?" : ""))
    .replace(OPT_RE, (_, name) => (has(name) ? encodeURIComponent(params[name]) : ""))
    .replace("?&", "?")
    .replace(/\?(?=#|$)/, "");
}

// Spare keys: NAME_2 ... NAME_9 next to NAME (e.g. HELIUS_API_KEY_2) are more keys for the same provider. Calls
// use the first key that is not marked used up; engine.mjs marks one (markKeyEmpty) when the provider says its
// credits are gone, swaps the next key into that call and keeps using it until the first key's refill.
export function keysFor(name) {
  return [name, ...Array.from({ length: 8 }, (_, i) => `${name}_${i + 2}`)].map((k) => process.env[k]).filter(Boolean);
}
const KEY_EMPTY = new Map(); // "NAME#slot" -> ms until which that key counts as used up
export function markKeyEmpty(name, slot, until) {
  KEY_EMPTY.set(`${name}#${slot}`, until);
}
// the slot in use for NAME: the first key not used up, -1 when every key is
export function keySlot(name) {
  const n = keysFor(name).length, now = Date.now();
  for (let i = 0; i < n; i++) if (!(KEY_EMPTY.get(`${name}#${i}`) > now)) return i;
  return n ? -1 : 0;
}
// resolve $ENV secrets from process.env (the key in use, see keySlot); report any that are unset
function fillEnv(str) {
  const unset = [];
  const out = str.replace(/\$([A-Z0-9_]+)/g, (_, name) => {
    const v = keysFor(name)[Math.max(0, keySlot(name))];
    if (!v) {
      unset.push(name);
      return "";
    }
    return v;
  });
  return { out, unset };
}

// a whole-string {name:int|list|opt} / {name:int|list|opt=default} placeholder
const TYPED_RE = /^\{([a-zA-Z0-9_]+):(int|list|opt)(?:=([^}]*))?\}$/;

function fillDeep(value, params, encode) {
  const missing = [];
  const unset = [];
  const notNumber = [];
  const walk = (v) => {
    if (typeof v === "string") {
      const m = v.match(TYPED_RE);
      if (m) {
        const [, name, type, def] = m;
        let x = params[name];
        if (x == null || x === "") x = def;
        if (type === "opt") return x == null || x === "" ? undefined : String(x);
        if (x == null) {
          missing.push(name);
          return null;
        }
        if (type === "list") return String(x).split(",").map((t) => t.trim()).filter(Boolean);
        if (x === "") return undefined; // {name:int=} = optional number, omitted when not given
        const n = Number(x);
        if (!Number.isFinite(n)) notNumber.push(name);
        return n;
      }
      const a = fillParams(v, params, encode);
      missing.push(...a.missing);
      const b = fillEnv(a.out);
      unset.push(...b.unset);
      return b.out;
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const o = {};
      for (const [k, val] of Object.entries(v)) {
        const w = walk(val);
        if (w !== undefined) o[k] = w;
      }
      return o;
    }
    return v;
  };
  const out = walk(value);
  return { out, missing: [...new Set(missing)], unset: [...new Set(unset)], notNumber: [...new Set(notNumber)] };
}

// the keyless stand-in in use: { url?, pace?, route?, params?, self? } when the route has one and no key is set, else null
export function keylessOf(entry) {
  const k = entry.keyless;
  if (!entry.auth || !k || keysFor(entry.auth).length) return null;
  return k === true ? { self: true } : typeof k === "string" ? { url: k } : k;
}

// Build the concrete upstream request for an entry + caller params.
// over.body (compose steps only) replaces the templated body, e.g. a JSON-RPC batch to the route's url.
// Throws { status, error, detail } on a missing required param or unset $ENV.
export function buildRequest(entry, params, over = {}) {
  if (entry.blocked) throw { status: 503, error: "route blocked upstream", detail: entry.blocked };
  const missing = [];
  const unset = [];
  const notNumber = [];

  // url: {name:opt} query values first, then params URL-encoded, env not
  const kl = keylessOf(entry);
  const u = fillParams(fillUrlOpt(kl?.url || entry.url, params), params, true);
  missing.push(...u.missing);
  const ue = fillEnv(u.out);
  unset.push(...ue.unset);
  let url = ue.out;

  // extra query params
  if (entry.query) {
    const q = new URL(url);
    for (const [k, tmpl] of Object.entries(entry.query)) {
      const opt = String(tmpl).match(TYPED_RE);
      if (opt && opt[2] === "opt") {
        if (params[opt[1]] != null && params[opt[1]] !== "") q.searchParams.set(k, String(params[opt[1]]));
        continue;
      }
      const p = fillParams(String(tmpl), params, false);
      missing.push(...p.missing);
      const e = fillEnv(p.out);
      unset.push(...e.unset);
      q.searchParams.set(k, e.out);
    }
    url = q.toString();
  }

  // headers (secrets allowed, not encoded)
  const headers = {};
  if (entry.headers) {
    const h = fillDeep(entry.headers, params, false);
    missing.push(...h.missing);
    unset.push(...h.unset);
    notNumber.push(...h.notNumber);
    Object.assign(headers, h.out);
  }

  // body (POST)
  let body;
  if (over.body !== undefined) {
    body = over.body;
    if (!headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = "application/json";
  } else if (entry.body) {
    const b = fillDeep(entry.body, params, false);
    missing.push(...b.missing);
    unset.push(...b.unset);
    notNumber.push(...b.notNumber);
    body = b.out;
    if (entry.form) { // a form POST (Omni Explorer): the filled body object goes urlencoded, as a string
      body = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString();
      if (!headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = "application/x-www-form-urlencoded";
    }
    if (!headers["content-type"] && !headers["Content-Type"]) headers["content-type"] = "application/json";
  }

  const miss = [...new Set(missing)];
  if (miss.length) throw { status: 400, error: "missing required param(s)", detail: miss };
  const bad = Object.entries(entry.pattern || {})
    .filter(([k, re]) => params[k] != null && params[k] !== "" && !new RegExp(re).test(String(params[k])))
    .map(([k]) => k);
  if (bad.length) throw { status: 400, error: "param(s) have an invalid format", detail: bad };
  const nan = [...new Set(notNumber)];
  if (nan.length) throw { status: 400, error: "param(s) must be a number", detail: nan };
  const un = [...new Set(unset)];
  if (un.length && !kl) throw { status: 400, error: "route not configured (unset env)", detail: un };

  return { url, method: entry.method, headers, body, type: entry.type || "json", timeout: entry.timeout, ...(entry.auth && !kl && { key: { name: entry.auth, slot: Math.max(0, keySlot(entry.auth)) } }), ...(kl?.pace && { pace: kl.pace }) };
}

// which routes are callable right now (keyless, their auth env is set, or they have a keyless stand-in)
const liveId = (id) => BY_ID.has(id) && routeLive(BY_ID.get(id));
export function routeLive(entry) {
  if (entry.blocked) return false;
  if (entry.uses && !entry.uses.every(liveId)) return false;
  if (entry.usesAny && !entry.usesAny.some(liveId)) return false;
  if (!entry.auth || process.env[entry.auth]) return true;
  const k = entry.keyless;
  return k?.route ? liveId(k.route) : !!k;
}

// the unset keys that keep a route from running (its own, or a route it uses): what scans list in skipped_for_keys
export function missingKeys(entry, seen = new Set()) {
  if (!entry || seen.has(entry.id) || routeLive(entry)) return [];
  seen.add(entry.id);
  const deps = [...(entry.uses || []), ...(entry.usesAny || [])].filter((id) => !liveId(id)).flatMap((id) => missingKeys(BY_ID.get(id), seen));
  return [...new Set([...(entry.auth && !process.env[entry.auth] ? [entry.auth] : []), ...deps])];
}
export const byId = (id) => BY_ID.get(id);

