#!/usr/bin/env node
// cli.mjs - walletscan: the scans run locally, in-process (engine.mjs). No account needed: it runs
// keyless (every route that needs no key) and each provider key the user adds unlocks more sources.
//
//   walletscan <address...> [--json] [--min-usd N] [--all] [--no-color] [--quiet]
//   walletscan                          in a terminal: asks for the address(es)
//   walletscan setup                    walks through each provider key: what it unlocks, where to get one, a live check
//   walletscan keys                     which provider keys are set, from where, what each unlocks
//   walletscan keys set <provider>      hidden prompt, or the key on stdin; stored in ~/.config/walletscan/keys.json
//   walletscan keys rm <provider>
//   walletscan update                   rebuild the local indexes (~/.cache/walletscan)
//
// Keys: env vars win over the keys file (XDG_CONFIG_HOME respected); both land in the env names the engine reads
// before it is imported. Indexes: ~/.cache/walletscan/{stuck,airdrops,forgotteneth,chains} (XDG_CACHE_HOME
// respected) unless the *_CACHE_DIR env is set; a scan builds the ones it reads when missing or over a day old.
// The first scan in a terminal with no key set offers the setup once (never with --json or --quiet, never piped).
// Exit codes: 0 ok, 1 error, 2 bad address. Progress goes to stderr, results to stdout.
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;

// provider -> the env name the engine reads; shape = a light check of what the user pasted
export const PROVIDERS = {
  helius: { env: "HELIUS_API_KEY", shape: /^[A-Za-z0-9-]{16,80}$/, words: "Solana: Helius holdings and prices, Serum rent, faster scans (keyless uses the throttled public RPC)" },
  alchemy: { env: "ALCHEMY_API_KEY", alias: "ALCHEMY_KEY", shape: /^[A-Za-z0-9_-]{16,80}$/, words: "EVM: full history on every network (keyless: Ethereum, Avalanche, Mantle, Blast) for stuck bridges, airdrops, old smart wallets; tokens on 34 networks" },
  zerion: { env: "ZERION_API_KEY", shape: /^[A-Za-z0-9_+/=:-]{8,200}$/, words: "EVM: portfolio, DeFi positions and rewards on every chain Zerion covers" },
  etherscan: { env: "ETHERSCAN_API_KEY", shape: /^[A-Za-z0-9]{16,64}$/, words: "more tokens on small chains in holdings.chains (Etherscan v2)" },
  proxy: { env: "PROXY_URL", words: "routes whose upstream blocks some regions (Reya, Babylon) go through your proxy" },
};
// where to get each key (all have a free plan)
const SIGNUP = {
  helius: "https://dashboard.helius.dev (free plan)",
  alchemy: "https://dashboard.alchemy.com (free plan; in the app, turn on every network, not only Ethereum)",
  zerion: "https://dashboard.zerion.io (free Developer plan)",
  etherscan: "https://etherscan.io/myapikey (free)",
};
// the keys walletscan setup asks for: the two that find much more. Helius (Solana runs about the same on the public
// RPC) and Etherscan (a few more small-chain tokens) stay optional: walletscan keys set <provider>
const ASKED = ["alchemy", "zerion"];
const PROVIDER_OF = Object.fromEntries(Object.entries(PROVIDERS).map(([p, v]) => [v.env, p]));
const INDEX_DIRS = { stuck: "STUCK_CACHE_DIR", airdrops: "AIRDROP_CACHE_DIR", forgotteneth: "OLDETH_CACHE_DIR", chains: "CHAINS_CACHE_DIR" };

export const configDir = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "walletscan");
export const keysPath = () => join(configDir(), "keys.json");
export const cacheRoot = () => join(process.env.XDG_CACHE_HOME || join(homedir(), ".cache"), "walletscan");

// ---- keys file -------------------------------------------------------------------------------------------------
function readKeys() {
  let text;
  try { text = readFileSync(keysPath(), "utf8"); } catch (e) { if (e.code === "ENOENT") return {}; throw e; }
  try { const o = JSON.parse(text); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch { throw new Error(`${keysPath()} is not valid JSON: fix or delete it`); }
}
function writeKeys(keys) {
  const dir = configDir(), file = keysPath(), tmp = `${file}.${process.pid}.tmp`;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  writeFileSync(tmp, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}
// env first, then the keys file, into the env names the engine reads -> { provider: "env" | "config" | null }
export function loadKeys() {
  const file = readKeys(), from = {};
  for (const [p, v] of Object.entries(PROVIDERS)) {
    if (!process.env[v.env] && v.alias && process.env[v.alias]) process.env[v.env] = process.env[v.alias];
    if (process.env[v.env]) from[p] = "env";
    else if (typeof file[p] === "string" && file[p]) { process.env[v.env] = file[p]; from[p] = "config"; }
    else from[p] = null;
  }
  return from;
}
// Zerion's API takes Basic auth: the engine reads ZERION_API_KEY as base64 of "<key>:". A pasted raw key is
// encoded; one already encoded that way is kept
export function zerionValue(raw) {
  const dec = Buffer.from(raw, "base64").toString("utf8");
  if (!raw.startsWith("zk_") && dec.endsWith(":") && Buffer.from(dec).toString("base64") === raw) return raw;
  return Buffer.from(`${raw}:`).toString("base64");
}
function checkValue(p, v) {
  if (p === "proxy") {
    let u;
    try { u = new URL(v); } catch { return "not a URL: expected http://user:pass@host:port"; }
    return /^https?:$/.test(u.protocol) && u.hostname ? null : "expected http://user:pass@host:port";
  }
  return PROVIDERS[p].shape.test(v) ? null : `does not look like a ${p} key (letters, digits and dashes, no spaces)`;
}
// every key value this process knows, longest first, to blank out of anything printed
function secrets() {
  const names = Object.values(PROVIDERS).flatMap((v) => [v.env, ...(v.alias ? [v.alias] : []), ...Array.from({ length: 8 }, (_, i) => `${v.env}_${i + 2}`)]);
  const vals = names.map((n) => process.env[n]).filter((x) => x && x.length >= 6);
  for (const v of [...vals]) { try { const u = new URL(v); if (u.password) vals.push(decodeURIComponent(u.password)); } catch {} }
  for (const v of [...vals]) { const d = Buffer.from(v, "base64").toString("utf8"); if (d.endsWith(":") && d.length > 7) vals.push(d.slice(0, -1)); }
  return [...new Set(vals)].sort((a, b) => b.length - a.length);
}
export const scrub = (text) => secrets().reduce((t, k) => t.split(k).join("***"), String(text));

// ---- reading a key ---------------------------------------------------------------------------------------------
function readHidden(prompt, stdin, stderr) {
  return new Promise((resolve, reject) => {
    let v = "";
    const done = (err) => { stdin.setRawMode(false); stdin.pause(); stdin.off("data", on); stderr.write("\n"); err ? reject(err) : resolve(v); };
    const on = (s) => {
      for (const ch of String(s)) {
        if (ch === "\r" || ch === "\n") return done();
        if (ch === "\u0003" || ch === "\u0004") return done(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") v = v.slice(0, -1);
        else if (ch >= " ") v += ch;
      }
    };
    stderr.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.on("data", on);
    stdin.resume();
  });
}
// one visible line (the terminal echoes it)
function readLine(prompt, stdin, stderr) {
  return new Promise((resolve) => {
    let v = "";
    const stop = () => { stdin.off("data", on); stdin.off("end", end); stdin.pause(); };
    const on = (s) => { v += String(s); const i = v.search(/[\r\n]/); if (i >= 0) { stop(); resolve(v.slice(0, i).trim()); } };
    const end = () => { stop(); resolve(v.trim()); };
    stderr.write(prompt);
    stdin.setEncoding?.("utf8");
    stdin.on("data", on);
    stdin.once("end", end);
    stdin.resume();
  });
}
async function readAll(stdin) {
  let s = "";
  for await (const c of stdin) s += c;
  return s;
}

// one cheap call with the key -> { ok: true | false (the provider rejects it) | null (could not tell), note? }
export async function testKey(p, v) {
  const signal = AbortSignal.timeout(10000);
  const rpc = (url, method) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: [] }), signal });
  const denied = (r) => r.status === 401 || r.status === 403;
  try {
    if (p === "helius") { const r = await rpc(`https://mainnet.helius-rpc.com/?api-key=${v}`, "getHealth"); return { ok: denied(r) ? false : r.ok ? true : null }; }
    if (p === "alchemy") {
      // an app answers 403 "ETH_MAINNET is not enabled for this app" for each network turned off in it
      const nets = ["eth-mainnet", "base-mainnet", "arb-mainnet", "opt-mainnet", "polygon-mainnet"];
      const got = await Promise.all(nets.map(async (n) => {
        const r = await rpc(`https://${n}.g.alchemy.com/v2/${v}`, "eth_blockNumber");
        const j = await r.json().catch(() => ({}));
        return j.result ? "on" : /not enabled/i.test(j.error?.message || "") ? "off" : denied(r) ? "denied" : "unknown";
      }));
      if (got.every((x) => x === "denied")) return { ok: false };
      const off = nets.filter((_, i) => got[i] === "off").map((n) => n.replace("-mainnet", ""));
      if (!got.some((x) => x === "on" || x === "off")) return { ok: null };
      const fix = "turn on every network (dashboard.alchemy.com, your app, Networks)";
      if (off.length === nets.length) return { ok: true, note: `every network checked is off in this Alchemy app, so the key adds nothing yet (scans use the keyless path): ${fix}` };
      return { ok: true, ...(off.length && { note: `${off.join(", ")} ${off.length === 1 ? "is" : "are"} off in this Alchemy app, so scans take the slower keyless path there: ${fix}` }) };
    }
    if (p === "zerion") { const r = await fetch("https://api.zerion.io/v1/chains/ethereum", { headers: { authorization: `Basic ${v}`, accept: "application/json" }, signal }); return { ok: denied(r) ? false : r.ok ? true : null }; }
    if (p === "etherscan") {
      const j = await (await fetch(`https://api.etherscan.io/v2/api?chainid=1&module=proxy&action=eth_blockNumber&apikey=${v}`, { signal })).json();
      return { ok: /^0x/.test(String(j.result)) ? true : /invalid api key/i.test(String(j.result)) ? false : null };
    }
  } catch {}
  return { ok: null };
}

// ---- output ----------------------------------------------------------------------------------------------------
const paint = (on) => {
  const c = (code) => (s) => (on ? `\x1b[${code}m${s}\x1b[0m` : String(s));
  return { bold: c(1), dim: c(2), green: c(32), yellow: c(33), red: c(31), cyan: c(36) };
};
const usd = (n) => (n == null ? "unpriced" : `${n < 0 ? "-" : ""}$${Math.abs(Number(n)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const qty = (n) => (n == null ? "" : Number(n).toLocaleString("en-US", { maximumFractionDigits: Math.abs(n) >= 1 ? 4 : 8 }));
const short = (a) => (a && a.length > 16 ? `${a.slice(0, 6)}...${a.slice(-4)}` : a);
const BUCKET_WORDS = { you_can_claim: "you can claim", team_must_release: "team must release", may_not_work: "may not work" };

// scan.wallets / scan.all source maps -> ids of the sources skipped as "not configured"
function notConfigured(data) {
  const maps = Array.isArray(data.wallets) ? data.wallets.map((w) => w.sources || {}) : [data.sources || {}];
  return [...new Set(maps.flatMap((m) => Object.entries(m).filter(([, v]) => v === "not configured").map(([id]) => id)))];
}
// skipped_for_keys in any shape a scan may give (list of ids, of { id, key, why }, or a map either way)
// -> { key: Map(id -> Set(why)) } (a why = a part of a source that ran is skipped, not the whole source)
function keyGroups(skipped, keyFor) {
  const groups = {};
  const add = (id, key, why) => {
    for (const k of [key ?? keyFor(id)].flat()) {
      const m = (groups[k || "unavailable"] ||= new Map());
      if (!m.has(id)) m.set(id, new Set());
      if (why) m.get(id).add(why);
    }
  };
  if (Array.isArray(skipped)) {
    for (const x of skipped) {
      if (typeof x === "string") add(x);
      else if (x && typeof x === "object") add(x.id || x.source || x.route || "?", x.key || x.keys || x.env || x.needs || x.provider, x.why);
    }
  } else if (skipped && typeof skipped === "object") {
    for (const [k, v] of Object.entries(skipped)) {
      if (Array.isArray(v)) for (const id of v) add(typeof id === "string" ? id : id?.id || "?", k);
      else add(k, typeof v === "string" ? v : v?.key || v?.env);
    }
  }
  return Object.fromEntries(Object.entries(groups).map(([k, m]) => [PROVIDER_OF[k] || k.replace(/_API_KEY$/, "").toLowerCase(), m]));
}
// whys of one source -> one line: "X on arb-mainnet", "X on base-mainnet" -> "X on arb, base"; parts named
// "part: why" (bridge.stuck's bridges) -> just their names (--json has each why)
function whyLine(whys) {
  const by = new Map(), parts = new Set();
  for (const w of whys) {
    const part = /^([a-z0-9]+): /.exec(w)?.[1];
    if (part) { parts.add(part); continue; }
    const [, what, net] = /^(.*) on ([a-z0-9]+)-mainnet$/.exec(w) || [];
    if (what) (by.get(what) || by.set(what, []).get(what)).push(net);
    else by.set(w, null);
  }
  return [...(parts.size ? [[...parts].join(", ")] : []), ...[...by].map(([what, nets]) => (nets ? `${what} on ${nets.join(", ")}` : what))].join("; ");
}

// a scan.all or scan.wallets answer -> the human report
export function render(data, { minUsd = 0, all = false, color = false, keyFor = () => null } = {}) {
  const c = paint(color), out = [], t = data.totals || {}, multi = Array.isArray(data.wallets);
  out.push(c.bold(multi ? `${data.scanned}/${data.addresses} wallets scanned` : `${data.address} (${data.kind})`));
  if (data.warning) out.push(c.yellow(`partial: ${data.warning}`));
  out.push("", c.bold("Money found"));
  const tone = { you_can_claim: c.green, team_must_release: c.yellow, may_not_work: c.dim };
  for (const [b, words] of Object.entries(BUCKET_WORDS)) {
    const x = t.by_bucket?.[b] || { findings: 0, usd: 0, unpriced: 0 };
    out.push(`  ${words.padEnd(18)} ${tone[b](usd(x.usd).padStart(14))}  ${x.findings} finding${x.findings === 1 ? "" : "s"}${x.unpriced ? `, ${x.unpriced} unpriced` : ""}`);
  }
  // the money above split by confidence: high = sure, medium = likely (worth a look in the app before paying gas)
  const sure = t.claimable_usd || 0, likely = t.likely_usd || 0;
  const zerionOff = /ZERION|"zerion"/.test(JSON.stringify(data.skipped_for_keys || [])); // any shape (see keyGroups)
  if (sure > 0) out.push(`  of which sure ${usd(sure)}${t.claimable_net_usd != null && t.claimable_net_usd !== sure ? ` (${usd(t.claimable_net_usd)} after fees)` : ""}${likely > 0 ? `, likely ${usd(likely)} (check in the app first)` : ""}`);
  else if (likely > 0) out.push(`  none of it is sure yet: check each in the app first${zerionOff ? " (a Zerion key confirms more: walletscan keys set zerion)" : ""}`);

  const rows = (data.findings || []).filter((f) => (all || f.confidence !== "low") && (f.usd == null || f.usd >= minUsd || f.deadline));
  rows.sort((a, b) => (b.usd ?? -1) - (a.usd ?? -1));
  const hiddenLow = (data.findings || []).filter((f) => !all && f.confidence === "low").length;
  out.push("", c.bold(`Findings (${rows.length})`));
  if (!rows.length) out.push(c.dim("  nothing found"));
  for (const f of rows) {
    const what = [f.protocol || (/^holdings\./.test(f.source || "") ? null : f.source), f.chain, [qty(f.amount), f.asset].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    out.push(`  ${tone[f.bucket]?.(usd(f.usd).padStart(14)) ?? usd(f.usd).padStart(14)}  ${what}  ${c.dim(`[${f.confidence}${f.bucket ? `, ${BUCKET_WORDS[f.bucket] || f.bucket}` : ""}]`)}${multi && f.address ? c.dim(`  ${short(f.address)}`) : ""}`);
    if (f.action) out.push(`  ${" ".repeat(14)}  ${f.action}`);
    if (f.how_to_claim) out.push(`  ${" ".repeat(14)}  ${c.cyan(f.how_to_claim)}`);
    if (f.deadline) out.push(`  ${" ".repeat(14)}  ${c.yellow(`deadline ${f.deadline}`)}`);
  }
  const hidden = [hiddenLow && `${hiddenLow} low-confidence hint${hiddenLow === 1 ? "" : "s"} hidden (--all shows them)`, data.hidden_below_min_usd && `${data.hidden_below_min_usd} below the minimum hidden`].filter(Boolean);
  if (hidden.length) out.push(c.dim(`  ${hidden.join("; ")}`));

  const h = data.holdings || [];
  out.push("", `${c.bold("Holdings")}: ${usd(t.holdings_usd)} verified in ${h.filter((x) => x.verified).length} row${h.filter((x) => x.verified).length === 1 ? "" : "s"}${t.unverified_holdings_usd ? `, ${usd(t.unverified_holdings_usd)} unverified` : ""}${t.locked_usd ? `, ${usd(t.locked_usd)} locked` : ""}${t.debt_usd ? `, ${usd(t.debt_usd)} debt` : ""}${data.spam_hidden ? `, ${data.spam_hidden} spam hidden` : ""}`);

  const permissions = data.security?.approvals || [];
  if (permissions.length) {
    out.push("", c.bold(`Active token approvals (${permissions.length})`));
    for (const a of permissions.slice(0, 10)) out.push(`  ${a.chain}: ${a.symbol || short(a.token)} -> ${short(a.spender)} (${a.type}${a.unlimited ? ", unlimited" : ""})`, `    ${a.how_to_revoke}`);
    if (permissions.length > 10) out.push(c.dim(`  ${permissions.length - 10} more in --json`));
    out.push(c.dim("  Permissions are separate from money found; an approval alone does not mean the spender is malicious."));
  }
  if (data.security?.note) out.push(c.dim(data.security.note));
  const securityCoverage = data.security?.coverage || {};
  const uncheckedSecurity = [...Object.entries(securityCoverage), ...(data.security?.wallets || []).flatMap((w) => Object.entries(w.coverage || {}).map(([chain, c]) => [`${chain} on ${short(w.address)}`, c]))].filter(([, c]) => c.status !== "complete");
  if (uncheckedSecurity.length) out.push(c.dim(`Approval checks incomplete: ${uncheckedSecurity.map(([chain, c]) => `${chain} (${c.reason || c.status})`).join(", ")}`));
  const truncated = data.truncated_sources || [];
  if (truncated.length) out.push(c.yellow(`Stopped early (${truncated.length} sources): ${truncated.map((x) => `${x.id}${multi && x.address ? ` on ${short(x.address)}` : ""} (${x.reason || "time or page budget"})`).join(", ")}`));
  const risk = data.rugcheck;
  if (risk?.unchecked) out.push(c.dim(`Rugcheck: ${risk.checked}/${risk.candidates} uncertain tokens checked; ${risk.unchecked} unchecked.`));
  const quotes = data.market_quotes;
  if (quotes?.unchecked) out.push(c.dim(`Market price fallback: ${quotes.checked}/${quotes.candidates} tokens checked; ${quotes.unchecked} unchecked.`));

  const failed = data.failed_sources || [];
  if (failed.length) out.push(c.red(`Failed sources (${failed.length}, not checked): ${failed.map((f) => `${f.id}${multi && f.address ? ` on ${short(f.address)}` : ""} (${String(f.reason || "").slice(0, 60)})`).join(", ")}`));
  const groups = keyGroups(data.skipped_for_keys ?? notConfigured(data), keyFor);
  const n = Object.values(groups).reduce((s, x) => s + x.size, 0);
  if (n) {
    out.push(c.dim(`Skipped for a missing key (${n} source${n === 1 ? "" : "s"}, or parts of them):`));
    for (const [p, ids] of Object.entries(groups)) {
      out.push(c.dim(`  ${PROVIDERS[p] ? `needs the ${p} key (walletscan keys set ${p})` : p === "unavailable" ? "unavailable" : `needs ${p}`}: ${[...ids.keys()].join(", ")}`));
      for (const [id, whys] of ids) if (whys.size) out.push(c.dim(`    ${id}: ${whyLine(whys)}`));
    }
  }
  return `${out.join("\n")}\n`;
}

// ---- commands --------------------------------------------------------------------------------------------------
const HELP = `walletscan ${VERSION} - find the money a wallet forgot (rent, rewards, stuck bridges, airdrops, unredeemed bets)

Usage
  walletscan <address...>          scan one or more wallets (EVM, Solana, Bitcoin, TRON, NEAR, Sui, Polkadot, TON)
  walletscan                       in a terminal: asks for the address(es) to scan
  walletscan setup                 add provider keys step by step (what each unlocks, where to get a free one)
  walletscan keys                  provider keys: set or not, from where, what each unlocks
  walletscan keys set <provider>   store a key (hidden prompt, or pipe it on stdin): ${Object.keys(PROVIDERS).join(", ")}
  walletscan keys rm <provider>    remove a stored key
  walletscan update                rebuild the local indexes

Options
  --json         the raw scan JSON on stdout
  --min-usd N    hide findings worth less than N USD (default 1)
  --all          include low-confidence hints
  --no-color     plain text (NO_COLOR works too)
  --quiet        no progress on stderr
  -h, --help     this help
  -v, --version  the version

Read-only: nothing signs, sends or connects a wallet. Keys: env vars (HELIUS_API_KEY, ALCHEMY_API_KEY,
ZERION_API_KEY, ETHERSCAN_API_KEY, PROXY_URL) win over ${keysPath()}.
Indexes: ${cacheRoot()}.
Exit codes: 0 ok, 1 error, 2 bad address.
`;

// the env the engine reads, set before it is imported: keys, index dirs, CLI-sized scan.wallets limits
function prepareEnv() {
  const from = loadKeys();
  for (const [name, env] of Object.entries(INDEX_DIRS)) process.env[env] ||= join(cacheRoot(), name);
  process.env.WALLETS_MAX ||= "50";
  process.env.WALLETS_BUDGET_S ||= "1800";
  return from;
}

// routes live now / with the provider's key set: the count a key unlocks
async function unlockCounts() {
  const { REGISTRY, routeLive } = await import("./registry.mjs");
  const count = () => REGISTRY.filter(routeLive).length, out = {};
  for (const [p, v] of Object.entries(PROVIDERS)) {
    if (p === "proxy") { out[p] = REGISTRY.filter((e) => e.proxy).length; continue; }
    const was = process.env[v.env];
    process.env[v.env] = "x"; const on = count();
    delete process.env[v.env]; const off = count();
    if (was !== undefined) process.env[v.env] = was;
    out[p] = on - off;
  }
  return { out, live: count(), total: REGISTRY.length };
}

async function keysCmd(args, io) {
  const [sub, p] = args;
  if (!sub || sub === "list") {
    const from = loadKeys(), { out, live, total } = await unlockCounts();
    const lines = Object.entries(PROVIDERS).map(([name, v]) => {
      const st = from[name] === "env" ? `set (env ${v.env})` : from[name] === "config" ? "set (keys file)" : "not set";
      const routes = name === "proxy" ? `${out[name]} routes through it` : name === "etherscan" ? "extra" : `${out[name]} route${out[name] === 1 ? "" : "s"}`;
      return `  ${name.padEnd(10)} ${st.padEnd(28)} ${routes}: ${v.words}${ASKED.includes(name) ? "" : " (optional)"}`;
    });
    io.stdout.write(`${[`${live}/${total} routes live with these keys`, ...lines, "", `keys file: ${keysPath()} (env vars win over it)`, "set one:   walletscan keys set <provider>"].join("\n")}\n`);
    return 0;
  }
  if (sub !== "set" && sub !== "rm") { io.stderr.write(`unknown keys command: ${sub} (keys, keys set <provider>, keys rm <provider>)\n`); return 1; }
  if (!PROVIDERS[p]) { io.stderr.write(`${p ? `unknown provider: ${p}` : "missing provider"} (one of: ${Object.keys(PROVIDERS).join(", ")})\n`); return 1; }
  const keys = readKeys();
  if (sub === "rm") {
    if (!(p in keys)) { io.stderr.write(`no ${p} key in ${keysPath()}\n`); return 0; }
    delete keys[p];
    writeKeys(keys);
    io.stderr.write(`removed the ${p} key from ${keysPath()}\n`);
    return 0;
  }
  const stdin = io.stdin;
  let raw;
  try { raw = stdin.isTTY ? await readHidden(`${p} ${p === "proxy" ? "URL" : "key"} (hidden): `, stdin, io.stderr) : await readAll(stdin); } catch (e) { io.stderr.write(`${e.message}\n`); return 1; }
  raw = String(raw).trim();
  if (!raw) { io.stderr.write("nothing entered: no key saved\n"); return 1; }
  const bad = checkValue(p, raw);
  if (bad) { io.stderr.write(`${p}: ${bad}; no key saved\n`); return 1; }
  keys[p] = p === "zerion" ? zerionValue(raw) : raw;
  writeKeys(keys);
  io.stderr.write(`saved the ${p} key to ${keysPath()} (mode 600)\n`);
  const v = PROVIDERS[p];
  if (process.env[v.env] || (v.alias && process.env[v.alias])) io.stderr.write(`note: ${process.env[v.env] ? v.env : v.alias} is set in your env and wins over the file\n`);
  return 0;
}

// walletscan setup: each provider in turn, what it unlocks, where to get a free key, a hidden prompt (Enter skips),
// a live check before saving
async function setupCmd(io) {
  const { stdin, stderr } = io;
  if (!stdin.isTTY) { stderr.write("walletscan setup needs a terminal: pipe a key to walletscan keys set <provider> instead\n"); return 1; }
  const from = loadKeys(), keys = readKeys();
  stderr.write(`Keys are optional: every scan runs without them, and each free key finds more.\nPaste a key, or press Enter to skip. They are saved in ${keysPath()}, readable only by you.\n\n`);
  let set = 0;
  try {
    for (const p of ASKED) {
      const v = PROVIDERS[p];
      stderr.write(`${p}: ${v.words}\n  get one: ${SIGNUP[p]}\n`);
      if (from[p] === "env") { stderr.write(`  set in your env (${v.env}): kept\n\n`); set++; continue; }
      for (let tries = 0; tries < 3; tries++) {
        const raw = String(await readHidden(`  ${p} key (hidden; Enter ${from[p] ? "keeps the saved one" : "skips"}): `, stdin, stderr)).trim();
        if (!raw) { stderr.write(from[p] ? "  kept\n" : "  skipped\n"); if (from[p]) set++; break; }
        const bad = checkValue(p, raw);
        if (bad) { stderr.write(`  ${bad}: try again\n`); continue; }
        const val = p === "zerion" ? zerionValue(raw) : raw;
        stderr.write("  checking it... ");
        const t = await testKey(p, val);
        if (t.ok === false) { stderr.write(`${p} rejected this key: try again\n`); continue; }
        keys[p] = val;
        writeKeys(keys);
        process.env[v.env] = val;
        set++;
        stderr.write(`${t.ok ? "it works" : "could not check it now"}, saved\n${t.note ? `  note: ${t.note}\n` : ""}`);
        break;
      }
      stderr.write("\n");
    }
  } catch (e) { stderr.write(`\n${e.message}: keys saved so far are kept\n`); return 1; }
  stderr.write(`Done: ${set} of ${ASKED.length} keys set. Optional extras: ${Object.keys(SIGNUP).filter((p) => !ASKED.includes(p)).map((p) => `walletscan keys set ${p}`).join(", ")}. walletscan keys lists them all.\n`);
  return 0;
}

// first scan in a terminal with no key anywhere: offer the setup once (the answer is remembered in the keys file)
async function offerSetup(opts, io) {
  if (opts.json || opts.quiet || !io.stdin.isTTY || !io.stderr.isTTY) return;
  const keys = readKeys();
  if (keys.setup_offered || Object.values(PROVIDERS).some((v) => process.env[v.env] || (v.alias && process.env[v.alias])) || Object.keys(PROVIDERS).some((p) => keys[p])) return;
  writeKeys({ ...keys, setup_offered: new Date().toISOString().slice(0, 10) });
  const a = await readLine("No API keys set. Scans work without them; two free keys find more (stuck bridges on every chain, DeFi positions).\nSet them up now? [y/N] ", io.stdin, io.stderr);
  if (/^y/i.test(a)) { await setupCmd(io); io.stderr.write("\n"); }
}

const secs = (ms) => `${Math.round(ms / 100) / 10} s`;

// build the indexes in `list` (engine INDEXES rows) at once; one stderr line each
async function warmIndexes(list, { force = false, log }) {
  return Promise.all(list.map(async (ix) => {
    const dir = await ix.dir();
    if (!force && !ix.stale(dir)) return { name: ix.name, kept: true };
    log(`${ix.name}: ${force ? "updating" : "building"} the ${ix.about} in ${dir} (${ix.cold} the first time)...`);
    const t0 = Date.now();
    try {
      const w = await ix.warm();
      log(`${ix.name}: ready in ${secs(Date.now() - t0)}${w.errors?.length ? `, ${w.errors.length} part${w.errors.length === 1 ? "" : "s"} failed: ${scrub(w.errors.join("; ")).slice(0, 200)}` : ""}`);
      return { name: ix.name, ms: Date.now() - t0, errors: w.errors || [] };
    } catch (e) {
      log(`${ix.name}: failed: ${scrub(e?.error || e?.message || e).slice(0, 200)}`);
      return { name: ix.name, failed: true };
    }
  }));
}

async function updateCmd(io) {
  prepareEnv();
  const E = await import("./engine.mjs");
  const rows = E.indexesFor(["evm"]), keyFor = keyNamer(E);
  for (const ix of rows.filter((x) => !x.live)) {
    const k = keyFor(ix.route);
    io.stderr.write(`${ix.name}: skipped, ${ix.route} ${typeof k === "string" && PROVIDERS[k] ? `needs the ${k} key (walletscan keys set ${k})` : "is not configured"}\n`);
  }
  const res = await warmIndexes(rows.filter((x) => x.live), { force: true, log: (m) => io.stderr.write(`${m}\n`) });
  return res.some((r) => r.failed) ? 1 : 0;
}

// route id -> the provider (or env name) whose key would make it live
function keyNamer(E) {
  const seen = new Map();
  const need = (id, depth = 0) => {
    const e = E.REG_BY_ID.get(id);
    if (!e || depth > 4) return [];
    if (e.auth && !process.env[e.auth]) return [e.auth];
    return [...(e.uses || []), ...(e.usesAny || [])].flatMap((x) => need(x, depth + 1));
  };
  return (id) => {
    if (!seen.has(id)) { const ks = [...new Set(need(id))]; seen.set(id, ks.length ? ks.map((k) => PROVIDER_OF[k] || k) : null); }
    const k = seen.get(id);
    return k && k.length === 1 ? k[0] : k;
  };
}

async function scanCmd(addresses, opts, io) {
  const log = opts.quiet ? () => {} : (m) => io.stderr.write(`${m}\n`);
  const minUsd = opts["min-usd"] == null ? null : Number(opts["min-usd"]);
  if (minUsd != null && !(minUsd >= 0)) { io.stderr.write(`--min-usd takes a number of USD, got ${opts["min-usd"]}\n`); return 1; }
  await offerSetup(opts, io);
  prepareEnv();
  const [E, { walletList }, { addressKind }] = await Promise.all([import("./engine.mjs"), import("./compose.mjs"), import("./nonevm/address.mjs")]);
  let list;
  try { list = walletList(addresses); } catch (e) {
    io.stderr.write(`${e.error || e.message}${e.detail ? `: ${typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail)}` : ""}\n`);
    return e.status === 400 ? 2 : 1;
  }
  const kinds = list.map((a) => addressKind(a)?.kind);
  await warmIndexes(E.indexesFor(kinds).filter((x) => x.live), { log });

  const t0 = Date.now(), multi = list.length > 1;
  const what = multi ? `${list.length} wallets` : `${list[0]} (${kinds[0]})`;
  let tick = null;
  if (!opts.quiet && io.stderr.isTTY) {
    // \x1b[K clears the rest of the line: the counter and the index messages sources print share stderr
    tick = setInterval(() => io.stderr.write(`\r\x1b[Kscanning ${what}... ${Math.round((Date.now() - t0) / 1000)} s`), 1000);
    tick.unref();
    const err = console.error;
    console.error = (...a) => { io.stderr.write("\r\x1b[K"); err(...a); };
    tick.restore = () => { console.error = err; };
  } else log(`scanning ${what}...`);
  const params = { ...(minUsd != null && { min_usd: minUsd }), ...(multi ? { addresses: list } : { address: list[0] }) };
  let out;
  try {
    out = await E.callRoute(E.REG_BY_ID.get(multi ? "scan.wallets" : "scan.all"), params);
  } catch (e) {
    if (tick) { clearInterval(tick); tick.restore(); io.stderr.write("\r\x1b[K"); }
    io.stderr.write(`${scrub(e?.error || e?.message || e)}${e?.detail ? `: ${scrub(typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail))}` : ""}\n`);
    return e?.status === 400 ? 2 : 1;
  }
  if (tick) { clearInterval(tick); tick.restore(); io.stderr.write("\r\x1b[K"); }
  log(`scanned ${what} in ${secs(Date.now() - t0)}`);
  if (!out.ok) { io.stderr.write(`scan failed (${out.status}): ${scrub(out.data?.error || JSON.stringify(out.data)).slice(0, 400)}\n`); return 1; }
  if (opts.json) { io.stdout.write(`${scrub(JSON.stringify(out.data, null, 2))}\n`); return 0; }
  const color = !opts["no-color"] && !process.env.NO_COLOR && !!io.stdout.isTTY;
  io.stdout.write(scrub(render(out.data, { minUsd: minUsd ?? 0, all: !!opts.all, color, keyFor: keyNamer(E) })));
  return 0;
}

export async function main(argv, io = { stdout: process.stdout, stderr: process.stderr, stdin: process.stdin }) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv, allowPositionals: true, strict: true,
      options: { json: { type: "boolean" }, "min-usd": { type: "string" }, all: { type: "boolean" }, "no-color": { type: "boolean" }, quiet: { type: "boolean", short: "q" }, help: { type: "boolean", short: "h" }, version: { type: "boolean", short: "v" } },
    });
  } catch (e) { io.stderr.write(`${e.message}\n\n${HELP}`); return 1; }
  const { values: opts, positionals: pos } = parsed;
  if (opts.version) { io.stdout.write(`${VERSION}\n`); return 0; }
  if (opts.help || pos[0] === "help") { io.stdout.write(HELP); return 0; }
  if (!pos.length) {
    if (!io.stdin.isTTY) { io.stderr.write(HELP); return 1; }
    const a = await readLine("Wallet address(es) to scan (several: separate with spaces): ", io.stdin, io.stderr);
    if (!a) { io.stderr.write("nothing entered\n"); return 1; }
    pos.push(...a.split(/[\s,]+/).filter(Boolean));
  }
  const log = console.log;
  try {
    if (pos[0] === "keys") return await keysCmd(pos.slice(1), io);
    if (pos[0] === "setup") return await setupCmd(io);
    if (pos[0] === "update") return await updateCmd(io);
    // nothing in the scan writes results to stdout but the report: anything a module logs goes to stderr
    console.log = (...a) => console.error(...a);
    return await scanCmd(pos, opts, io);
  } catch (e) {
    io.stderr.write(`walletscan: ${scrub(e?.error || e?.message || e)}\n`);
    return 1;
  } finally {
    console.log = log;
  }
}

// run as the `walletscan` bin (npm links it, so compare real paths); imported by the tests, it does nothing
let invoked = false;
try { invoked = realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch {}
if (invoked) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
  process.stdout.write("", () => process.exit(code));
}
