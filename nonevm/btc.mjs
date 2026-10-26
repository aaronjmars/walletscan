// nonevm/btc.mjs - Bitcoin addresses (scan.btc): money a Bitcoin address forgot (read 2026-10-22)
//   btc.omni_usdt  USDT on Omni Layer (property 31). Tether stopped issuing and redeeming it on 2025-09-01 without
//                  freezing it (hiddenfunds omni-usdt, $110.9M on 120K addresses): the tokens still move, nobody swaps
//                  them, so the row waits on Tether (team_must_release) and has no price
//   btc.babylon    Babylon BTC stakes whose timelock or unbonding is over and that were never withdrawn (hiddenfunds
//                  babylon-phase1-expired $10.1M, babylon-unbonded-unwithdrawn $1.4M). Two reads: the Babylon staking
//                  API (v2 delegations by staker key; the key from its pubkey lookup, or the taproot output key), and
//                  the chain itself for phase-1 stakes never registered on the Babylon chain: the address's own
//                  staking transactions (OP_RETURN "bbn1" + staker key + provider key + timelock) whose staking output
//                  is still unspent after the timelock, or whose unbonding output is unspent after 1008 blocks
//   btc.balance    the address's BTC (mempool.space), as a holding
// Keyless: mempool.space, Omni Explorer (form POST), staking-api.babylonlabs.io (its v1 delegation reads are geo-blocked,
// so phase 1 is read from the chain; the routes go through PROXY_URL when it is set).
import { pricesOf, trustedPrice } from "../forgotten/anyrpc.mjs";
import { btcAddress } from "./address.mjs";

const MEMPOOL = "https://mempool.space/api";
const BABYLON = "https://staking-api.babylonlabs.io";
const STAKING_APP = "https://btcstaking.babylonlabs.io";
const PHASE1_START = 857000; // phase-1 cap 1 opened at block 857910 (Aug 2024): older transactions hold no Babylon stake
const PHASE1_UNBONDING = 1008; // phase-1 unbonding time in blocks (phase-2 params come with each delegation)
const MAX_PAGES = 12; // 25 transactions a page
const WITHDRAW_VBYTES = 200; // a timelock-path spend of one taproot output to one output, rounded up
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const SAT = 1e8;
const ex = "39pTGXmaYu44LGXpjKEztY9SSdmyGdxMgr"; // holds Omni USDT (health-sweep example)
const STAKER = "bc1ptpd8h6hmk60khjr8cg3538zmxsxvpqcvjq0y6gq3y0nwp3pvk05s97lf38"; // a Babylon stake past its timelock

export const ROUTES = [
  {"id":"btc.address","group":"btc","method":"GET","url":`${MEMPOOL}/address/{address}`,"auth":null,"input":{"address":"Bitcoin address"},"returns":"{address, chain_stats {funded_txo_sum, spent_txo_sum, tx_count}, mempool_stats {...}} - balance in sats = funded_txo_sum - spent_txo_sum","example":{"address":ex},"cache":60},
  {"id":"btc.address_txs","group":"btc","method":"GET","url":`${MEMPOOL}/address/{address}/txs/chain/{after:opt}`,"auth":null,"input":{"address":"Bitcoin address","after":"optional txid: the page after it (25 confirmed transactions a page, newest first)"},"returns":"[] {txid, status {block_height}, vin[] {txid, vout, prevout {scriptpubkey_address, value}}, vout[] {scriptpubkey, scriptpubkey_type, scriptpubkey_address, value}}","example":{"address":ex},"cache":60},
  {"id":"btc.tx","group":"btc","method":"GET","url":`${MEMPOOL}/tx/{txid}`,"auth":null,"pattern":{"txid":"^[0-9a-fA-F]{64}$"},"input":{"txid":"transaction id"},"returns":"{txid, status {confirmed, block_height}, vin[], vout[]}","example":{"txid":"ca86351d5d1a42a98ea597d8ecefdffb221db6fbdf8b22d31e682e18581a17e7"},"cache":300},
  {"id":"btc.outspends","group":"btc","method":"GET","url":`${MEMPOOL}/tx/{txid}/outspends`,"auth":null,"pattern":{"txid":"^[0-9a-fA-F]{64}$"},"input":{"txid":"transaction id"},"returns":"[] per output {spent, txid (the spender), vin, status {block_height}}","example":{"txid":"ca86351d5d1a42a98ea597d8ecefdffb221db6fbdf8b22d31e682e18581a17e7"},"cache":60},
  {"id":"btc.tip","group":"btc","method":"GET","url":`${MEMPOOL}/blocks/tip/height`,"auth":null,"input":{},"returns":"the current block height (a number)","example":{},"cache":60},
  {"id":"btc.fees","group":"btc","method":"GET","url":`${MEMPOOL}/v1/fees/recommended`,"auth":null,"input":{},"returns":"{fastestFee, halfHourFee, hourFee, economyFee, minimumFee} in sat/vB","example":{},"cache":120},
  {"id":"btc.omni_address","group":"btc","method":"POST","form":true,"url":"https://api.omniexplorer.info/v2/address/addr/","body":{"addr":"{address}"},"auth":null,"input":{"address":"Bitcoin address"},"returns":"{<address>: {balance[] {id (property id; 31 = TetherUS), value (willets: 1e-8 for divisible), divisible, frozen, reserved, propertyinfo {name}}}} - only property 31 is the real Omni USDT (other properties copy its name)","example":{"address":ex},"cache":300},
  {"id":"btc.babylon_pubkey","group":"btc","method":"GET","url":`${BABYLON}/v1/staker/pubkey-lookup?address={address}`,"auth":null,"proxy":true,"input":{"address":"taproot or native segwit address that staked on Babylon"},"returns":"{data: {<address>: staker public key (x-only hex)}} - empty data = the API has no key for it","example":{"address":STAKER},"cache":600},
  {"id":"btc.babylon_delegations","group":"btc","method":"GET","url":`${BABYLON}/v2/delegations?staker_pk_hex={pk}&pagination_key={key:opt}`,"auth":null,"proxy":true,"pattern":{"pk":"^[0-9a-fA-F]{64}$"},"input":{"pk":"staker BTC public key (x-only, 64 hex)","key":"optional pagination_key from the last page"},"returns":"{data[] {state (ACTIVE, TIMELOCK_WITHDRAWABLE, EARLY_UNBONDING_WITHDRAWABLE, ..._WITHDRAWN...), delegation_staking {staking_tx_hash_hex, staking_amount (sats), start_height, end_height, staking_timelock}, delegation_unbonding {unbonding_timelock}}, pagination {next_key}} - Babylon phase-2 delegations, phase-1 stakes registered later included","example":{"pk":"39741a6f3e52e718aed94c25cd9bd8d4262f39fd421f6d3313cf2883ba5f3c42"},"cache":120},
  {"id":"btc.omni_usdt","group":"btc","method":"GET","compose":"btcOmniUsdt","uses":["btc.omni_address"],"url":"(compose: Omni Explorer balances of the address, property 31 = TetherUS)","input":{"address":"Bitcoin address"},"returns":"{items[] {category token_migration, chain bitcoin, protocol (Tether USDT on Omni Layer), asset USDT, token omni:31, amount, usd (null: no issuer redeems it), status team, action, detail}, holdings[], errors[]}","example":{"address":ex}},
  {"id":"btc.babylon","group":"btc","method":"GET","compose":"btcBabylon","uses":["btc.babylon_delegations","btc.address_txs","btc.outspends","btc.tip"],"url":"(compose: Babylon v2 delegations of the staker key (pubkey lookup or the taproot key) + the address's own phase-1 staking transactions read on mempool.space: staking or unbonding output unspent after its timelock)","input":{"address":"Bitcoin address that staked on Babylon"},"returns":"{items[] {category unstake_ready, chain bitcoin, protocol (Babylon), asset BTC, amount, usd, status (ready | pending), staking_tx, action, how_to_claim, detail}, holdings[] (active stakes: kind staked; unbonding: kind locked), errors[]}","example":{"address":STAKER}},
  {"id":"btc.balance","group":"btc","method":"GET","compose":"btcBalance","uses":["btc.address"],"url":"(compose: mempool.space address stats, priced on DefiLlama)","input":{"address":"Bitcoin address"},"returns":"{items[], holdings[] {kind token, chain bitcoin, asset BTC, amount, usd, verified}, errors[]}","example":{"address":ex}},
];

const ok = (r) => r && r.ok;
async function need(ctx, id, params) {
  const r = await ctx.call(id, params);
  if (!ok(r)) throw { status: 502, error: `${id} failed (upstream ${r?.status})`, detail: r?.data };
  return r.data;
}
const needBtc = (p) => {
  const a = btcAddress(String(p.address ?? "").trim());
  if (!a) throw { status: 400, error: "address must be a Bitcoin address (1..., 3..., bc1q..., bc1p...)", detail: String(p.address ?? "").slice(0, 64) };
  return a;
};
async function btcPrice(ctx) {
  return trustedPrice(await pricesOf(ctx, ["coingecko:bitcoin"]), "coingecko:bitcoin");
}

// ---- Omni USDT ---------------------------------------------------------------------------------------------
export function omniItems(data, address) {
  const row = data?.[address] || Object.values(data || {})[0];
  const u = (row?.balance || []).find((b) => String(b.id) === "31");
  const amount = u ? Number(u.value) / (u.divisible === false ? 1 : SAT) : 0;
  if (!(amount > 0)) return [];
  const frozen = Number(u.frozen || 0) / SAT;
  return [{
    category: "token_migration", chain: "bitcoin", protocol: "Tether USDT on Omni Layer", asset: "USDT", token: "omni:31", amount: round(amount, 6), usd: null, status: "team",
    action: "nothing to claim onchain: Tether stopped issuing and redeeming USDT on Omni Layer on 2025-09-01 (not frozen), so keep this Bitcoin key and ask Tether (support@tether.to) whether it will swap it; the tokens still move between Omni addresses",
    how_to_claim: "https://tether.to/en/supported-protocols", deadline: null,
    detail: [`${round(amount, 2)} USDT (Omni property 31) on this Bitcoin address, face value $${round(amount, 2)} when Tether still redeemed it; no market price now, so usd is null`,
      frozen > 0 && `${round(frozen, 2)} of it is frozen by the issuer`,
      "other Omni properties named TetherUS are copies, not USDT"].filter(Boolean).join("; "),
  }];
}

export const COMPOSE = {
  async btcOmniUsdt(p, ctx) {
    const a = needBtc(p);
    return { items: omniItems(await need(ctx, "btc.omni_address", { address: a.address }), a.address), holdings: [], errors: [] };
  },

  async btcBalance(p, ctx) {
    const a = needBtc(p);
    const [d, price] = await Promise.all([need(ctx, "btc.address", { address: a.address }), btcPrice(ctx)]);
    const sats = Number(d?.chain_stats?.funded_txo_sum || 0) - Number(d?.chain_stats?.spent_txo_sum || 0);
    if (!(sats > 0)) return { items: [], holdings: [], errors: [] };
    const amount = sats / SAT;
    return { items: [], holdings: [{ kind: "token", chain: "bitcoin", asset: "BTC", amount, usd: price == null ? null : round(amount * price), verified: true, detail: `${d.chain_stats.tx_count} confirmed transactions` }], errors: [] };
  },

  async btcBabylon(p, ctx) {
    const a = needBtc(p);
    // Babylon stakes come only from taproot or native segwit addresses
    if (a.type !== "p2tr" && a.type !== "p2wpkh") return { items: [], holdings: [], errors: [], status: "skipped: Babylon takes only taproot or native segwit addresses" };
    const errors = [];
    // staker keys to ask the API about: its lookup and, for taproot, the output key itself
    const keys = new Set();
    const r = await ctx.call("btc.babylon_pubkey", { address: a.address }).catch(() => null);
    const pk = ok(r) ? r.data?.data?.[a.address] : null;
    if (pk) keys.add(String(pk).toLowerCase());
    else if (!ok(r)) errors.push(`babylon pubkey lookup failed (upstream ${r?.status})`);
    if (a.type === "p2tr") keys.add(a.program);
    const [tip, price, fees] = await Promise.all([
      ctx.call("btc.tip", {}).then((r) => (ok(r) ? Number(r.data) : null)).catch(() => null),
      btcPrice(ctx),
      ctx.call("btc.fees", {}).then((r) => (ok(r) ? Number(r.data?.halfHourFee) : null)).catch(() => null),
    ]);
    const usdOf = (btc) => (price == null ? null : round(btc * price));
    const cost = price != null && fees ? round((WITHDRAW_VBYTES * fees / SAT) * price, 4) : null;
    const items = [], holdings = [], seen = new Set();

    // 1. phase-2 delegations (registered phase-1 stakes too)
    for (const pk of keys) {
      let key = "";
      for (let page = 0; page < 5; page++) {
        const r = await ctx.call("btc.babylon_delegations", { pk, ...(key && { key }) }).catch(() => null);
        if (!ok(r)) { errors.push(`babylon delegations failed (upstream ${r?.status})`); break; }
        for (const d of r.data?.data || []) {
          const st = d.delegation_staking || {}, state = String(d.state || "");
          if (st.staking_tx_hash_hex) seen.add(st.staking_tx_hash_hex);
          const btc = Number(st.staking_amount || 0) / SAT;
          if (!(btc > 0)) continue;
          if (/WITHDRAWABLE$/.test(state)) {
            const slashed = /SLASHING/.test(state);
            items.push({
              category: "unstake_ready", chain: "bitcoin", protocol: "Babylon", asset: "BTC", amount: btc, usd: usdOf(btc), status: slashed ? "slashed" : "ready", staking_tx: st.staking_tx_hash_hex, cost_usd: cost,
              action: slashed ? "withdraw what is left after the slashing in the Babylon staking app (connect this wallet)" : `withdraw the ${state.startsWith("EARLY") ? "unbonded" : "expired"} stake in the Babylon staking app (connect this wallet): the BTC goes back to it`,
              how_to_claim: STAKING_APP, deadline: null,
              detail: [`Babylon delegation ${state.toLowerCase().replace(/_/g, " ")}: ${btc} BTC staked in tx ${st.staking_tx_hash_hex}${st.end_height ? `, timelock ended at block ${st.end_height}` : ""}`, slashed && "the finality provider was slashed: part of the stake is gone, the amount is the stake before slashing", "only the staker key can sign the withdrawal; never give it to a claim site"].filter(Boolean).join("; "),
            });
          } else if (/^(ACTIVE|VERIFIED|PENDING)$/.test(state)) {
            holdings.push({ kind: "staked", chain: "bitcoin", asset: "BTC", amount: btc, usd: usdOf(btc), verified: true, protocol: "Babylon", detail: `${state.toLowerCase()} delegation, tx ${st.staking_tx_hash_hex}${st.end_height ? `, timelock ends at block ${st.end_height}` : ""}` });
          } else if (/UNBONDING$/.test(state)) {
            holdings.push({ kind: "locked", chain: "bitcoin", asset: "BTC", amount: btc, usd: usdOf(btc), verified: true, protocol: "Babylon", detail: `${state.toLowerCase().replace(/_/g, " ")}, tx ${st.staking_tx_hash_hex}: withdrawable once the unbonding time is over` });
          }
        }
        key = r.data?.pagination?.next_key || "";
        if (!key) break;
      }
    }

    // 2. phase-1 stakes on the chain that the API does not list: the address's own staking transactions since phase 1
    {
      const stakes = [];
      let after = "", pages = 0, done = false;
      while (!done && pages < MAX_PAGES) {
        const r = await ctx.call("btc.address_txs", { address: a.address, ...(after && { after }) }).catch(() => null);
        if (!ok(r) || !Array.isArray(r.data)) { errors.push(`address transactions failed (upstream ${r?.status})`); break; }
        pages++;
        for (const t of r.data) {
          const s = phase1Stake(t, a.address);
          if (s) stakes.push(s);
        }
        const last = r.data.at(-1);
        done = r.data.length < 25 || !last || (last.status?.block_height ?? Infinity) < PHASE1_START;
        after = last?.txid;
      }
      if (!done) errors.push(`only the newest ${pages * 25} transactions were checked for Babylon phase-1 stakes`);
      for (const s of stakes.filter((x) => !seen.has(x.txid)).slice(0, 20)) {
        const out = await ctx.call("btc.outspends", { txid: s.txid }).catch(() => null);
        if (!ok(out)) { errors.push(`outspends of ${s.txid.slice(0, 12)} failed`); continue; }
        const spend = out.data?.[s.vout];
        const btc = s.value / SAT;
        if (!spend?.spent) {
          const ends = s.height + s.timelock;
          if (tip != null && tip >= ends) {
            items.push({
              category: "unstake_ready", chain: "bitcoin", protocol: "Babylon (phase 1)", asset: "BTC", amount: btc, usd: usdOf(btc), status: "ready", staking_tx: s.txid, cost_usd: cost,
              action: "withdraw the expired phase-1 stake in the Babylon staking app (connect this wallet): its timelock is over and the BTC is still in the staking output",
              how_to_claim: STAKING_APP, deadline: null,
              detail: `phase-1 staking output ${s.txid}:${s.vout} (${btc} BTC) still unspent; its ${s.timelock}-block timelock ended at block ${ends} (now ${tip}); never registered on the Babylon chain; only the staker key can spend it, never give it to a claim site`,
            });
          } else holdings.push({ kind: "staked", chain: "bitcoin", asset: "BTC", amount: btc, usd: usdOf(btc), verified: true, protocol: "Babylon (phase 1)", detail: `staking output ${s.txid}:${s.vout}, timelock ends at block ${ends}` });
          continue;
        }
        // spent: an early unbonding moves it to a one-output unbonding transaction with its own 1008-block timelock
        const [spender, spOut] = await Promise.all([ctx.call("btc.tx", { txid: spend.txid }).catch(() => null), ctx.call("btc.outspends", { txid: spend.txid }).catch(() => null)]);
        if (!ok(spender) || !ok(spOut)) { errors.push(`spender of ${s.txid.slice(0, 12)} failed`); continue; }
        const st = spender.data;
        if (!(st?.vin?.length === 1 && st?.vout?.length === 1 && st.vout[0].scriptpubkey_type === "v1_p2tr" && st.vout[0].scriptpubkey_address !== a.address) || spOut.data?.[0]?.spent) continue;
        const h = st.status?.block_height, ubtc = Number(st.vout[0].value) / SAT;
        if (h == null) continue;
        const ready = tip != null && tip >= h + PHASE1_UNBONDING;
        if (ready) {
          items.push({
            category: "unstake_ready", chain: "bitcoin", protocol: "Babylon (phase 1)", asset: "BTC", amount: ubtc, usd: usdOf(ubtc), status: "unbonded", staking_tx: s.txid, cost_usd: cost,
            action: "withdraw the unbonded phase-1 stake in the Babylon staking app (connect this wallet): the unbonding time is over and the BTC is still in the unbonding output",
            how_to_claim: STAKING_APP, deadline: null,
            detail: `stake ${s.txid} was unbonded early in tx ${spend.txid} (block ${h}); its output (${ubtc} BTC) is still unspent ${tip - h} blocks later (phase-1 unbonding time ${PHASE1_UNBONDING}); read from the chain, so check it in the app`,
          });
        } else holdings.push({ kind: "locked", chain: "bitcoin", asset: "BTC", amount: ubtc, usd: usdOf(ubtc), verified: true, protocol: "Babylon (phase 1)", detail: `unbonding in tx ${spend.txid}, withdrawable from block ${h + PHASE1_UNBONDING}` });
      }
    }
    return { items, holdings, errors };
  },
};

// a phase-1 Babylon staking transaction sent from `address`: OP_RETURN 6a47 "bbn1" (62626e31) + version + staker key
// + finality provider key + timelock (2 bytes, big endian); the staking output = the first taproot output not paying
// back to an input address
export function phase1Stake(t, address) {
  if (!t?.status?.block_height || t.status.block_height < PHASE1_START) return null;
  const from = new Set((t.vin || []).map((i) => i.prevout?.scriptpubkey_address).filter(Boolean));
  if (!from.has(address)) return null;
  const op = (t.vout || []).find((o) => /^6a4762626e31/.test(o.scriptpubkey || ""));
  if (!op) return null;
  const data = op.scriptpubkey.slice(4);
  const timelock = parseInt(data.slice(8 + 2 + 128, 8 + 2 + 128 + 4), 16);
  const vout = (t.vout || []).findIndex((o) => o.scriptpubkey_type === "v1_p2tr" && !from.has(o.scriptpubkey_address));
  if (vout < 0 || !(timelock > 0)) return null;
  return { txid: t.txid, vout, value: Number(t.vout[vout].value), height: t.status.block_height, timelock, staker_pk: data.slice(10, 74), fp_pk: data.slice(74, 138) };
}

export const SCAN = {
  kind: "bitcoin", id: "scan.btc", compose: "scanBtc", label: "Bitcoin address (1..., 3..., bc1q..., bc1p...)", chains: ["bitcoin"],
  sources: ["btc.omni_usdt", "btc.babylon", "btc.balance"], ms: { "btc.babylon": 60000 },
  returns: "Omni Layer USDT Tether no longer redeems (waits on Tether, no price), Babylon BTC stakes past their timelock or unbonding never withdrawn (staking API + phase-1 stakes read from the chain), BTC balance",
  example: STAKER,
};
