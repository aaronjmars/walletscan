#!/usr/bin/env node
// stuck.mjs - find unclaimed bridge withdrawals (read-only, no wallet, no signing).
//
//   ALCHEMY_KEY=... node stuck.mjs check 0xADDR [0xADDR ...] [--file addrs.txt] [--json] [--all] [--min-usd N] [--bridges base,arbitrum]
//   ALCHEMY_KEY=... node stuck.mjs scan <bridge> (--days N | --from BLOCK --to BLOCK) [--min-age 7] [--min-usd N] [--json]
//
// Thin CLI over core.mjs (bridges, pricing, per-wallet check); index.mjs is the library entry.
// ALCHEMY_API_KEY works too; STUCK_CACHE_DIR moves the on-disk indexes (default .cache/ here).
// Statuses: claimable / ready-to-prove / ready-to-finalize = the owner can claim it now;
// blocked = stuck until the bridge team acts; waiting = still inside the bridge delay.

import { isAddress, getAddress } from "viem";
import { readFileSync } from "node:fs";
import { alchemyKey, DAY, now, pool, STUCK, SHOWN } from "./lib.mjs";
import { BRIDGES, enrich, runBridge, checkAddress, toJson, scanClient, blockAtAgo } from "./core.mjs";

// ---------- output ----------

const short = (a) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const fmtUsd = (n) => (n == null ? "$?" : `$${n.toLocaleString("en-US", { maximumFractionDigits: n < 10 ? 2 : 0 })}`);
const fmtAmt = (n) => n.toLocaleString("en-US", { maximumSignificantDigits: 6 });
const age = (t) => (t ? `${Math.floor((now() - t) / DAY)}d` : "?");

// --min-usd hides priced dust; unpriced items stay because their value is unknown, not small.
const minUsd = (opts) => (i) => !opts["min-usd"] || i.usd == null || i.usd >= Number(opts["min-usd"]);

function print(items, { showAll }) {
  const shown = items.filter((i) => showAll || SHOWN.has(i.status));
  if (!shown.length) { console.log("Nothing stuck found."); return; }
  shown.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  for (const i of shown) {
    console.log(`${i.status.padEnd(17)} ${i.bridge.padEnd(14)} ${`${fmtAmt(i.value)} ${i.symbol}`.padEnd(24)} ${fmtUsd(i.usd).padStart(10)}  age ${age(i.time).padStart(5)}  owner ${short(i.owner)}  tx ${i.tx}`);
    if (i.detail) console.log(`${" ".repeat(18)}${i.detail}`);
    if (STUCK.has(i.status)) console.log(`${" ".repeat(18)}-> ${i.action}`);
    if (i.status === "blocked") console.log(`${" ".repeat(18)}-> blocked by the bridge: contact the ${i.bridge} team with this tx`);
  }
  const sum = (st) => { const xs = shown.filter((i) => st(i.status)); return [xs.length, xs.reduce((s, i) => s + (i.usd ?? 0), 0)]; };
  const [n, usd] = sum((s) => STUCK.has(s));
  const [nb, usdb] = sum((s) => s === "blocked");
  console.log(`\n${n} claimable withdrawal(s), ~${fmtUsd(usd)}${nb ? `; ${nb} blocked until the bridge team acts, ~${fmtUsd(usdb)}` : ""} (USD estimates, unpriced tokens count as $0)`);
}


const jsonOut = (items) => JSON.stringify(toJson(items), null, 2);

// ---------- commands ----------

async function check(addresses, opts) {
  const bridges = opts.bridges ? opts.bridges.split(",").map((k) => BRIDGES[k] ?? die(`unknown bridge ${k}`)) : Object.values(BRIDGES).filter((b) => !b.scanOnly);
  if (!opts.json) console.error(`checking ${addresses.length} address(es) on ${bridges.length} bridges...`);
  // Two wallets at a time: rate-limited APIs (Iris, DLN stats, Wormholescan) stay under their caps.
  const all = (await pool(addresses, 2, (a) => checkAddress(getAddress(a), bridges))).flat();
  await enrich(all);
  const out = all.filter((i) => opts.all || (SHOWN.has(i.status) && minUsd(opts)(i)));
  if (opts.json) console.log(jsonOut(out));
  else print(out, { showAll: opts.all });
}

async function scan(key, opts) {
  const b = BRIDGES[key] ?? die(`unknown bridge ${key}`);
  if (!b.scan) die(`${key} only supports per-address checks`);
  const c = scanClient(b);
  let range;
  if (opts.from) range = [BigInt(opts.from), opts.to ? BigInt(opts.to) : await c.getBlockNumber()];
  else range = await blockAtAgo(c, Number(opts.days ?? 30) * DAY);
  console.error(`scanning ${b.name} blocks ${range[0]}..${range[1]}...`);
  const items = await runBridge(b, null, range);
  const minAge = Number(opts["min-age"] ?? 7) * DAY;
  const stuck = items.filter((i) => SHOWN.has(i.status) && (!i.time || now() - i.time >= minAge));
  await enrich(opts.all ? items : stuck);
  console.error(`${items.length} withdrawals checked`);
  const out = opts.all ? items : stuck.filter(minUsd(opts));
  if (opts.json) console.log(jsonOut(out));
  else print(out, { showAll: opts.all });
}

function die(m) { console.error(m); process.exit(1); }

function parseArgs(argv) {
  const pos = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { pos.push(a); continue; }
    const k = a.slice(2);
    if (["json", "all"].includes(k)) opts[k] = true;
    else opts[k] = argv[++i];
  }
  return { pos, opts };
}

const { pos: [cmd, ...rest], opts } = parseArgs(process.argv.slice(2));
if (!alchemyKey()) die("set ALCHEMY_KEY");
if (cmd === "check") {
  const addrs = [...rest, ...(opts.file ? readFileSync(opts.file, "utf8").split(/\s+/).filter(Boolean) : [])];
  const bad = addrs.filter((a) => !isAddress(a));
  if (!addrs.length || bad.length) die(`need EVM addresses${bad.length ? `, bad: ${bad.join(" ")}` : ""}`);
  await check(addrs, opts);
} else if (cmd === "scan") {
  await scan(rest[0], opts);
} else {
  die(`usage:
  node stuck.mjs check 0xADDR [...] [--file f] [--bridges ${Object.keys(BRIDGES).join(",")}] [--min-usd N] [--all] [--json]
  node stuck.mjs scan <${Object.values(BRIDGES).filter((b) => b.scan).map((b) => b.key).join("|")}> [--days 30 | --from N --to N] [--min-age 7] [--min-usd N] [--all] [--json]`);
}
