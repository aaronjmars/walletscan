// cli.test.mjs - the walletscan CLI offline: keys set / rm / list in temp XDG dirs (file mode 600, values never
// printed), env over the keys file, the report on a recorded scan, --json passthrough of an in-process scan, bad
// address exit 2. Upstreams are a stubbed fetch (no network)
import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const TMP = mkdtempSync(join(tmpdir(), "walletscan-test-"));
process.env.XDG_CONFIG_HOME = join(TMP, "config");
process.env.XDG_CACHE_HOME = join(TMP, "cache");
const real = globalThis.fetch;
globalThis.fetch = async (url, opts) => (String(url).startsWith("http://127.0.0.1") ? real(url, opts) : new Response("{}", { status: 404 }));
after(() => { globalThis.fetch = real; rmSync(TMP, { recursive: true, force: true }); });

const CLI = fileURLToPath(new URL("../cli.mjs", import.meta.url));
const { main, render, PROVIDERS, keysPath, loadKeys, zerionValue, scrub } = await import("../cli.mjs");
const ENV_NAMES = Object.values(PROVIDERS).flatMap((v) => [v.env, ...(v.alias ? [v.alias] : [])]);
beforeEach(() => { for (const n of ENV_NAMES) delete process.env[n]; rmSync(join(TMP, "config"), { recursive: true, force: true }); });

const sink = (tty = false) => ({ text: "", isTTY: tty, write(s, cb) { this.text += s; if (typeof cb === "function") cb(); return true; } });
async function run(argv, input = "") {
  const io = { stdout: sink(), stderr: sink(), stdin: Readable.from(input ? [input] : []) };
  const code = await main(argv, io);
  return { code, out: io.stdout.text, err: io.stderr.text };
}

const HELIUS = "0a1b2c3d-4e5f-6789-abcd-ef0123456789";
const ALCHEMY = "alch_TestKey_0123456789abcdef";

test("keys set stores the key in the XDG config dir, file 600, dir 700, never printed", async () => {
  const r = await run(["keys", "set", "helius"], `${HELIUS}\n`);
  assert.equal(r.code, 0, r.err);
  assert.equal(keysPath(), join(TMP, "config", "walletscan", "keys.json"));
  assert.deepEqual(JSON.parse(readFileSync(keysPath(), "utf8")), { helius: HELIUS });
  assert.equal(statSync(keysPath()).mode & 0o777, 0o600);
  assert.equal(statSync(join(TMP, "config", "walletscan")).mode & 0o777, 0o700);
  assert.ok(!r.out.includes(HELIUS) && !r.err.includes(HELIUS));
  assert.match(r.err, /saved the helius key/);
});

test("keys lists each provider, where it is set and what it unlocks, without values", async () => {
  await run(["keys", "set", "helius"], HELIUS);
  await run(["keys", "set", "alchemy"], ALCHEMY);
  for (const n of ENV_NAMES) delete process.env[n];
  const r = await run(["keys"]);
  assert.equal(r.code, 0);
  for (const p of Object.keys(PROVIDERS)) assert.match(r.out, new RegExp(`^  ${p} `, "m"));
  assert.match(r.out, /helius\s+set \(keys file\)\s+\d+ routes: Solana/);
  assert.match(r.out, /zerion\s+not set/);
  assert.match(r.out, /proxy\s+not set\s+\d+ routes through it/);
  assert.match(r.out, /^\d+\/\d+ routes live/);
  assert.ok(!r.out.includes(HELIUS) && !r.out.includes(ALCHEMY));
});

test("env vars win over the keys file", async () => {
  await run(["keys", "set", "helius"], HELIUS);
  process.env.HELIUS_API_KEY = "env-helius-key-0123456789";
  const r = await run(["keys"]);
  assert.match(r.out, /helius\s+set \(env HELIUS_API_KEY\)/);
  assert.equal(loadKeys().helius, "env");
  assert.equal(process.env.HELIUS_API_KEY, "env-helius-key-0123456789");
  delete process.env.HELIUS_API_KEY;
  assert.equal(loadKeys().helius, "config");
  assert.equal(process.env.HELIUS_API_KEY, HELIUS);
  // ALCHEMY_KEY is an alias of ALCHEMY_API_KEY
  process.env.ALCHEMY_KEY = ALCHEMY;
  assert.equal(loadKeys().alchemy, "env");
  assert.equal(process.env.ALCHEMY_API_KEY, ALCHEMY);
});

test("keys rm removes one key and keeps the rest", async () => {
  await run(["keys", "set", "helius"], HELIUS);
  await run(["keys", "set", "alchemy"], ALCHEMY);
  const r = await run(["keys", "rm", "helius"]);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(readFileSync(keysPath(), "utf8")), { alchemy: ALCHEMY });
  assert.equal(statSync(keysPath()).mode & 0o777, 0o600);
  assert.match((await run(["keys", "rm", "helius"])).err, /no helius key/);
});

test("zerion: the raw key is stored base64 of '<key>:' as the engine expects; an encoded one is kept", async () => {
  const raw = "zk_dev_0123456789abcdef";
  const r = await run(["keys", "set", "zerion"], raw);
  assert.equal(r.code, 0);
  const stored = JSON.parse(readFileSync(keysPath(), "utf8")).zerion;
  assert.equal(Buffer.from(stored, "base64").toString(), `${raw}:`);
  assert.equal(zerionValue(stored), stored);
  assert.ok(!r.err.includes(raw) && !r.err.includes(stored));
  process.env.ZERION_API_KEY = stored;
  assert.equal(scrub(`a ${raw} b ${stored}`), "a *** b ***");
});

test("keys set reads a hidden TTY prompt: no echo, backspace works, the value lands in the file only", async () => {
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, raw: [], setRawMode(on) { this.raw.push(on); } });
  const io = { stdout: sink(), stderr: sink(true), stdin };
  const done = main(["keys", "set", "alchemy"], io);
  setImmediate(() => stdin.write(`${ALCHEMY}x\x7f\r`));
  assert.equal(await done, 0);
  assert.deepEqual(stdin.raw, [true, false]);
  assert.match(io.stderr.text, /^alchemy key \(hidden\): \n/);
  assert.ok(!io.stderr.text.includes(ALCHEMY) && !io.stdout.text.includes(ALCHEMY));
  assert.equal(JSON.parse(readFileSync(keysPath(), "utf8")).alchemy, ALCHEMY);
});

test("keys set refuses a bad shape, an unknown provider or an empty input, and writes nothing", async () => {
  assert.equal((await run(["keys", "set", "helius"], "not a key")).code, 1);
  assert.equal((await run(["keys", "set", "proxy"], "ftp://x")).code, 1);
  assert.equal((await run(["keys", "set", "nope"], HELIUS)).code, 1);
  assert.equal((await run(["keys", "set", "helius"], "  \n")).code, 1);
  assert.throws(() => statSync(keysPath()));
  const r = await run(["keys", "set", "proxy"], "http://user:pass-0123456@127.0.0.1:8080");
  assert.equal(r.code, 0);
  assert.ok(!r.err.includes("pass-0123456"));
});

test("a keys file that is not JSON is an error, not a crash", async () => {
  mkdirSync(join(TMP, "config", "walletscan"), { recursive: true });
  writeFileSync(keysPath(), "{oops");
  const r = await run(["keys"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /not valid JSON/);
});

// a recorded scan.all answer (vitalik.eth, keyless, 2026-10-22), trimmed
const SCAN = JSON.parse(readFileSync(new URL("./fixtures/cli-scan-evm.json", import.meta.url), "utf8"));

test("report: totals per bucket, findings by USD with how to claim, holdings, failed and keyless-skipped sources", () => {
  const keyFor = (id) => (id.startsWith("sol.") ? "helius" : id === "bridge.stuck" || id === "airdrop.index" ? "alchemy" : id.includes("zerion") ? "zerion" : null);
  const text = render(SCAN, { keyFor });
  assert.ok(text.startsWith(`${SCAN.address} (evm)`));
  for (const w of ["you can claim", "team must release", "may not work"]) assert.match(text, new RegExp(`^  ${w} +\\$`, "m"));
  assert.match(text, /^  of which sure \$[\d,.]+( \(\$[\d,.]+ after fees\))?, likely \$[\d,.]+ \(check in the app first\)$/m);
  assert.ok(!text.includes("claimable now"));
  const shown = SCAN.findings.filter((f) => f.confidence !== "low" && (f.usd == null || f.usd >= 0));
  const usds = [...text.matchAll(/^ {2} *(\$[\d,.]+|unpriced) {2}\S/gm)].map((m) => m[1]);
  assert.equal(usds.length, shown.length);
  const nums = usds.filter((u) => u !== "unpriced").map((u) => Number(u.replace(/[$,]/g, "")));
  assert.deepEqual(nums, [...nums].sort((a, b) => b - a));
  for (const f of shown.filter((x) => x.how_to_claim)) assert.ok(text.includes(f.how_to_claim), f.how_to_claim);
  assert.match(text, /^Holdings: \$[\d,.]+ verified in \d+ rows?/m);
  assert.match(text, /needs the alchemy key \(walletscan keys set alchemy\): .*bridge\.stuck/);
  assert.match(text, /needs the zerion key/);
  if (SCAN.failed_sources.length) assert.match(text, /^Failed sources \(\d+, not checked\)/m);
  assert.ok(!text.includes("\x1b["), "no color unless asked");
  assert.ok(render(SCAN, { color: true }).includes("\x1b[32m"));
});

test("report: no sure money says so instead of a $0.00 line, and names the Zerion key when it is missing", () => {
  const t = { ...SCAN.totals, claimable_usd: 0, claimable_net_usd: 0, likely_usd: 16.13 };
  const text = render({ ...SCAN, totals: t, skipped_for_keys: [{ id: "holdings.zerion", key: "ZERION_API_KEY", why: "x" }] });
  assert.match(text, /^  none of it is sure yet: check each in the app first \(a Zerion key confirms more: walletscan keys set zerion\)$/m);
  assert.ok(!/sure \$0\.00/.test(text));
  assert.ok(!render({ ...SCAN, totals: t, skipped_for_keys: [] }).includes("Zerion key"));
  assert.ok(!/sure|none of it/.test(render({ ...SCAN, totals: { ...t, likely_usd: 0 } }).split("Findings")[0]));
});

test("report: --all shows low hints, --min-usd hides small rows, skipped_for_keys in any shape", () => {
  const f = (o) => ({ chain: "ethereum", asset: "ETH", amount: 1, action: "claim it", how_to_claim: "https://x.example/claim", deadline: null, source: "rewards.test", ...o });
  const data = { ...SCAN, findings: [f({ usd: 5, confidence: "high", bucket: "you_can_claim" }), f({ usd: 900, confidence: "low", bucket: "may_not_work", protocol: "LowHint" }), f({ usd: 50, confidence: "medium", bucket: "you_can_claim", protocol: "Mid" })], failed_sources: [], sources: {} };
  const def = render(data);
  assert.ok(!def.includes("LowHint"));
  assert.match(def, /1 low-confidence hint hidden \(--all shows them\)/);
  assert.ok(render(data, { all: true }).includes("LowHint"));
  const min = render(data, { minUsd: 10 });
  assert.match(min, /Findings \(1\)/);
  assert.ok(min.includes("Mid"));
  assert.match(render({ ...data, skipped_for_keys: [{ id: "sol.assets", key: "HELIUS_API_KEY" }] }), /needs the helius key \(walletscan keys set helius\): sol\.assets/);
  assert.match(render({ ...data, skipped_for_keys: { ALCHEMY_API_KEY: ["bridge.stuck"] } }), /needs the alchemy key.*bridge\.stuck/);
  assert.match(render({ ...data, skipped_for_keys: ["rewards.zerion"] }, { keyFor: () => "zerion" }), /needs the zerion key.*rewards\.zerion/);
  assert.ok(!render({ ...data, skipped_for_keys: [] }).includes("Skipped"));
  // parts of a source: one line per source, networks and bridge names merged
  const parts = render({ ...data, skipped_for_keys: ["arb", "base"].map((n) => ({ id: "rewards.llamapay", key: "ALCHEMY_API_KEY", why: `full-history event logs on ${n}-mainnet` })).concat([{ id: "bridge.stuck", key: "ALCHEMY_API_KEY", why: "zora: RPC on zora-mainnet" }, { id: "bridge.stuck", key: "ALCHEMY_API_KEY", why: "ink: RPC on ink-mainnet" }]) });
  assert.match(parts, /Skipped for a missing key \(2 sources, or parts of them\)/);
  assert.match(parts, /needs the alchemy key \(walletscan keys set alchemy\): rewards\.llamapay, bridge\.stuck\n/);
  assert.match(parts, /\n {4}rewards\.llamapay: full-history event logs on arb, base\n {4}bridge\.stuck: zora, ink\n/);
  assert.match(render({ ...data, totals: { ...data.totals, debt_usd: -9.34 } }), /, -\$9\.34 debt/);
});

test("report: several wallets name the address on each row", () => {
  const multi = { addresses: 2, scanned: 2, partial: false, totals: SCAN.totals, wallets: [{ address: SCAN.address, sources: { "rewards.zerion": "not configured" } }, { address: "0x1111111111111111111111111111111111111111", sources: {} }], findings: SCAN.findings.map((x) => ({ address: SCAN.address, ...x })), holdings: [], failed_sources: [{ address: "0x1111111111111111111111111111111111111111", id: "rewards.alpaca2", reason: "step evm.rpc failed (upstream 502)" }] };
  const text = render(multi, { keyFor: () => "zerion" });
  assert.match(text, /^Failed sources \(1, not checked\): rewards\.alpaca2 on 0x1111\.\.\.1111 \(step evm\.rpc failed/m);
  assert.match(text, /^2\/2 wallets scanned/);
  if (multi.findings.some((x) => x.confidence !== "low")) assert.match(text, /0xd8dA\.\.\.6045/);
  assert.match(text, /needs the zerion key.*rewards\.zerion/);
});

test("--json passes the in-process scan answer through on stdout, progress stays off it", async () => {
  const SOL = "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq";
  const r = await run(["--json", SOL]);
  assert.equal(r.code, 0, r.err);
  const d = JSON.parse(r.out);
  assert.equal(d.address, SOL);
  assert.equal(d.kind, "solana");
  assert.ok(d.totals && d.sources);
  assert.ok(d.skipped_for_keys.some((x) => x.key === "HELIUS_API_KEY")); // no Helius key: what it would add
  assert.match(r.err, /scanned .* in [\d.]+ s/);
  const h = await run([SOL, "--no-color", "--quiet"]);
  assert.equal(h.code, 0);
  assert.equal(h.err, "");
  assert.match(h.out, /needs the helius key \(walletscan keys set helius\)/);
});

test("a bad address exits 2 before any scan, a bad flag 1", async () => {
  const r = await run(["hello"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /neither EVM, Solana/);
  assert.equal((await run(["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", "nope"])).code, 2);
  assert.equal((await run(["--min-usd", "abc", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"])).code, 1);
  assert.equal((await run(["--bogus"])).code, 1);
  assert.equal((await run([])).code, 1);
});

test("the bin: --version, and exit 2 on a bad address from a real process", async () => {
  const exec = promisify(execFile);
  const v = await exec(process.execPath, [CLI, "--version"]);
  assert.equal(v.stdout.trim(), JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  await assert.rejects(exec(process.execPath, [CLI, "nothello"], { env: { ...process.env, XDG_CONFIG_HOME: join(TMP, "config") } }), (e) => e.code === 2);
});

// a fake terminal: each prompt (a stderr write ending in ": " or "] ") gets the next answer on stdin
function terminal(answers) {
  const stdin = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {} });
  const stderr = sink(true), write = stderr.write;
  stderr.write = function (s, cb) {
    const r = write.call(this, s, cb);
    if (/(: |\] )$/.test(String(s)) && answers.length) { const a = answers.shift(); setImmediate(() => stdin.write(a)); }
    return r;
  };
  return { stdout: sink(true), stderr, stdin };
}
async function withFetch(fn, body) {
  const was = globalThis.fetch;
  globalThis.fetch = fn;
  try { return await body(); } finally { globalThis.fetch = was; }
}

test("setup asks for Alchemy and Zerion only, checks a key live before saving it, skips on Enter, never prints a key", async () => {
  const io = terminal([`${ALCHEMY}\r`, "\r"]);
  const calls = [];
  const code = await withFetch(async (url) => { calls.push(String(url)); return new Response(JSON.stringify({ result: "0x10" }), { status: 200 }); }, () => main(["setup"], io));
  assert.equal(code, 0, io.stderr.text);
  assert.deepEqual(JSON.parse(readFileSync(keysPath(), "utf8")), { alchemy: ALCHEMY });
  assert.ok(calls.length && calls.every((u) => /\.g\.alchemy\.com\//.test(u)));
  for (const p of ["alchemy", "zerion"]) assert.match(io.stderr.text, new RegExp(`^${p}: .*\\n  get one: https://`, "m"));
  for (const p of ["helius", "etherscan"]) assert.ok(!new RegExp(`^${p}: `, "m").test(io.stderr.text));
  assert.match(io.stderr.text, /it works, saved/);
  assert.match(io.stderr.text, /Done: 1 of 2 keys set\. Optional extras: walletscan keys set helius, walletscan keys set etherscan/);
  assert.ok(!io.stderr.text.includes(ALCHEMY) && !io.stdout.text.includes(ALCHEMY));
});

test("setup asks again when the provider rejects a key, and a rejected key is never saved", async () => {
  const io = terminal([`${ALCHEMY}\r`, "\r", "\r"]);
  const code = await withFetch(async () => new Response("unauthorized", { status: 401 }), () => main(["setup"], io));
  assert.equal(code, 0);
  assert.match(io.stderr.text, /alchemy rejected this key: try again/);
  assert.throws(() => statSync(keysPath()));
});

test("setup without a terminal says how to pipe a key instead", async () => {
  const r = await run(["setup"]);
  assert.equal(r.code, 1);
  assert.match(r.err, /needs a terminal/);
});

test("the first scan in a terminal with no key offers the setup once; piped or --json never asks", async () => {
  const io = terminal(["n\r"]);
  assert.equal(await main(["hello"], io), 2);
  assert.match(io.stderr.text, /No API keys set\..*\nSet them up now\? \[y\/N\] /);
  assert.ok(JSON.parse(readFileSync(keysPath(), "utf8")).setup_offered);
  const again = terminal([]);
  assert.equal(await main(["hello"], again), 2);
  assert.ok(!again.stderr.text.includes("Set them up now"));
  rmSync(join(TMP, "config"), { recursive: true, force: true });
  const json = terminal([]);
  assert.equal(await main(["--json", "hello"], json), 2);
  assert.ok(!json.stderr.text.includes("Set them up now"));
  assert.ok(!(await run(["hello"])).err.includes("Set them up now"));
});

test("no address in a terminal asks for one", async () => {
  const io = terminal(["hello\r", "n\r"]);
  assert.equal(await main([], io), 2);
  assert.match(io.stderr.text, /^Wallet address\(es\) to scan/);
});

test("testKey: works, rejected, Alchemy app with Ethereum off, and unknown on a network error", async () => {
  const { testKey } = await import("../cli.mjs");
  const reply = (status, body) => async () => new Response(JSON.stringify(body), { status });
  assert.deepEqual(await withFetch(reply(200, { result: "0x10" }), () => testKey("alchemy", ALCHEMY)), { ok: true });
  assert.deepEqual(await withFetch(reply(401, {}), () => testKey("alchemy", ALCHEMY)), { ok: false });
  const off = await withFetch(async (url) => (/^https:\/\/base-/.test(String(url)) ? new Response(JSON.stringify({ result: "0x10" })) : new Response(JSON.stringify({ error: { message: "ETH_MAINNET is not enabled for this app" } }), { status: 403 })), () => testKey("alchemy", ALCHEMY));
  assert.equal(off.ok, true);
  assert.match(off.note, /^eth, arb, opt, polygon are off in this Alchemy app, .*every network/);
  const all = await withFetch(reply(403, { error: { message: "ETH_MAINNET is not enabled for this app" } }), () => testKey("alchemy", ALCHEMY));
  assert.match(all.note, /^every network checked is off in this Alchemy app, so the key adds nothing yet/);
  assert.deepEqual(await withFetch(reply(200, { status: "0", result: "Invalid API Key" }), () => testKey("etherscan", "A".repeat(34))), { ok: false });
  assert.deepEqual(await withFetch(async () => { throw new Error("offline"); }, () => testKey("zerion", "eGs6")), { ok: null });
});
