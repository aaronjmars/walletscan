// nonevm/sui.mjs - Sui (0x + 64 hex addresses), read over Sui's public GraphQL (the public JSON-RPC answers "deprecated"
// since 2026). Sources (read 2026-10-22):
//   sui.bucket_farm  stakes left in Bucket Farm, the DROP points farm Bucket closed in 2025 (DefiLlama deadFrom 2025-09-09).
//                    The farm keeps each staker's Profile in a linked table of its PointCenter (keyed by address): stakes
//                    per pool (a DegenPool<DROP, T> object) with the raw amount. Unstaking still works (one transaction:
//                    account::request, pool::request_unstake, wrapper::fulfill_unstake, point::fulfill_unstake; last
//                    seen 2026-10-11), but Bucket lent most of several pools to NAVI and Scallop "ponds": a pool pays only
//                    what it holds itself, so a stake bigger than the pool's own balance waits on Bucket
//   sui.staking      native stakes (0x3::staking_pool::StakedSui objects the address owns). A stake whose validator
//                    left the active set (its pool is in the system's inactive_validators table) earns nothing and
//                    can be withdrawn at once: a finding. Stakes with active validators are holdings
//   sui.balances     coin balances with a trusted DefiLlama price (Sui wallets get many airdropped spam coins: unpriced
//                    ones are left out)
// Not here: Sui Bridge transfers never claimed on Ethereum (hiddenfunds sui-bridge, ~$86K: read by Ethereum address) and
// Aptos (same 0x + 64 hex shape; aptos-bridge ~$87.5K).
import { pricesOf, trustedPrice } from "../forgotten/anyrpc.mjs";

export const SUI_GQL = "https://graphql.mainnet.sui.io/graphql";
export const SUI_TYPE = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
// Bucket Farm: PointCenter<DROP> and its user_profiles linked table (fixed object ids)
export const BUCKET = {
  center: "0xc60fb4131a47aa52ac27fe5b6f9613ffe27832c5f52d27755511039d53908217",
  profiles: "0xff2b096a00ee6ad2c10ec9d221db78fcb44d95aee69631d852df7e1cadb8c60f",
  app: "https://farm.bucketprotocol.io",
};
// the system ValidatorSet's inactive_validators table (pool id -> validator), fixed since genesis
export const INACTIVE_VALIDATORS = "0xf2dfc014f09869d512c7965d743e1f513853f492d9c7c0d755597154cb3ff8cd";
const STAKED_SUI = "0x3::staking_pool::StakedSui";
const MAX_STAKE_PAGES = 4; // 200 stake objects
const MAX_META = 15; // aliased reads per GraphQL request (Sui GraphQL refuses over 21 store reads in one request)

const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const units = (raw, dec) => Number(BigInt(raw ?? 0)) / 10 ** Number(dec || 0);
const b64 = (hex) => Buffer.from(String(hex).replace(/^0x/, "").padStart(64, "0"), "hex").toString("base64");
const U64_ONE = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]).toString("base64");
// "0x2::sui::SUI" and "2::sui::SUI" -> the 0x + 64 hex address form (module and struct names keep their case: Move
// types are case sensitive; DefiLlama keys are not)
export const fullType = (t) => { const [a, ...rest] = String(t).split("::"); return [`0x${a.replace(/^0x/, "").toLowerCase().padStart(64, "0")}`, ...rest].join("::"); };
const priceKey = (t) => `sui:${fullType(t)}`.toLowerCase(); // pricesOf keys its map in lowercase
const priceable = (t) => !/[<>,\s]/.test(t); // a generic type (LP<A, B>) would break DefiLlama's comma list
const symbolOf = (t) => String(t).split("::").pop();

function needSui(p) {
  const a = String(p.address ?? "").trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(a)) throw { status: 400, error: "address must be a Sui address (0x + 64 hex)", detail: a.slice(0, 80) };
  return a.toLowerCase();
}

async function gql(ctx, query, variables = {}) {
  const r = await ctx.call("sui.graphql", {}, { body: { query, variables } });
  if (!r.ok || r.data?.errors?.length || !r.data?.data) throw { status: 502, error: `Sui GraphQL failed (upstream ${r.status})`, detail: r.data?.errors?.[0]?.message || r.data };
  return r.data.data;
}

// ---- sui.bucket_farm ------------------------------------------------------------------------------------------
const POND_NAMES = { NAVI_POND: "NAVI", NAVI_UNI_POND: "NAVI", SCALLOP_POND: "Scallop" };
export async function bucketFarm(p, ctx) {
  const address = needSui(p);
  const d = await gql(ctx, `query($t: SuiAddress!, $b: Base64!) {
  center: object(address: "${BUCKET.center}") { asMoveObject { contents { json } } }
  profile: address(address: $t) { dynamicField(name: { type: "address", bcs: $b }) { value { ... on MoveValue { json } } } }
}`, { t: BUCKET.profiles, b: b64(address) });
  const center = d.center?.asMoveObject?.contents?.json;
  if (!center) throw { status: 502, error: "Bucket Farm PointCenter not found" };
  const profile = d.profile?.dynamicField?.value?.json?.value;
  const held = (profile?.stakes?.contents || []).filter((s) => BigInt(s.value?.amount || 0) > 0n);
  if (!held.length) return { items: [], holdings: [], errors: [] };
  const states = new Map((center.pool_states?.contents || []).map((s) => [s.key, s.value]));
  const types = held.map((s) => fullType(`0x${states.get(s.key)?.asset_type}`));
  // decimals and symbol from DefiLlama for priced coins; coinMetadata only for the others (GraphQL allows ~20 store
  // reads per request); then each held pool's own balance (what it can pay now) and what it lent out
  const px = await pricesOf(ctx, types.filter(priceable).map(priceKey));
  const ask = [...new Set(types.filter((t) => px.get(priceKey(t))?.decimals == null))].slice(0, MAX_META);
  const d2 = await gql(ctx, `query($k: [ObjectKey!]!) {
  pools: multiGetObjects(keys: $k) { address asMoveObject { contents { json } } }
${ask.map((t, i) => `  m${i}: coinMetadata(coinType: "${t}") { decimals symbol }`).join("\n")}
}`, { k: held.map((s) => ({ address: s.key })) });
  const pools = new Map((d2.pools || []).filter(Boolean).map((o) => [o.address, o.asMoveObject?.contents?.json]));
  const metaOf = (t) => { const i = ask.indexOf(t), c = px.get(priceKey(t)); return i >= 0 ? d2[`m${i}`] || {} : { decimals: c?.decimals, symbol: c?.symbol }; };
  const items = held.map((s, i) => {
    const t = types[i], meta = metaOf(t), dec = meta.decimals;
    const asset = meta.symbol || symbolOf(t);
    if (dec == null) return { category: "unstake_ready", chain: "sui", asset, token: t, amount: Number(s.value.amount), usd: null, protocol: "Bucket Farm", status: "hint", action: `unstake it on ${BUCKET.app}`, how_to_claim: BUCKET.app, detail: `raw amount ${s.value.amount} in pool ${s.key}: the coin's decimals are unknown` };
    const amount = units(s.value.amount, dec), price = trustedPrice(px, priceKey(t));
    const pool = pools.get(s.key), liquid = pool?.balance != null ? units(pool.balance, dec) : null;
    const lent = (pool?.sheet?.credits?.contents || []).filter((c) => BigInt(c.value?.pos0 || 0) > 0n).map((c) => POND_NAMES[String(c.key?.pos0).split("::").pop()] || String(c.key?.pos0).split("::").pop());
    const enough = liquid != null && liquid >= amount;
    return {
      category: "unstake_ready", chain: "sui", asset, token: t, amount: round(amount, 6), usd: price == null ? null : round(amount * price), protocol: "Bucket Farm",
      status: enough ? "ready" : "pending",
      action: enough
        ? `unstake it on ${BUCKET.app} (one transaction; the farm closed in 2025 and pays no more DROP points)`
        : `unstake what the pool still holds (${round(liquid ?? 0, 4)} ${asset}) on ${BUCKET.app}; the rest is lent to ${[...new Set(lent)].join(" and ") || "other protocols"} and waits until the Bucket team acts (recalls it into the pool)`,
      how_to_claim: BUCKET.app, deadline: null,
      detail: [`${round(amount, 6)} ${asset} staked in Bucket Farm pool ${s.key}, never unstaked`,
        liquid != null && `the pool holds ${round(liquid, 4)} ${asset} of its own now${lent.length ? `, the rest lent to ${[...new Set(lent)].join(" and ")}` : ""}`,
        BigInt(profile.points || 0) > 0n && `${round(units(profile.points, 9), 2)} DROP points on the profile (not claimable: the farm's claim is switched off)`,
        "the farm site still loads; never sign anything a \"claim\" message sends you to"].filter(Boolean).join("; "),
    };
  });
  return { items, holdings: [], errors: [] };
}

// ---- sui.staking ----------------------------------------------------------------------------------------------
export async function suiStaking(p, ctx) {
  const address = needSui(p);
  const stakes = [], errors = [];
  let after = null;
  for (let page = 0; page < MAX_STAKE_PAGES; page++) {
    const d = await gql(ctx, `query($a: SuiAddress!, $c: String) { address(address: $a) { objects(first: 50, after: $c, filter: { type: "${STAKED_SUI}" }) { pageInfo { hasNextPage endCursor } nodes { address contents { json } } } } }`, { a: address, c: after });
    const o = d.address?.objects;
    stakes.push(...(o?.nodes || []).map((n) => n.contents?.json).filter(Boolean));
    if (!o?.pageInfo?.hasNextPage) { after = null; break; }
    after = o.pageInfo.endCursor;
  }
  if (after) errors.push(`over ${MAX_STAKE_PAGES * 50} stake objects: only the first ${MAX_STAKE_PAGES * 50} were read`);
  if (!stakes.length) return { items: [], holdings: [], errors };
  const byPool = new Map();
  for (const s of stakes) {
    const g = byPool.get(s.pool_id) || { pool: s.pool_id, raw: 0n, n: 0, first: null };
    g.raw += BigInt(s.principal || 0); g.n++;
    g.first = g.first == null ? Number(s.stake_activation_epoch) : Math.min(g.first, Number(s.stake_activation_epoch));
    byPool.set(s.pool_id, g);
  }
  const pools = [...byPool.values()];
  // which pools belong to a validator that left the set, and that validator's name and last epoch
  const d = await gql(ctx, `query($k: [DynamicFieldName!]!) { address(address: "${INACTIVE_VALIDATORS}") { multiGetDynamicFields(keys: $k) { name { json } value { ... on MoveValue { json } } } } }`,
    { k: pools.map((g) => ({ type: "0x2::object::ID", bcs: b64(g.pool) })) });
  const inactive = new Map((d.address?.multiGetDynamicFields || []).filter(Boolean).map((f) => [f.name?.json, f.value?.json?.inner?.id]));
  let info = {};
  if (inactive.size) {
    const ids = [...inactive.entries()].slice(0, MAX_META); // names only (a missing name leaves the pool id in the row)
    info = await gql(ctx, `{
${ids.map(([, inner], i) => `  v${i}: address(address: "${inner}") { dynamicField(name: { type: "u64", bcs: "${U64_ONE}" }) { value { ... on MoveValue { name: extract(path: "metadata.name") { json } deact: extract(path: "staking_pool.deactivation_epoch") { json } } } } }`).join("\n")}
}`).then((x) => Object.fromEntries(ids.map(([pool], i) => [pool, x[`v${i}`]?.dynamicField?.value])), (e) => { errors.push(`validator names: ${e.error || e}`); return {}; });
  }
  const px = await pricesOf(ctx, ["coingecko:sui"]);
  const price = trustedPrice(px, "coingecko:sui");
  const items = [], holdings = [];
  for (const g of pools) {
    const amount = units(g.raw, 9), usd = price == null ? null : round(amount * price);
    if (inactive.has(g.pool)) {
      const v = info[g.pool] || {}, name = v.name?.json || null, deact = v.deact?.json ?? null;
      items.push({
        category: "unstake_ready", chain: "sui", asset: "SUI", token: SUI_TYPE, amount: round(amount, 6), usd, protocol: `Sui staking${name ? ` (${name})` : ""}`, status: "ready",
        action: `withdraw the stake${g.n > 1 ? `s (${g.n} stake objects)` : ""} in a Sui wallet (Slush: Stake, the stake with ${name || "this validator"}, Unstake); it pays principal plus the rewards earned before the validator left, at once`,
        how_to_claim: "https://slush.app", deadline: null,
        detail: [`${round(amount, 4)} SUI principal in ${g.n} stake object${g.n > 1 ? "s" : ""} with validator ${name || g.pool}${deact != null ? `, which left the validator set at epoch ${deact}` : ", which left the validator set"}`,
          "a stake with an inactive validator earns nothing: withdrawing it (0x3::sui_system::request_withdraw_stake) is the only thing left to do", `pool ${g.pool}`].join("; "),
      });
    } else {
      holdings.push({ kind: "staked", chain: "sui", asset: "SUI", token: SUI_TYPE, amount: round(amount, 6), usd, verified: true, protocol: "Sui staking", detail: `${g.n} stake object${g.n > 1 ? "s" : ""} with active validator pool ${g.pool} since epoch ${g.first}; principal only, rewards not counted` });
    }
  }
  return { items, holdings, errors };
}

// ---- sui.balances ---------------------------------------------------------------------------------------------
export async function suiBalances(p, ctx) {
  const address = needSui(p);
  // decimals and symbol come with the DefiLlama price (coinMetadata per coin would pass GraphQL's per-request read limit)
  const d = await gql(ctx, `query($a: SuiAddress!) { address(address: $a) { balances(first: 50) { pageInfo { hasNextPage } nodes { coinType { repr } totalBalance } } } }`, { a: address });
  const nodes = (d.address?.balances?.nodes || []).filter((n) => BigInt(n.totalBalance || 0) > 0n);
  if (!nodes.length) return { items: [], holdings: [], errors: [] };
  const px = await pricesOf(ctx, nodes.map((n) => n.coinType.repr).filter(priceable).map(priceKey));
  const holdings = [];
  let unpriced = 0;
  for (const n of nodes) {
    const t = fullType(n.coinType.repr), c = px.get(priceKey(t)), price = trustedPrice(px, priceKey(t)), dec = c?.decimals;
    if (price == null || dec == null) { unpriced++; continue; }
    const amount = units(n.totalBalance, dec);
    holdings.push({ kind: "token", chain: "sui", asset: c?.symbol || symbolOf(t), token: t, amount: round(amount, 6), usd: round(amount * price), verified: true });
  }
  return { items: [], holdings, unpriced, more: !!d.address?.balances?.pageInfo?.hasNextPage, errors: [] };
}

export const COMPOSE = { bucketFarm, suiStaking, suiBalances };

const EX = "0x7797f5950124799e01b37f8fb9a22b5c26f78014b12d9a53612c11abaf2c230c"; // 1,269.78 SUI left in Bucket Farm
export const ROUTES = [
  {"id":"sui.graphql","group":"sui","method":"POST","url":SUI_GQL,"body":{"query":"{query}"},"auth":null,"input":{"query":"a Sui GraphQL query (compose steps send their own body with variables)"},"returns":"{data, errors[]} - Sui mainnet GraphQL (the public JSON-RPC is deprecated): object, address {balances, objects, dynamicField}, coinMetadata, epoch, events, transaction","example":{"query":"{ chainIdentifier epoch { epochId } }"},"timeout":30},
  {"id":"sui.bucket_farm","group":"sui","method":"GET","compose":"bucketFarm","uses":["sui.graphql","token.prices"],"url":"(compose: the Bucket Farm PointCenter 0xc60fb413 pool states + the address's Profile in its user_profiles linked table, then each held DegenPool's own balance and what it lent to NAVI / Scallop, priced on DefiLlama)","input":{"address":"Sui address (0x + 64 hex)"},"returns":"{items[] {category unstake_ready, chain sui, protocol Bucket Farm, asset, token (coin type), amount, usd, status (ready: the pool holds enough to pay it now | pending: the rest is lent out, waits on Bucket), action, how_to_claim (farm.bucketprotocol.io), detail}, holdings[], errors[]} - stakes left in the Bucket DROP points farm, closed in 2025","example":{"address":EX},"check":"weekly"},
  {"id":"sui.staking","group":"sui","method":"GET","compose":"suiStaking","uses":["sui.graphql","token.prices"],"url":"(compose: StakedSui objects the address owns, each pool looked up in the system's inactive_validators table)","input":{"address":"Sui address (0x + 64 hex)"},"returns":"{items[] {category unstake_ready, protocol Sui staking (validator), asset SUI, amount (principal), usd, status ready, action, detail} for stakes with a validator that left the set (they earn nothing; withdraw at once), holdings[] {kind staked} for stakes with active validators, errors[]}","example":{"address":"0x9cc48fe04bfcd7661caf127909020e9474fc91c1e92531c882e52a40f4710e3f"},"check":"weekly"},
  {"id":"sui.balances","group":"sui","method":"GET","compose":"suiBalances","uses":["sui.graphql","token.prices"],"url":"(compose: the address's coin balances on Sui GraphQL, priced on DefiLlama)","input":{"address":"Sui address (0x + 64 hex)"},"returns":"{holdings[] {kind token, chain sui, asset, token (coin type), amount, usd, verified}, unpriced (coins left out: no trusted price, often spam), more (over 50 coin types)}","example":{"address":EX},"check":"weekly"},
];

export const SCAN = {
  kind: "sui", id: "scan.sui", compose: "scanSui", chains: ["sui"], label: "Sui 0x + 64 hex",
  sources: ["sui.bucket_farm", "sui.staking", "sui.balances"],
  returns: "Bucket Farm stakes left in the closed DROP points farm, native SUI stakes with a validator that left the set (withdraw at once), active stakes and priced coin balances as holdings; Aptos (same address shape) is not scanned",
  example: EX,
};
