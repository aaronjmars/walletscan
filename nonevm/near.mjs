// nonevm/near.mjs - NEAR: stake left in staking pools and NEAR held in lockup contracts (hiddenfunds near-unstaked,
// $61.3M on 2026-09-30: unstaked NEAR whose 4-epoch wait is over, or stake sitting in a pool that is no longer a
// validator). Read 2026-10-22 over keyless APIs:
//   near.staking_pools  FastNEAR's index of every pool an account ever staked in (api.fastnear.com)
//   near.rpc            NEAR JSON-RPC (rpc.mainnet.fastnear.com): view calls on the pools (get_account) and lockups,
//                       view_account for the liquid balance, validators for the active set
// Sources:
//   near.staking  the account's own pools: unstaked + can_withdraw = ready (withdraw_all), unstaked still waiting =
//                 pending, staked in a pool outside the validator set = earns nothing (unstake_all, then withdraw);
//                 holdings = liquid NEAR + stake in active pools
//   near.lockup   the account's lockup contract (sha256(owner) first 20 bytes hex + ".lockup.near", the 2020 genesis
//                 and foundation lockups): NEAR the owner can transfer out now, its pool's unstaked NEAR, and old
//                 lockups whose transfers were never turned on (check_transfers_vote: the vote passed in October 2020)
import { createHash } from "node:crypto";
import { nearAccount } from "./address.mjs";
import { pricesOf, trustedPrice, round } from "../forgotten/anyrpc.mjs";

const NEAR_PRICE = "coingecko:near";
const STAKE_UI = "https://app.mynearwallet.com/staking";
const MAX_POOLS = 40; // FastNEAR lists every pool ever used; each one is one view call
const DUST = 0.01; // NEAR: pools keep a few yocto after a withdraw
const yocto = (v) => { try { return Number(BigInt(v ?? 0) / 10n ** 16n) / 1e8; } catch { return 0; } };
const errText = (e) => String(e?.error || e?.message || e).slice(0, 160);

export const lockupOf = (owner) => `${createHash("sha256").update(String(owner)).digest("hex").slice(0, 40)}.lockup.near`;

function needNear(p) {
  if (p.address == null || p.address === "") throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  const a = nearAccount(String(p.address).trim());
  if (!a) throw { status: 400, error: "address must be a NEAR account (64-hex implicit, or name.near / name.tg / name.sweat...)", detail: String(p.address).slice(0, 64) };
  return a.address;
}

const rpcBody = (method, params) => ({ jsonrpc: "2.0", id: 1, method, params });
async function rpc(ctx, method, params) {
  const r = await ctx.call("near.rpc", {}, { body: rpcBody(method, params) });
  const err = r.data?.error || r.data?.result?.error;
  if (err) throw { status: 502, error: `NEAR ${method}: ${typeof err === "string" ? err.slice(0, 120) : err.cause?.name || err.name || JSON.stringify(err).slice(0, 120)}`, unknown: err?.cause?.name === "UNKNOWN_ACCOUNT" || /does not exist|UnknownAccount/i.test(JSON.stringify(err)) };
  if (!r.ok) throw { status: 502, error: `NEAR ${method} failed (upstream ${r.status})` };
  return r.data.result;
}
// a contract view call: args as JSON, answer bytes as JSON
export async function view(ctx, contract, fn, args = {}) {
  const res = await rpc(ctx, "query", { request_type: "call_function", finality: "final", account_id: contract, method_name: fn, args_base64: Buffer.from(JSON.stringify(args)).toString("base64") });
  return JSON.parse(Buffer.from(res.result).toString());
}
const viewAccount = (ctx, id) => rpc(ctx, "query", { request_type: "view_account", finality: "final", account_id: id });

// pools validating now or next epoch; null when the read failed (then no pool is called inactive)
async function activePools(ctx) {
  const v = await rpc(ctx, "validators", [null]);
  return new Set([...(v.current_validators || []), ...(v.next_validators || [])].map((x) => x.account_id));
}
const nearUsd = (amount, price) => (price == null ? null : round(amount * price));

// one pool's balance of `who` -> items + holdings. via = how the owner moves it (own account or through the lockup)
function poolRows(pool, acc, { who, active, price, lockup }) {
  const items = [], holdings = [];
  const unstaked = yocto(acc.unstaked_balance), staked = yocto(acc.staked_balance);
  const through = lockup ? `on the lockup ${lockup}: call withdraw_all_from_staking_pool, then transfer it out` : `call withdraw_all on ${pool}`;
  if (unstaked >= DUST) {
    items.push(acc.can_withdraw ? {
      category: "unstake_ready", chain: "near", asset: "NEAR", amount: round(unstaked, 4), usd: nearUsd(unstaked, price), protocol: `NEAR staking (${pool})`, status: "ready",
      action: `withdraw the unstaked NEAR: ${through} (MyNearWallet staking page, or near-cli)`, how_to_claim: STAKE_UI,
      detail: `${round(unstaked, 4)} NEAR unstaked in ${pool} by ${who}, the 4-epoch wait is over and it was never withdrawn; it earns nothing there`,
    } : {
      category: "unstake_ready", chain: "near", asset: "NEAR", amount: round(unstaked, 4), usd: nearUsd(unstaked, price), protocol: `NEAR staking (${pool})`, status: "pending",
      action: `wait for the unstaking to finish (4 epochs, about 2 days), then ${through}`, how_to_claim: STAKE_UI,
      detail: `${round(unstaked, 4)} NEAR unstaked in ${pool} by ${who}, still in its 4-epoch wait`,
    });
  }
  if (staked >= DUST) {
    if (active && !active.has(pool)) {
      items.push({
        category: "unstake_ready", chain: "near", asset: "NEAR", amount: round(staked, 4), usd: nearUsd(staked, price), protocol: `NEAR staking (${pool})`, status: "inactive_pool",
        action: `the pool is not a validator now, so this stake earns nothing: call unstake_all on ${pool}${lockup ? ` through the lockup ${lockup}` : ""}, then withdraw after 4 epochs (about 2 days)`, how_to_claim: STAKE_UI,
        detail: `${round(staked, 4)} NEAR staked by ${who} in ${pool}, which is in neither the current nor the next validator set`,
      });
    } else {
      holdings.push({ kind: "staked", chain: "near", asset: "NEAR", amount: round(staked, 4), usd: nearUsd(staked, price), verified: true, protocol: `NEAR staking (${pool})`, ...(lockup && { detail: `staked through the lockup ${lockup}` }) });
    }
  }
  return { items, holdings };
}

async function poolAccounts(ctx, pools, who, errors) {
  const out = await Promise.all(pools.map((pool) => view(ctx, pool, "get_account", { account_id: who }).then((a) => [pool, a], (e) => { errors.push(`${pool}: ${errText(e)}`); return null; })));
  return out.filter(Boolean);
}

export async function nearStaking(p, ctx) {
  const address = needNear(p);
  const errors = [];
  const idx = await ctx.call("near.staking_pools", { account_id: address });
  if (!idx.ok) throw { status: 502, error: `FastNEAR staking index failed (upstream ${idx.status})` };
  const pools = [...new Set((idx.data?.pools || []).map((x) => x.pool_id).filter(Boolean))].slice(0, MAX_POOLS);
  const [acct, px, accs] = await Promise.all([
    viewAccount(ctx, address).catch((e) => { if (!e.unknown) errors.push(`balance: ${errText(e)}`); return null; }),
    pricesOf(ctx, [NEAR_PRICE]),
    poolAccounts(ctx, pools, address, errors),
  ]);
  // the validator set (a big answer) is only read when some stake is still in a pool
  const active = accs.some(([, a]) => yocto(a.staked_balance) >= DUST) ? await activePools(ctx).catch((e) => { errors.push(`validators: ${errText(e)}`); return null; }) : null;
  const price = trustedPrice(px, NEAR_PRICE), items = [], holdings = [];
  for (const [pool, acc] of accs) {
    const r = poolRows(pool, acc, { who: address, active, price });
    items.push(...r.items); holdings.push(...r.holdings);
  }
  const liquid = acct ? yocto(acct.amount) : 0;
  if (liquid >= DUST) holdings.unshift({ kind: "token", chain: "near", asset: "NEAR", amount: round(liquid, 4), usd: nearUsd(liquid, price), verified: true });
  if (pools.length && accs.length === 0 && errors.length) throw { status: 502, error: errors.join("; ") };
  return { pools, items, holdings, errors, ...(acct == null && !errors.some((e) => e.startsWith("balance")) && { exists: false }) };
}

export async function nearLockup(p, ctx) {
  const owner = needNear(p);
  if (owner.endsWith(".lockup.near")) return { lockup: null, items: [], holdings: [], errors: [], note: "the address is a lockup itself: near.staking reads its pool" };
  const lockup = lockupOf(owner);
  const acct = await viewAccount(ctx, lockup).catch((e) => { if (e.unknown) return null; throw e; });
  if (!acct) return { lockup: null, items: [], holdings: [], errors: [] };
  const errors = [];
  const v = (fn) => view(ctx, lockup, fn).catch((e) => { errors.push(`${fn}: ${errText(e)}`); return null; });
  const [ownerId, pool, tx, balance, owners, liquid, locked, px] = await Promise.all([
    v("get_owner_account_id"), v("get_staking_pool_account_id"), v("are_transfers_enabled"), v("get_balance"), v("get_owners_balance"), v("get_liquid_owners_balance"), v("get_locked_amount"), pricesOf(ctx, [NEAR_PRICE]),
  ]);
  if (ownerId != null && ownerId !== owner) return { lockup, owner: ownerId, items: [], holdings: [], errors, note: "this lockup belongs to another account" };
  const price = trustedPrice(px, NEAR_PRICE);
  const acc = pool ? await view(ctx, pool, "get_account", { account_id: lockup }).catch((e) => { errors.push(`${pool}: ${errText(e)}`); return null; }) : null;
  const total = yocto(balance), lockedN = yocto(locked), liquidN = yocto(liquid), ownersN = yocto(owners);
  const items = [], holdings = [];
  const facts = { lockup, pool: pool || null, transfers_enabled: tx, balance: round(total, 4), locked: round(lockedN, 4), owners_balance: round(ownersN, 4), liquid: round(liquidN, 4) };
  if (tx === false) {
    // a 2020 lockup whose owner never turned transfers on: everything stays locked until check_transfers_vote is
    // called. get_balance counts the pool at what was deposited, so the pool's own numbers (with rewards) are used
    const inPool = acc ? yocto(acc.unstaked_balance) + yocto(acc.staked_balance) : 0, held = Math.max(total, yocto(acct.amount) + inPool);
    if (held >= DUST) {
      const staked = acc && yocto(acc.staked_balance) >= DUST;
      items.push({
        category: "vesting", chain: "near", asset: "NEAR", amount: round(held, 4), usd: nearUsd(held, price), protocol: "NEAR lockup", status: "action",
        action: `turn transfers on: call check_transfers_vote on the lockup ${lockup} (the NEAR transfer vote passed in October 2020), then${staked ? ` unstake_all from ${pool} through the lockup, wait 4 epochs (about 2 days),` : ""}${acc && inPool >= DUST ? ` call withdraw_all_from_staking_pool and` : ""} transfer the unlocked NEAR out (MyNearWallet shows the lockup)`,
        how_to_claim: STAKE_UI,
        detail: `the lockup ${lockup} of ${owner} holds ${round(held, 4)} NEAR${inPool >= DUST ? ` (${round(inPool, 4)} of it in ${pool}${staked ? ", still staked" : ", unstaked"})` : ""}; its transfers were never enabled, so all of it counts as locked; the lockup period (usually 12 months) runs from the 2020 vote, so it should unlock as soon as transfers are on`,
      });
    }
    return { ...facts, items, holdings, errors };
  }
  if (acc) {
    const r = poolRows(pool, acc, { who: lockup, active: acc.staked_balance !== "0" ? await activePools(ctx).catch((e) => { errors.push(`validators: ${errText(e)}`); return null; }) : null, price, lockup });
    // what comes back from the pool is only free to leave when the lockup is not still holding it as locked
    const free = Math.max(0, ownersN - liquidN);
    for (const i of r.items) if (i.status === "ready" && i.amount > free + DUST) { i.status = "partly_locked"; i.detail += `; ${round(lockedN, 4)} NEAR of the lockup is still locked, so only about ${round(free, 4)} can leave it now`; }
    items.push(...r.items); holdings.push(...r.holdings);
  }
  if (liquidN >= 0.5) {
    items.push({
      category: "vesting", chain: "near", asset: "NEAR", amount: round(liquidN, 4), usd: nearUsd(liquidN, price), protocol: "NEAR lockup", status: "ready",
      action: `transfer the unlocked NEAR out of the lockup ${lockup} to ${owner} (the lockup's transfer method, owner signs; MyNearWallet shows it)`, how_to_claim: STAKE_UI,
      detail: `${round(liquidN, 4)} NEAR in the lockup ${lockup} is unlocked and free to move (the lockup keeps 3.5 NEAR for storage)`,
    });
  }
  if (lockedN >= DUST) holdings.push({ kind: "locked", chain: "near", asset: "NEAR", amount: round(lockedN, 4), usd: nearUsd(lockedN, price), verified: true, protocol: "NEAR lockup", detail: `still locked or vesting in ${lockup}` });
  if (errors.length >= 6) throw { status: 502, error: errors.join("; ") };
  return { ...facts, items, holdings, errors };
}

export const COMPOSE = { nearStaking, nearLockup };

const RPC_URL = "https://rpc.mainnet.fastnear.com";
const EX = "35bdd7062b7c60f8a5dad756943a42b0f52b43e79ac0a04faf79bc38b0366a82"; // ~4,982 NEAR unstaked and withdrawable in astro-stakers (2026-10-22)
const ACCOUNT_RE = "^([0-9a-f]{64}|(([a-z\\d]+[-_])*[a-z\\d]+\\.)+([a-z\\d]+[-_])*[a-z\\d]+)$";
export const ROUTES = [
  { id: "near.rpc", group: "near", method: "POST", url: RPC_URL, body: { jsonrpc: "2.0", id: 1, method: "{method}", params: "{params:list=}" }, auth: null, input: { method: "NEAR JSON-RPC method, e.g. status or validators (compose steps send their own body: query view_account / call_function)", params: "comma list of string params" }, returns: "JSON-RPC answer {result} (query call_function: result.result = the view's JSON as bytes)", note: "FastNEAR's free public RPC (keyless)", example: { method: "status" }, cache: 30 },
  { id: "near.staking_pools", group: "near", method: "GET", url: "https://api.fastnear.com/v1/account/{account_id}/staking", auth: null, pattern: { account_id: ACCOUNT_RE }, input: { account_id: "NEAR account (name.near or 64-hex implicit)" }, returns: "{account_id, pools[] {pool_id, last_update_block_height}} - every staking pool the account has used (balances may be 0 now)", note: "FastNEAR indexer (keyless)", example: { account_id: "root.near" }, cache: 300 },
  { id: "near.staking", group: "near", method: "GET", compose: "nearStaking", uses: ["near.staking_pools", "near.rpc", "token.prices"], url: "(compose: FastNEAR pool index -> get_account on each pool + view_account + validators, priced on DefiLlama coingecko:near)", input: { address: "NEAR account" }, returns: "{pools[], items[] {category unstake_ready, chain near, asset NEAR, amount, usd, protocol (NEAR staking (pool)), status (ready: unstaked and withdrawable | pending: still in the 4-epoch wait | inactive_pool: staked in a pool outside the validator set), action, how_to_claim, detail}, holdings[] (liquid NEAR, stake in active pools), errors[]}", example: { address: EX }, check: "weekly" },
  { id: "near.lockup", group: "near", method: "GET", compose: "nearLockup", uses: ["near.rpc", "token.prices"], url: "(compose: the owner's lockup contract (sha256(owner)[0..20] hex + .lockup.near): owner, transfers enabled, balance, owners / liquid / locked amounts, its staking pool's get_account)", input: { address: "NEAR account (the lockup owner)" }, returns: "{lockup, pool, transfers_enabled, balance, locked, owners_balance, liquid, items[] {category (vesting: unlocked NEAR to transfer out, or transfers never enabled | unstake_ready: the lockup's pool), status, amount, usd, action, detail}, holdings[] (locked NEAR, active stake), errors[]} - lockup null = the account has none", example: { address: "rimrim.near" }, check: "weekly" },
];

export const SCAN = {
  kind: "near", id: "scan.near", compose: "scanNear", label: "NEAR account (64-hex implicit or name.near / name.tg)", chains: ["near"],
  sources: ["near.staking", "near.lockup"],
  returns: "NEAR staking pools (unstaked NEAR ready to withdraw, unstaking still waiting, stake left in pools that stopped validating), the account's lockup contract (unlocked NEAR to transfer out, the lockup's pool, 2020 lockups whose transfers were never enabled), liquid and staked NEAR as holdings",
  example: EX,
};
