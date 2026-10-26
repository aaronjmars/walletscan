// nonevm/dot.mjs - Polkadot and Kusama (scan.dot, address kind "polkadot"): one SS58 account is read on both networks,
// whatever prefix it was pasted with (read 2026-10-22).
// Since the 2025 Asset Hub migration, staking, nomination pools and balances live on Polkadot Asset Hub and Kusama
// Asset Hub (the relay chains' Staking and System storage is empty), so every read goes to Parity's public Asset Hub
// RPCs through rewards.dot_rpc, as state_queryStorageAt batches (keys built in nonevm/dot-scale.mjs).
//   dot.staking   unbonded DOT / KSM never withdrawn: Staking.Ledger unlocking chunks whose era is at or before
//                 Staking.ActiveEra (withdrawUnbonded), and NominationPools.PoolMembers unbonding_eras that are ready
//                 (pool withdrawUnbonded), pool points turned into DOT / KSM with SubPoolsStorage; the bonded and the
//                 still-unbonding parts are holdings (staked / locked)
//   dot.balances  transferable DOT / KSM (System.Account: free less the part frozen beyond what is held), and the
//                 Kusama Asset Hub USDT (asset 1984) Tether no longer redeems (a team-gated row, no price)
import { ss58 } from "./address.mjs";
import { storageKey, twox64Concat, blake2_128Concat, u32le, decodeLedger, decodePoolMember, decodeSubPools, decodeAccount, decodeActiveEra, decodeAssetBalance } from "./dot-scale.mjs";
import { pricesOf, trustedPrice, round } from "../forgotten/anyrpc.mjs";

export const NETS = {
  polkadot: { symbol: "DOT", decimals: 10, price: "coingecko:polkadot", name: "Polkadot", rpc: "wss%3A%2F%2Fpolkadot-asset-hub-rpc.polkadot.io" },
  kusama: { symbol: "KSM", decimals: 12, price: "coingecko:kusama", name: "Kusama", rpc: "wss%3A%2F%2Fkusama-asset-hub-rpc.polkadot.io" },
};
const DASHBOARD = "https://staking.polkadot.cloud";
const pjs = (net, page) => `https://polkadot.js.org/apps/?rpc=${NETS[net].rpc}#/${page}`;
const KSM_USDT = 1984; // Tether USDT on Kusama Asset Hub: Tether stopped issuing and redeeming it
const units = (raw, net) => Number(raw) / 10 ** NETS[net].decimals;

function needSs58(p) {
  const a = ss58(String(p.address ?? "").trim());
  if (!a) throw { status: 400, error: "address must be a Polkadot / Kusama SS58 address" };
  return a.account.slice(2);
}

// one state_queryStorageAt on a network's Asset Hub -> Map(key -> hex value or null)
async function query(ctx, net, keys) {
  const r = await ctx.call("rewards.dot_rpc", { chain: net }, { body: { jsonrpc: "2.0", id: 1, method: "state_queryStorageAt", params: [keys] } });
  if (!r.ok || r.data?.error || !Array.isArray(r.data?.result)) throw { status: 502, error: `${net} Asset Hub read failed (upstream ${r.status})`, detail: r.data?.error || r.data };
  return new Map((r.data.result[0]?.changes || []).map(([k, v]) => [k, v]));
}

// ledger + pool member of one account on one network
async function stakingOn(ctx, net, acc) {
  const K = {
    era: storageKey("Staking", "ActiveEra"), bonded: storageKey("Staking", "Bonded", twox64Concat(acc)),
    ledger: storageKey("Staking", "Ledger", blake2_128Concat(acc)), member: storageKey("NominationPools", "PoolMembers", twox64Concat(acc)),
  };
  const got = await query(ctx, net, Object.values(K));
  const era = decodeActiveEra(got.get(K.era));
  if (era == null) throw { status: 502, error: `${net} Asset Hub has no Staking.ActiveEra` };
  // a stash with a separate (legacy) controller keeps its ledger under the controller
  const controller = got.get(K.bonded) ? got.get(K.bonded).slice(-64) : null;
  const member = got.get(K.member) ? decodePoolMember(got.get(K.member)) : null;
  const more = [];
  const ctrlKey = controller && controller !== acc ? storageKey("Staking", "Ledger", blake2_128Concat(controller)) : null;
  if (ctrlKey) more.push(ctrlKey);
  const subKey = member?.unbonding.length ? storageKey("NominationPools", "SubPoolsStorage", twox64Concat(u32le(member.pool_id))) : null;
  if (subKey) more.push(subKey);
  const got2 = more.length ? await query(ctx, net, more) : new Map();
  const ledgerHex = ctrlKey ? got2.get(ctrlKey) : got.get(K.ledger);
  const ledger = ledgerHex ? decodeLedger(ledgerHex) : null;
  const sub = subKey && got2.get(subKey) ? decodeSubPools(got2.get(subKey)) : null;
  return { net, era, ledger, controller: ctrlKey ? controller : null, member, sub };
}

// pool points of an unbonding era -> balance: that era's unbond pool, or the merged no_era pool once it aged out
function poolBalance(sub, era, points) {
  const pool = sub?.with_era.get(era) || sub?.no_era;
  if (!pool || !(pool.points > 0n)) return { raw: points, exact: false };
  return { raw: (points * pool.balance) / pool.points, exact: true };
}

export async function dotStaking(p, ctx) {
  const acc = needSs58(p);
  const errors = [], reads = [];
  await Promise.all(Object.keys(NETS).map((n) => stakingOn(ctx, n, acc).then((x) => reads.push(x), (e) => errors.push(`${n}: ${e?.error || e?.message || e}`))));
  if (!reads.length) throw { status: 502, error: errors.join("; ") };
  const nets = Object.keys(NETS);
  reads.sort((a, b) => nets.indexOf(a.net) - nets.indexOf(b.net));
  const busy = reads.filter((r) => r.ledger || r.member);
  if (!busy.length) return { items: [], holdings: [], errors };
  const px = await pricesOf(ctx, busy.map((r) => NETS[r.net].price));
  const items = [], holdings = [];
  for (const r of busy) {
    const n = NETS[r.net], price = trustedPrice(px, n.price), usd = (amt) => (price == null ? null : round(amt * price));
    if (r.ledger) {
      const ready = r.ledger.unlocking.filter((c) => c.era <= r.era), wait = r.ledger.unlocking.filter((c) => c.era > r.era);
      const amt = units(ready.reduce((t, c) => t + c.value, 0n), r.net);
      if (amt > 0) items.push({
        category: "unstake_ready", chain: r.net, protocol: `${n.name} staking`, asset: n.symbol, amount: round(amt, 6), usd: usd(amt), status: "ready",
        action: `withdraw it: staking.withdrawUnbonded on ${n.name} Asset Hub${r.controller ? " signed by the controller account" : ""} (Staking Dashboard: Unlocks, Withdraw)`,
        how_to_claim: DASHBOARD,
        detail: [`${round(amt, 4)} ${n.symbol} finished unbonding (unlock era ${ready.map((c) => c.era).join(", ")}, active era ${r.era}) and was never withdrawn: it stays held in staking until a withdrawUnbonded`,
          r.controller && "the ledger sits under a separate controller account", `or Polkadot-JS: ${pjs(r.net, "staking")}`].filter(Boolean).join("; "),
      });
      const active = units(r.ledger.active, r.net), waiting = units(wait.reduce((t, c) => t + c.value, 0n), r.net);
      if (active > 0) holdings.push({ kind: "staked", chain: r.net, asset: n.symbol, amount: round(active, 6), usd: usd(active), verified: true, protocol: `${n.name} staking`, detail: `bonded on ${n.name} Asset Hub` });
      if (waiting > 0) holdings.push({ kind: "locked", chain: r.net, asset: n.symbol, amount: round(waiting, 6), usd: usd(waiting), verified: true, protocol: `${n.name} staking`, detail: `unbonding until era ${Math.max(...wait.map((c) => c.era))} (active era ${r.era})` });
    }
    if (r.member) {
      const m = r.member, ready = m.unbonding.filter((c) => c.era <= r.era), wait = m.unbonding.filter((c) => c.era > r.era);
      const conv = ready.map((c) => poolBalance(r.sub, c.era, c.points));
      const amt = units(conv.reduce((t, c) => t + c.raw, 0n), r.net);
      if (amt > 0) items.push({
        category: "unstake_ready", chain: r.net, protocol: `${n.name} nomination pool ${m.pool_id}`, asset: n.symbol, amount: round(amt, 6), usd: usd(amt), status: "ready",
        action: `withdraw it: nominationPools.withdrawUnbonded for this account on ${n.name} Asset Hub (Staking Dashboard: Pools, Withdraw)`,
        how_to_claim: DASHBOARD,
        detail: [`${round(amt, 4)} ${n.symbol} left pool ${m.pool_id} (unbond era ${ready.map((c) => c.era).join(", ")}, active era ${r.era}) and was never withdrawn`,
          conv.some((c) => !c.exact) && "pool points counted 1:1 (the unbond pool was not readable)", `or Polkadot-JS: ${pjs(r.net, "staking/pools")}`].filter(Boolean).join("; "),
      });
      const bonded = units(m.points, r.net), waiting = units(wait.reduce((t, c) => t + poolBalance(r.sub, c.era, c.points).raw, 0n), r.net);
      if (bonded > 0) holdings.push({ kind: "staked", chain: r.net, asset: n.symbol, amount: round(bonded, 6), usd: usd(bonded), verified: true, protocol: `${n.name} nomination pool ${m.pool_id}`, detail: "pool points, about 1:1 with the bonded balance" });
      if (waiting > 0) holdings.push({ kind: "locked", chain: r.net, asset: n.symbol, amount: round(waiting, 6), usd: usd(waiting), verified: true, protocol: `${n.name} nomination pool ${m.pool_id}`, detail: `unbonding until era ${Math.max(...wait.map((c) => c.era))} (active era ${r.era})` });
    }
  }
  return { items, holdings, errors };
}

export async function dotBalances(p, ctx) {
  const acc = needSs58(p);
  const errors = [], reads = [];
  await Promise.all(Object.keys(NETS).map(async (net) => {
    const K = { account: storageKey("System", "Account", blake2_128Concat(acc)), ...(net === "kusama" && { usdt: storageKey("Assets", "Account", blake2_128Concat(u32le(KSM_USDT)), blake2_128Concat(acc)) }) };
    try {
      const got = await query(ctx, net, Object.values(K));
      reads.push({ net, account: got.get(K.account) ? decodeAccount(got.get(K.account)) : null, usdt: K.usdt && got.get(K.usdt) ? decodeAssetBalance(got.get(K.usdt)) : 0n });
    } catch (e) { errors.push(`${net}: ${e?.error || e?.message || e}`); }
  }));
  if (!reads.length) throw { status: 502, error: errors.join("; ") };
  const nets = Object.keys(NETS);
  reads.sort((a, b) => nets.indexOf(a.net) - nets.indexOf(b.net));
  const held = reads.filter((r) => r.account && r.account.free > 0n);
  const px = held.length ? await pricesOf(ctx, held.map((r) => NETS[r.net].price)) : new Map();
  const holdings = [], items = [];
  for (const r of held) {
    const n = NETS[r.net], a = r.account, lockedBeyondHeld = a.frozen > a.reserved ? a.frozen - a.reserved : 0n;
    const amt = units(a.free > lockedBeyondHeld ? a.free - lockedBeyondHeld : 0n, r.net), price = trustedPrice(px, n.price);
    if (amt > 0) holdings.push({ kind: "token", chain: r.net, asset: n.symbol, amount: round(amt, 6), usd: price == null ? null : round(amt * price), verified: true, detail: `transferable on ${n.name} Asset Hub (free less the frozen part)` });
  }
  for (const r of reads.filter((x) => x.usdt > 0n)) {
    const amt = Number(r.usdt) / 1e6;
    items.push({
      category: "token_migration", chain: r.net, protocol: "Tether USDT (Kusama Asset Hub)", asset: "USDT", token: String(KSM_USDT), amount: round(amt, 6), usd: null, status: "team",
      action: "nothing to swap it for now: Tether stopped issuing and redeeming USDT on Kusama Asset Hub; the token still transfers, so it waits until the Tether team acts (or a buyer takes it)",
      how_to_claim: "https://tether.to",
      detail: `${round(amt, 2)} USDT (asset ${KSM_USDT}) on Kusama Asset Hub, face value ${round(amt, 2)} USD, left out of usd: no issuer redeems it and no trusted market price`,
    });
  }
  return { items, holdings, errors };
}

export const COMPOSE = { dotStaking, dotBalances };

const P = "15yiZ3kjLHbM4ffUy9AP9snzVMtQi9hmoJih6QL8otCZ3hFZ"; // ~160,192 DOT unbonded at era 769, never withdrawn (2026-10-22)
export const ROUTES = [
  {"id":"dot.staking","group":"dot","method":"GET","compose":"dotStaking","uses":["rewards.dot_rpc","token.prices"],"url":"(compose: Staking.ActiveEra, Bonded, Ledger and NominationPools.PoolMembers (+ SubPoolsStorage) of the account on Polkadot Asset Hub and Kusama Asset Hub, state_queryStorageAt, priced on DefiLlama)","input":{"address":"Polkadot / Kusama SS58 address (any prefix: the same account is read on both networks)"},"returns":"{items[] {category unstake_ready, chain (polkadot | kusama), protocol (Polkadot staking | Kusama nomination pool N...), asset (DOT | KSM), amount, usd, status ready, action (withdrawUnbonded), how_to_claim (Staking Dashboard), detail}, holdings[] {kind (staked | locked), chain, asset, amount, usd, protocol, detail}, errors[]} - unbonding finished (unlock era at or before the active era) but never withdrawn","example":{"address":P},"check":"weekly"},
  {"id":"dot.balances","group":"dot","method":"GET","compose":"dotBalances","uses":["rewards.dot_rpc","token.prices"],"url":"(compose: System.Account on Polkadot Asset Hub and Kusama Asset Hub + Assets.Account of USDT (asset 1984) on Kusama Asset Hub)","input":{"address":"Polkadot / Kusama SS58 address"},"returns":"{holdings[] {kind token, chain, asset (DOT | KSM), amount (transferable: free less the frozen part beyond held funds), usd, verified}, items[] {category token_migration, chain kusama, asset USDT, amount, usd null, status team, action, detail} (Kusama Asset Hub USDT Tether no longer redeems), errors[]}","example":{"address":P},"check":"weekly"},
];

export const SCAN = {
  kind: "polkadot", id: "scan.dot", compose: "scanDot", chains: ["polkadot", "kusama"], sources: ["dot.staking", "dot.balances"],
  label: "Polkadot / Kusama SS58 address (1..., C..., 5...)", example: P,
  returns: "unbonded DOT / KSM never withdrawn (staking ledgers and nomination pools, Polkadot and Kusama Asset Hub), bonded and unbonding stake, transferable DOT / KSM, Kusama Asset Hub USDT Tether no longer redeems",
};
