// index.mjs - stuck as a library: unclaimed bridge withdrawals for one EVM wallet, for compose.mjs to call.
// Importing it runs nothing (no CLI, no process.exit); env is read at call time.
//
//   import { checkWallet, warm, BRIDGE_KEYS, STUCK_STATUSES } from "./stuck/index.mjs";
//   const { items, errors, bridges_checked } = await checkWallet("0x...", { bridges: ["base", "cctp"], includeAll: false });
//
// Env: ALCHEMY_KEY or ALCHEMY_API_KEY (without it: public RPCs + keyless explorers, ../keyless.mjs; a bridge that
// needs the key for a part lands in skipped[] {bridge, key, why}, not errors), STUCK_CACHE_DIR (on-disk indexes,
// default stuck/.cache/).
// Errors thrown are plain objects { status, error, detail } for the caller to return as is.

import { isAddress, getAddress } from "viem";
import { pool, needsKeyOf, SHOWN } from "./lib.mjs";
import { KEY_NOTES } from "../keyless.mjs";
import { BRIDGES, enrich, checkAddress, toJson, keylessSkip, noteKeylessSkip, skipError } from "./core.mjs";

// Every key checkWallet accepts (a bridge marked scanOnly has no way to find one wallet's withdrawals).
const BRIDGE_KEYS = Object.values(BRIDGES).filter((b) => !b.scanOnly).map((b) => b.key);
// What checkWallet returns by default: claimable now, or blocked until the bridge team acts.
const STUCK_STATUSES = [...SHOWN];

// errors[] -> { errors, skipped }: the parts that need a key no keyless source stands in for, once each
const split = (errors) => ({
  errors: errors.filter((e) => !e.needs_key),
  skipped: [...new Map(errors.filter((e) => e.needs_key).map((e) => [`${e.bridge}|${e.needs_key}|${e.why || e.error}`, { bridge: e.bridge, key: e.needs_key, why: e.why || e.error }])).values()],
});

// Two wallets at a time, like the CLI: rate-limited APIs (Iris, DLN stats, Wormholescan) stay under their caps.
let running = 0;
const queue = [];
async function gate(fn) {
  while (running >= 2) await new Promise((r) => queue.push(r));
  running++;
  try { return await fn(); } finally { running--; queue.shift()?.(); }
}

// One wallet on every bridge (or the given keys), priced. A bridge that fails lands in errors, never throws.
// Items are plain JSON (BigInts as strings), the same objects `stuck.mjs check --json` prints.
async function checkWallet(address, { bridges, includeAll } = {}) {
  if (typeof address !== "string" || !isAddress(address)) throw { status: 400, error: "invalid address", detail: address };
  if (bridges != null && !Array.isArray(bridges)) throw { status: 400, error: "bridges must be an array of keys", detail: bridges };
  const bad = (bridges ?? []).find((k) => !BRIDGE_KEYS.includes(k));
  if (bad !== undefined) throw { status: 400, error: "unknown bridge", detail: bad };
  const list = bridges?.length ? [...new Set(bridges)].map((k) => BRIDGES[k]) : BRIDGE_KEYS.map((k) => BRIDGES[k]);
  // skipped[] is the whole account of what needed a key: the notes deep inside (keyless.mjs) stay out of the caller's
  return gate(() => KEY_NOTES.run({ id: "bridge.stuck", list: [] }, async () => {
    const errors = [];
    const all = await checkAddress(getAddress(address), list, errors);
    await enrich(all);
    const items = toJson(all.filter((i) => includeAll || SHOWN.has(i.status)));
    const { skipped, errors: failed } = split(errors);
    const whole = new Set(errors.filter((e) => e.needs_key && e.whole).map((e) => e.bridge)); // not checked at all
    return { items, errors: failed, ...(skipped.length && { skipped }), bridges_checked: list.map((b) => b.key).filter((k) => !whole.has(k)) };
  }));
}

// Build or update the indexes (starknet, ronin, sui, lisk, manta on disk; dYdX registrations for starkex in memory)
// so the first real request is fast. Cold disk: about 2.5 min; warm disk: under a second, plus ~15 s once
// per process for dYdX. Failures come back in errors, never throw.
async function warm() {
  const t0 = Date.now();
  const list = Object.values(BRIDGES).filter((b) => b.warm);
  const errors = [], timings = {};
  await pool(list, list.length, async (b) => {
    const t = Date.now(), skip = keylessSkip(b.key);
    if (skip) { errors.push(skipError(b.key, skip)); return; }
    try { await b.warm(); } catch (e) { const nk = needsKeyOf(e); if (nk) noteKeylessSkip(b.key, nk); errors.push({ bridge: b.key, error: nk ? nk.message : (e.shortMessage ?? e.message).split("\n")[0], ...(nk && { needs_key: nk.needs_key, why: nk.why }) }); }
    timings[b.key] = Date.now() - t;
  });
  const { skipped, errors: failed } = split(errors);
  return { warmed: list.map((b) => b.key).filter((k) => !skipped.some((x) => x.bridge === k)), errors: failed, ...(skipped.length && { skipped }), ms: timings, total_ms: Date.now() - t0 };
}

export { checkWallet, warm, BRIDGE_KEYS, STUCK_STATUSES };
