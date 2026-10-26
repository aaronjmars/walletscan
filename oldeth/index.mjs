// oldeth/ - money left in old Ethereum contracts, read onchain for one wallet. Four checks, one route each:
//   oldContracts   rewards.old_contracts: Forgotten ETH's per-address index of ~386 old contracts (mirrored on disk,
//                  every hit read back onchain), EtherDelta + IDEX v1 ETH balances, 2017 ENS registrar deeds
//   makerScd       rewards.maker_scd: Single-Collateral Dai (SAI) vaults with collateral left, owned by the wallet
//                  or its DSProxy
//   argentWallets  rewards.argent_wallets: old Argent smart wallets on Ethereum whose owner is the wallet
//   validators0x00 rewards.validators_0x00: validators the wallet deposited for that still have 0x00 (BLS)
//                  withdrawal credentials, so their ETH is never paid out until the owner sets an 0x01 address
// Every check takes `io` (ioFrom(ctx) in compose.mjs; stubs in tests) and returns { items, holdings?, errors }.
// items: { category, protocol, contract, asset, amount, usd, confidence, action, how_to_claim, detail }.
// Env: OLDETH_CACHE_DIR (the index mirror, ~140 MB; default "forgotteneth" next to STUCK_CACHE_DIR, else
// oldeth/.cache/). Contracts and readers checked onchain on 2026-10-20.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { encodeFunctionData, decodeFunctionResult, decodeEventLog, parseAbi, keccak256, toHex } from "viem";

const ZERO = "0x0000000000000000000000000000000000000000";
const pad = (a) => "0x" + a.toLowerCase().slice(2).padStart(64, "0");
const eth = (wei) => Number(wei) / 1e18;
const write = (a) => `https://etherscan.io/address/${a}#writeContract`;
const short = (a) => `${a.slice(0, 8)}...`;
const msg = (e) => String(e?.error || e?.message || e).slice(0, 160);

// ---- the Forgotten ETH index mirror ---------------------------------------------------------------------------
// github.com/q84c6tsm95-create/forgotten-eth (MIT): data/index_shards/<first two hex chars>.json = { address:
// { protocol_key: eth | { e: eth, ...details } } }, 256 shards (~540 KB each), refreshed on its own scan cycle.
// warm() keeps a copy on disk: one GitHub API call lists the shards with their git sha, only changed ones are
// downloaded, a failed download keeps the last good file. Scans read the local shard; a shard not on disk yet
// is fetched once on demand.
const REPO = "q84c6tsm95-create/forgotten-eth";
const RAW = `https://raw.githubusercontent.com/${REPO}/main/data/`;
const API = `https://api.github.com/repos/${REPO}/contents/data`;
const DAY = 86_400_000;

export function cacheDir() {
  if (process.env.OLDETH_CACHE_DIR) return process.env.OLDETH_CACHE_DIR;
  if (process.env.STUCK_CACHE_DIR) { const s = resolve(process.env.STUCK_CACHE_DIR), up = dirname(s); return up === s || up === "/" ? join(s, "forgotteneth") : join(up, "forgotteneth"); }
  return fileURLToPath(new URL("./.cache/", import.meta.url));
}
const manifestPath = (dir) => join(dir, "manifest.json");
const readJson = (p, fallback) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return fallback; } };

async function download(dir, name, path) {
  const r = await fetch(RAW + path, { signal: AbortSignal.timeout(60_000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  const body = await r.text();
  JSON.parse(body); // a cut download must not replace the last good file
  const tmp = join(dir, `${name}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`); // a scan and warm() may fetch the same shard
  writeFileSync(tmp, body);
  renameSync(tmp, join(dir, name));
  return body;
}

let warming = null;
// -> { files, fetched, kept, errors, ms }
export function warm({ dir = cacheDir(), fetchList } = {}) {
  if (warming) return warming;
  warming = (async () => {
    const t0 = Date.now(), errors = [], fetched = [];
    mkdirSync(dir, { recursive: true });
    const man = readJson(manifestPath(dir), { shas: {} });
    const list = async (sub) => {
      if (fetchList) return fetchList(sub);
      const r = await fetch(API + sub, { headers: { accept: "application/vnd.github+json", "user-agent": "walletscan" }, signal: AbortSignal.timeout(30_000) });
      if (!r.ok) throw new Error(`GitHub contents${sub}: HTTP ${r.status}`);
      return r.json();
    };
    let want = [];
    try {
      const [top, shards] = await Promise.all([list(""), list("/index_shards")]);
      want = [
        ...top.filter((f) => f.name === "protocols.json").map((f) => ({ name: f.name, path: f.name, sha: f.sha })),
        ...shards.filter((f) => /^([0-9a-f]{2}|meta)\.json$/.test(f.name)).map((f) => ({ name: f.name, path: `index_shards/${f.name}`, sha: f.sha })),
      ];
    } catch (e) { errors.push(msg(e)); }
    const todo = want.filter((f) => man.shas[f.name] !== f.sha || !existsSync(join(dir, f.name)));
    await Promise.all(Array.from({ length: 8 }, async () => {
      for (let f; (f = todo.shift());) {
        try { await download(dir, f.name, f.path); man.shas[f.name] = f.sha; fetched.push(f.name); } catch (e) { errors.push(msg(e)); }
      }
    }));
    if (want.length) man.checked = Date.now();
    writeFileSync(manifestPath(dir), JSON.stringify(man));
    PROTOCOLS = null;
    const files = readdirSync(dir).filter((n) => n.endsWith(".json") && n !== "manifest.json").length;
    return { files, fetched: fetched.length, kept: files - fetched.length, errors, ms: Date.now() - t0 };
  })().finally(() => { warming = null; });
  return warming;
}

// refresh in the background once a day; never blocks a scan
function freshen(dir) {
  const man = readJson(manifestPath(dir), {});
  if (!warming && !(Date.now() - (man.checked || 0) < DAY)) warm({ dir }).catch(() => {});
}

let PROTOCOLS = null;
async function protocols(dir) {
  if (PROTOCOLS) return PROTOCOLS;
  const p = join(dir, "protocols.json");
  const body = existsSync(p) ? readFileSync(p, "utf8") : await download(dir, "protocols.json", "protocols.json");
  PROTOCOLS = new Map(JSON.parse(body).map((x) => [x.key, x]));
  return PROTOCOLS;
}

// the index entry for one wallet: { protocol_key: eth | {...} } or null
export async function lookup(address, { dir = cacheDir() } = {}) {
  const a = address.toLowerCase(), name = `${a.slice(2, 4)}.json`, p = join(dir, name);
  mkdirSync(dir, { recursive: true });
  freshen(dir);
  const body = existsSync(p) ? readFileSync(p, "utf8") : await download(dir, name, `index_shards/${name}`);
  return JSON.parse(body)[a] || null;
}

export function status({ dir = cacheDir() } = {}) {
  const man = readJson(manifestPath(dir), {});
  const shards = existsSync(dir) ? readdirSync(dir).filter((n) => /^[0-9a-f]{2}\.json$/.test(n)).length : 0;
  return { dir, shards, checked: man.checked ? new Date(man.checked).toISOString() : null, warming: !!warming };
}

// ---- onchain readers for index hits --------------------------------------------------------------------------
// Which view returns a wallet's ETH on each contract, found by reading the index's three biggest holders per
// protocol and keeping the view that returned the listed amount (within 2%) on 2026-10-20. 90 protocols,
// ~126k of the ~167k ETH in the index (The DAO's 81k included, read by rewards.legacy). Others come back as
// low-confidence hints with the index amount.
const READER_SIGS = {
  bal1: ["function balanceOf(address) view returns (uint256)", "user"],
  bal2: ["function balanceOf(address token, address user) view returns (uint256)", "eth,user"],
  tokens: ["function tokens(address token, address user) view returns (uint256)", "eth,user"],
  balancesRev: ["function balances(address user, address token) view returns (uint256)", "user,eth"],
  balances: ["function balances(address) view returns (uint256)", "user"],
  deposited: ["function deposited(address) view returns (uint256)", "user"],
  contributions: ["function contributions(address) view returns (uint256)", "user"],
  divs: ["function dividendsOf(address) view returns (uint256)", "user"],
  myDivs: ["function myDividends(bool) view returns (uint256)", "true", "from"],
  fomo: ["function getPlayerInfoByAddress(address) view returns (uint256, bytes32, uint256, uint256, uint256, uint256, uint256)", "user"],
};
const READERS = {
  bal1: "aave_v1 weth10 maker_weth yearn_v1_weth thedao veil_ether bancor_eth old_weth ethertoken_v2 ethfinex_v2 feg_feth",
  bal2: "etherdelta afrodex bitcratic idex tokenstore switchdex bitox decentrex ed_fork_6_9eth enclaves singularx etherc etherdelta_m0",
  tokens: "ethernext etherdelta_m1",
  balancesRev: "switcheo_v2",
  balances: "ethen ethfinex",
  deposited: "circles_refund_vault_admin_unlock",
  contributions: "confideal",
  fomo: "fomo3d_long fomo3d_short fomo3d_quick fomo",
  divs: "zethr bitconnect2 bitconnect_powh stronghold powh_clone1 proofofcraiggrant divsnetwork hourglassx cryptominertoken neutrino81 fairexchange powm ethdiamond omnidex proofofcommunity powh_clone2",
  // PoWH3D clones: dividends + what selling the tokens pays (calculateEthereumReceived)
  powh: "acedapp gandhiji bluechip redchip2 blackgold pooh powh3d dailydivs lynia potj unkoin rev1 eightherbank ethplatinum etherdiamond eks nexgen diamonddividend furious ethershares lockedin twelvehour hourglass_clone6 bitconnect3 cryptosurge",
  myDivs: "familyonly powh_clone4 pomda spw zethr_main cxxmain redchip decentether e25 spw2 powh_clone3 upower",
  myDivsSell: "powtf hourglass_clone7",
};
export const READER_OF = new Map(Object.entries(READERS).flatMap(([r, keys]) => keys.split(" ").map((k) => [k, r])));
const HOW = {
  bal1: "withdraw(amount) on the contract (it unwraps to ETH)", bal2: "withdraw(amount) on the exchange contract (EtherDelta style)", tokens: "withdraw(amount) on the exchange contract",
  balancesRev: "withdraw on the exchange contract", balances: "withdraw on the contract", deposited: "claim the refund on the contract", contributions: "claim the refund on the contract",
  fomo: "withdraw() on the game contract (pays the win, dividend and referral vaults)", divs: "withdraw() on the contract pays the dividends",
  powh: "sell(tokens), then withdraw() on the contract", myDivs: "withdraw() on the contract pays the dividends", myDivsSell: "sell(tokens), then withdraw() on the contract",
};
// keys another source already reads (rewards.legacy: The DAO, DGD, ZKsync Lite; airdrop.index: Uniswap) or this
// module reads directly (EtherDelta, IDEX, ENS deeds)
const SKIP = new Set(["thedao", "digixdao", "zksync_lite", "uniswap_airdrop", "etherdelta", "idex", "ens_old"]);

const powhAbi = parseAbi([
  "function dividendsOf(address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function myTokens() view returns (uint256)",
  "function myDividends(bool) view returns (uint256)",
  "function calculateEthereumReceived(uint256) view returns (uint256)",
]);
const callAbi = async (io, abi, to, fn, args = [], from) => decodeFunctionResult({ abi, functionName: fn, data: await io.call(to, encodeFunctionData({ abi, functionName: fn, args }), from) });

// one reader -> wei the wallet can take out of the contract now
export async function readWei(io, reader, contract, user) {
  if (reader === "powh" || reader === "myDivsSell") {
    const mine = reader === "myDivsSell";
    const [divs, toks] = await Promise.all(mine
      ? [callAbi(io, powhAbi, contract, "myDividends", [true], user), callAbi(io, powhAbi, contract, "myTokens", [], user)]
      : [callAbi(io, powhAbi, contract, "dividendsOf", [user]), callAbi(io, powhAbi, contract, "balanceOf", [user])]);
    return divs + (toks > 0n ? await callAbi(io, powhAbi, contract, "calculateEthereumReceived", [toks]) : 0n);
  }
  const [sig, args, from] = READER_SIGS[reader];
  const abi = parseAbi([sig]), fn = abi[0].name;
  const out = await callAbi(io, abi, contract, fn, args.split(",").map((x) => (x === "user" ? user : x === "eth" ? ZERO : true)), from ? user : undefined);
  return reader === "fomo" ? out[3] + out[4] + out[5] : out;
}

// ---- ENS 2017 registrar (HashRegistrar) deeds -----------------------------------------------------------------
const ENS_OLD = "0x6090A6e47849629b7245Dfa1Ca21D94cd15878Ef";
const ensAbi = parseAbi([
  "function entries(bytes32 _hash) view returns (uint8, address, uint256, uint256, uint256)",
  "function owner() view returns (address)",
]);
const HASH_REGISTERED = keccak256(toHex("HashRegistered(bytes32,address,uint256,uint256)"));
const MAX_DEEDS = 200;

async function ensDeeds(io, wallet, fromIndex, errors) {
  const deeds = new Map(); // labelHash -> { name }
  for (const d of fromIndex) deeds.set(d.labelHash.toLowerCase(), { name: d.name || null });
  if (io.alchemy) {
    // names this wallet won at auction (a deed it bought later is only in the index)
    const logs = await io.alchemy("eth_getLogs", [{ address: ENS_OLD, fromBlock: "0x36ee80", toBlock: "latest", topics: [HASH_REGISTERED, null, pad(wallet)] }]).catch((e) => { errors.push(`ens logs: ${msg(e)}`); return []; });
    for (const l of logs || []) if (!deeds.has(l.topics[1].toLowerCase())) deeds.set(l.topics[1].toLowerCase(), { name: null });
  } else errors.push("ens: ALCHEMY_API_KEY unset, deeds from the index only");
  const out = [];
  await Promise.all([...deeds].slice(0, MAX_DEEDS).map(async ([hash, { name }]) => {
    try {
      const [mode, deed] = await callAbi(io, ensAbi, ENS_OLD, "entries", [hash]);
      if (Number(mode) !== 2 || deed.toLowerCase() === ZERO) return; // 2 = Owned: releaseDeed works only then
      const [owner, wei] = await Promise.all([callAbi(io, ensAbi, deed, "owner"), io.balance(deed)]);
      if (owner.toLowerCase() !== wallet || wei === 0n) return;
      const label = name ? `${name}.eth` : `the name with label hash ${hash.slice(0, 10)}...`;
      out.push({
        category: "unstake_ready", protocol: "ENS (2017 registrar)", contract: deed, asset: "ETH", amount: eth(wei), confidence: "high",
        action: `release the 2017 ENS deed of ${label}: releaseDeed(${hash}) on the old registrar refunds the deposit`,
        how_to_claim: write(ENS_OLD),
        detail: `deed ${deed} for ${label} still holds the auction deposit; its owner() is this wallet. The old registrar ${ENS_OLD} pays it back with releaseDeed(labelHash); the name itself lives on in the current ENS registrar`,
      });
    } catch (e) { errors.push(`ens ${hash.slice(0, 10)}: ${msg(e)}`); }
  }));
  if (deeds.size > MAX_DEEDS) errors.push(`ens: ${deeds.size} names, first ${MAX_DEEDS} read`);
  return out;
}

// ---- rewards.old_contracts -----------------------------------------------------------------------------------
const DIRECT = [
  ["EtherDelta v2", "0x8d12A197cB00D4747a1fe03395095ce2A5CC6819", "withdraw(amount) on EtherDelta (amount in wei)"],
  ["IDEX v1", "0x2a0c0DBEcC7E4D658f48E01e3fA353F44050c208", "withdraw(0x0000000000000000000000000000000000000000, amount) on IDEX v1 (reverts within 240 blocks of the last IDEX activity)"],
];
const DUST_WEI = 10n ** 12n; // 0.000001 ETH

export async function oldContracts(address, io, { dir = cacheDir() } = {}) {
  const wallet = address.toLowerCase(), items = [], errors = [];
  let entry = null, P = new Map();
  try { [entry, P] = await Promise.all([lookup(wallet, { dir }), protocols(dir)]); } catch (e) { errors.push(`forgotteneth index: ${msg(e)}`); }
  const tasks = DIRECT.map(([name, contract, how]) => readWei(io, "bal2", contract, wallet).then((wei) => {
    if (wei > DUST_WEI) items.push({
      category: "unstake_ready", protocol: name, contract, asset: "ETH", amount: eth(wei), confidence: "high",
      action: `withdraw the ETH left on ${name}: ${how}`, how_to_claim: write(contract),
      detail: `${name} ${contract}: balanceOf(0x0, wallet) = ${eth(wei)} ETH deposited and never withdrawn`,
    });
  }, (e) => errors.push(`${name}: ${msg(e)}`)));
  tasks.push(ensDeeds(io, wallet, entry?.ens_old?.d || [], errors).then((rows) => items.push(...rows)));
  for (const [key, v] of Object.entries(entry || {})) {
    if (SKIP.has(key)) continue;
    const listed = Number(typeof v === "object" ? v?.e : v);
    if (!(listed > 0)) continue;
    const p = P.get(key), name = p?.name || key, contract = p?.contract, reader = READER_OF.get(key);
    if (!contract) continue;
    const hint = () => items.push({
      category: "unstake_ready", protocol: name, contract, asset: "ETH", amount: listed, confidence: "low",
      action: `check ${name}: Forgotten ETH lists ${listed} ETH for this wallet`, how_to_claim: "https://forgotteneth.com",
      detail: `${name} ${contract}: listed in Forgotten ETH's index, not read back onchain here (no reader for this contract); its page has the withdraw path`,
    });
    if (!reader) { hint(); continue; }
    tasks.push(readWei(io, reader, contract, wallet).then((wei) => {
      // read back as 0: taken out since the index was built
      if (wei > DUST_WEI) items.push({
        category: reader === "powh" || reader === "divs" || reader === "myDivs" || reader === "myDivsSell" || reader === "fomo" ? "reward" : "unstake_ready",
        protocol: name, contract, asset: "ETH", amount: eth(wei), confidence: "high",
        action: `take the ETH left in ${name}: ${HOW[reader]}`, how_to_claim: write(contract),
        detail: `${name} ${contract} (${p.category || "old contract"}): ${eth(wei)} ETH read onchain now (Forgotten ETH listed ${listed})`,
      });
    }, (e) => { errors.push(`${key}: ${msg(e)}`); hint(); }));
  }
  await Promise.all(tasks);
  return { items, errors, index: status({ dir }) };
}

// ---- rewards.maker_scd ---------------------------------------------------------------------------------------
const SAI_TUB = "0x448a5065aeBB8E423F0896E6c5D525C040f59af3";
const PROXY_REGISTRY = "0x4678f0a6958e4D2Bc4F1BAF7Bc52E8F3564f3fE4";
const tubAbi = parseAbi([
  "function cups(bytes32) view returns (address lad, uint256 ink, uint256 art, uint256 ire)",
  "function per() view returns (uint256)",
  "function tag() view returns (uint256)",
  "function off() view returns (bool)",
  "function tab(bytes32) returns (uint256)",
  "function proxies(address) view returns (address)",
]);
const LOG_NEW_CUP = keccak256(toHex("LogNewCup(address,bytes32)"));
const RAY = 10n ** 27n;

export async function makerScd(address, io) {
  const wallet = address.toLowerCase(), items = [], errors = [];
  if (!io.alchemy) throw { status: 400, error: "rewards.maker_scd needs ALCHEMY_API_KEY (full-range logs)" };
  const proxy = (await callAbi(io, tubAbi, PROXY_REGISTRY, "proxies", [wallet])).toLowerCase();
  const owners = [wallet, ...(proxy !== ZERO ? [proxy] : [])];
  const cups = new Set();
  // SaiTub's anonymous LogNote puts msg.sender in topic 1 and the cup id in topic 2; LogNewCup(lad, cup) has the id in data
  await Promise.all(owners.map(async (o) => {
    for (const l of await io.alchemy("eth_getLogs", [{ address: SAI_TUB, fromBlock: "0x0", toBlock: "latest", topics: [null, pad(o)] }])) {
      const id = l.topics[0] === LOG_NEW_CUP ? l.data.slice(0, 66) : l.topics[2];
      if (id && BigInt(id) > 0n && BigInt(id) < 2n ** 40n) cups.add(pad(toHex(BigInt(id))));
    }
  }));
  if (!cups.size) return { items, errors };
  const [per, tag, off] = await Promise.all(["per", "tag", "off"].map((f) => callAbi(io, tubAbi, SAI_TUB, f)));
  await Promise.all([...cups].map(async (cup) => {
    try {
      const [lad, ink, art] = await callAbi(io, tubAbi, SAI_TUB, "cups", [cup]);
      if (!owners.includes(lad.toLowerCase()) || ink === 0n) return;
      // after the shutdown (off) a debt is settled at the cage price: tab x par / tag PETH go, the rest is yours
      const owe = art > 0n ? (await callAbi(io, tubAbi, SAI_TUB, "tab", [cup])) * RAY / tag : 0n;
      const net = ink > owe ? ink - owe : 0n;
      if (net === 0n) return;
      const id = BigInt(cup), viaProxy = lad.toLowerCase() !== wallet;
      items.push({
        category: "unstake_ready", protocol: "Maker SCD (SAI)", contract: SAI_TUB, asset: "ETH", amount: eth(net * per / RAY), confidence: art > 0n || !off ? "medium" : "high",
        action: `take back the collateral of SAI vault #${id}: ${art > 0n ? "bite(cup) to settle the SAI debt, then " : ""}free(cup, ink) and exit(PETH) on SaiTub for WETH${viaProxy ? " (through your DSProxy's execute, it owns the vault)" : ""}`,
        how_to_claim: write(SAI_TUB),
        detail: `Single-Collateral Dai vault #${id} on SaiTub ${SAI_TUB}, owned by ${viaProxy ? `your DSProxy ${lad}` : "this wallet"}: ${eth(ink)} PETH at ${Number(per * 10000n / RAY) / 10000} WETH each${art > 0n ? `, ${eth(art)} SAI debt settled at the shutdown price first` : ", no debt"}. SCD shut down in 2020`,
      });
    } catch (e) { errors.push(`cup ${BigInt(cup)}: ${msg(e)}`); }
  }));
  return { items, errors };
}

// ---- rewards.argent_wallets ----------------------------------------------------------------------------------
// Argent WalletFactory contracts on Ethereum (verified source names Argent), found from WalletCreated logs
const ARGENT_FACTORIES = [
  "0x851cc731ce1613ae4fd8ec7f61f4b350f9ce1020", "0x40c84310ef15b0c0e5c69d25138e0e16e8000fe9", "0x9ae0acdb750bfcf694675f46b580847fc49a48bf",
  "0x2fe1f9bbc9ce8ea4e00f89fc1a8936de6934b63d", "0x1d09a6d1c45d1a9eb8cb8a8354bcd78e225f06d3", "0x536384fcd25b576265b6775f383d5ac408ff9db7",
];
const WALLET_CREATED = ["WalletCreated(address,address)", "WalletCreated(address,address,address)", "WalletCreated(address,address,address,address,uint256)"].map((s) => keccak256(toHex(s)));
const ownerAbi = parseAbi(["function owner() view returns (address)"]);

export async function argentWallets(address, io) {
  const wallet = address.toLowerCase(), items = [], errors = [];
  if (!io.alchemy) throw { status: 400, error: "rewards.argent_wallets needs ALCHEMY_API_KEY (full-range logs)" };
  const logs = await io.alchemy("eth_getLogs", [{ address: ARGENT_FACTORIES, fromBlock: "0x0", toBlock: "latest", topics: [WALLET_CREATED, null, pad(wallet)] }]);
  const found = [...new Set(logs.map((l) => "0x" + l.topics[1].slice(26)))];
  await Promise.all(found.map(async (w) => {
    try {
      // the owner can change: only a wallet this address still owns counts
      if ((await callAbi(io, ownerAbi, w, "owner")).toLowerCase() !== wallet) return;
      const [wei, tokens] = await Promise.all([io.balance(w), io.zerion ? io.zerion(w).catch((e) => { errors.push(`zerion ${short(w)}: ${msg(e)}`); return []; }) : []]);
      const base = { category: "reward", protocol: "Argent (L1 smart wallet)", contract: w, how_to_claim: `https://etherscan.io/address/${w}` };
      const what = `your old Argent smart wallet ${w} on Ethereum (owner() is this wallet)`;
      if (wei > DUST_WEI) items.push({ ...base, asset: "ETH", amount: eth(wei), confidence: "high", action: `move the ETH out of ${what}: sign as owner (Argent app or its TransferManager module); lost key = guardian recovery`, detail: `${what} holds ${eth(wei)} ETH` });
      for (const t of tokens) items.push({ ...base, asset: t.symbol, amount: t.amount, usd: t.usd, confidence: "medium", action: `move the ${t.symbol} out of ${what}`, detail: `${what} holds ${t.amount} ${t.symbol} (Zerion's read)` });
    } catch (e) { errors.push(`${short(w)}: ${msg(e)}`); }
  }));
  return { items, errors, wallets: found };
}

// ---- rewards.validators_0x00 ---------------------------------------------------------------------------------
const DEPOSIT = "0x00000000219ab540356cBB839Cbe05303d7705Fa";
const depositAbi = parseAbi(["event DepositEvent(bytes pubkey, bytes withdrawal_credentials, bytes amount, bytes signature, bytes index)"]);
const MAX_DEPOSITS = 100;
const EXITED = /^(exited|withdrawal)_/, ACTIVE = /^active_/;

export async function validators0x00(address, io) {
  const wallet = address.toLowerCase(), items = [], holdings = [], errors = [];
  if (!io.alchemy) throw { status: 400, error: "rewards.validators_0x00 needs ALCHEMY_API_KEY" };
  // deposits sent straight from this wallet (a pool or batch contract depositing for it is not seen)
  const tr = await io.alchemy("alchemy_getAssetTransfers", [{ fromAddress: wallet, toAddress: DEPOSIT, category: ["external"], excludeZeroValue: true, maxCount: "0x3e8", withMetadata: false }]);
  const txs = [...new Set((tr?.transfers || []).map((t) => t.hash))];
  if (txs.length > MAX_DEPOSITS) errors.push(`${txs.length} deposits, first ${MAX_DEPOSITS} read`);
  const pubkeys = new Set();
  for (let i = 0; i < Math.min(txs.length, MAX_DEPOSITS); i += 10) {
    await Promise.all(txs.slice(i, Math.min(i + 10, MAX_DEPOSITS)).map(async (h) => {
      const rc = await io.alchemy("eth_getTransactionReceipt", [h]).catch((e) => { errors.push(`receipt ${h.slice(0, 10)}: ${msg(e)}`); return null; });
      for (const l of rc?.logs || []) {
        if (l.address.toLowerCase() !== DEPOSIT.toLowerCase()) continue;
        const { args } = decodeEventLog({ abi: depositAbi, data: l.data, topics: l.topics });
        if (args.withdrawal_credentials.startsWith("0x00")) pubkeys.add(args.pubkey);
      }
    }));
  }
  const vals = [];
  const keys = [...pubkeys].sort();
  for (let i = 0; i < keys.length; i += 50) vals.push(...await io.beacon(keys.slice(i, i + 50)));
  // the beacon state is the truth: credentials changed to 0x01 since the deposit drop out here
  const bls = vals.filter((v) => v.validator?.withdrawal_credentials?.startsWith("0x00") && Number(v.balance) > 0);
  const exited = bls.filter((v) => EXITED.test(v.status)), active = bls.filter((v) => ACTIVE.test(v.status));
  const gwei = (list, f) => list.reduce((t, v) => t + f(v), 0) / 1e9;
  const ids = (list) => list.slice(0, 8).map((v) => `#${v.index}`).join(", ") + (list.length > 8 ? ` and ${list.length - 8} more` : "");
  const how = "https://launchpad.ethereum.org/en/withdrawals";
  const sign = "sign a BLS-to-execution change with the withdrawal mnemonic, offline (staking-deposit-cli or ethdo), and broadcast it";
  if (exited.length) items.push({
    category: "unstake_ready", protocol: "Ethereum staking", contract: DEPOSIT, asset: "ETH", amount: gwei(exited, (v) => Number(v.balance)), confidence: "medium",
    action: `set an 0x01 withdrawal address on ${exited.length} exited validator${exited.length > 1 ? "s" : ""}: ${sign}; the balance is then paid out by itself`,
    how_to_claim: how,
    detail: `validator${exited.length > 1 ? "s" : ""} ${ids(exited)} exited but still have 0x00 (BLS) withdrawal credentials, so nothing is ever paid out. Found from deposits this wallet sent; only the holder of the withdrawal key can claim`,
  });
  if (active.length) {
    const skim = gwei(active, (v) => Math.max(0, Number(v.balance) - 32e9));
    if (skim > 0) items.push({
      category: "reward", protocol: "Ethereum staking", contract: DEPOSIT, asset: "ETH", amount: skim, confidence: "medium",
      action: `set an 0x01 withdrawal address on ${active.length} active validator${active.length > 1 ? "s" : ""} to get the rewards above 32 ETH paid out: ${sign}`,
      how_to_claim: how,
      detail: `validator${active.length > 1 ? "s" : ""} ${ids(active)} still have 0x00 (BLS) withdrawal credentials: rewards above 32 ETH each pile up unpaid until an 0x01 address is set`,
    });
    holdings.push({ kind: "staked", asset: "ETH", amount: gwei(active, (v) => Math.min(32e9, Number(v.balance))), protocol: "Ethereum staking", detail: `${active.length} active validator${active.length > 1 ? "s" : ""} with 0x00 credentials (${ids(active)})` });
  }
  return { items, holdings, errors, validators: bls.map((v) => ({ index: v.index, status: v.status, balance_eth: Number(v.balance) / 1e9 })) };
}

// ---- prices + the io a compose route hands in ----------------------------------------------------------------
// every amount here is ETH except Argent token rows (priced by Zerion)
export async function priceEth(io, out) {
  const rows = [...out.items, ...(out.holdings || [])].filter((r) => r.asset === "ETH" && r.usd == null);
  if (!rows.length) return out;
  const p = await io.ethUsd().catch(() => null);
  for (const r of rows) r.usd = p ? r.amount * p : null;
  return out;
}

const rpcBody = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });
export function ioFrom(ctx) {
  const step = async (id, body) => {
    const r = await ctx.call(id, {}, { body });
    if (!r.ok) throw { error: `${id}: upstream ${r.status}` };
    if (r.data?.error) throw { error: `${id}: ${r.data.error.message || JSON.stringify(r.data.error)}` };
    return r.data?.result;
  };
  return {
    call: (to, data, from) => step("evm.rpc", rpcBody("eth_call", [{ to, data, ...(from && { from }) }, "latest"])),
    balance: async (a) => BigInt(await step("evm.rpc", rpcBody("eth_getBalance", [a, "latest"]))),
    alchemy: ctx.live("evm.alchemy") ? (method, params) => step("evm.alchemy", rpcBody(method, params)) : null,
    beacon: async (ids) => {
      const r = await ctx.call("evm.beacon_validators", { ids: ids.join(",") });
      if (!r.ok) throw { error: `evm.beacon_validators: upstream ${r.status}` };
      return r.data?.data || [];
    },
    ethUsd: async () => (await ctx.call("token.prices", { coins: "coingecko:ethereum" })).data?.coins?.["coingecko:ethereum"]?.price ?? null,
    // verified Ethereum tokens worth $1+ (Zerion), for the Argent wallets
    zerion: ctx.live("holdings.zerion") ? async (a) => {
      const r = await ctx.call("holdings.zerion", { address: a });
      if (!r.ok) throw { error: `holdings.zerion: upstream ${r.status}` };
      return (r.data?.data || []).filter((p) => p.relationships?.chain?.data?.id === "ethereum" && p.attributes?.fungible_info?.flags?.verified && Number(p.attributes?.value) >= 1 && p.attributes?.fungible_info?.symbol !== "ETH")
        .map((p) => ({ symbol: p.attributes.fungible_info.symbol, amount: Number(p.attributes.quantity?.numeric), usd: Number(p.attributes.value) }));
    } : null,
  };
}
