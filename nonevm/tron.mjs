// nonevm/tron.mjs - TRON (kind tron, T... addresses), read 2026-10-22 on TronGrid's keyless API (api.trongrid.io).
// Sources (hiddenfunds.xyz dollars left on TRON):
//   tron.staking  TRX frozen under the old Stake 1.0 whose lock time is over and never unfrozen ($97.1M: `frozen` for
//                 bandwidth, account_resource.frozen_balance_for_energy, and v1 stakes delegated to other accounts),
//                 unclaimed voting rewards ($15.5M: /wallet/getReward, which already includes an SR's `allowance`),
//                 Stake 2.0 unstakes past their 14-day wait never withdrawn (unfrozenV2), plus holdings: TRX, TRX staked
//                 under Stake 2.0 (own and delegated) and unstakes still waiting
//   tron.tokens   TRC20 balances (/v1/accounts trc20 list) priced on DefiLlama: the old Circle USDC
//                 (TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8, $27.9M: Circle no longer mints or redeems it, the token still moves)
//                 as a team-gated row, every other priced token as a holding (verified = a known TRON token)
// Stake 1.0 can no longer be frozen (since April 2023), so every v1 stake left is past its 3-day lock: unfreezing it
// (UnfreezeBalance) gives the TRX back at once. Unfreezing a v1 stake removes the votes it carried, so the rewards are
// listed first: claim them before unfreezing. TRC10 assets (assetV2) are not read: nearly all of them are airdrop spam.
import { pricesOf, trustedPrice, round } from "../forgotten/anyrpc.mjs";

const GRID = "https://api.trongrid.io";
const T_ADDR = "^T[1-9A-HJ-NP-Za-km-z]{33}$";
const SUN = 1e6;
const TRX_PRICE = "coingecko:tron";
export const OLD_USDC = "TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8";
const RESOURCES_URL = "https://tronscan.org/#/wallet/resources";
const VOTES_URL = "https://tronscan.org/#/sr/votes";
const EX = "TMwe5ctHQGPw7GSimLZPooc7SrfsWafHvM"; // Stake 1.0 bandwidth + energy stakes long expired, plus vote rewards

// TRC20 tokens issued by their own teams or TRON's DAO: a priced balance of one of these counts as verified
export const KNOWN_TRC20 = {
  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t: "USDT", TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR: "WTRX", TAFjULxiVgT4qWk6UZwjqwZXTSaGaqnVp4: "BTT",
  TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9: "JST", TSSMHYeV2uE9qYH95DqyoCuNCzEL1NvU3S: "SUN", TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7: "WIN",
  TPYmHEhy5n8TCEfYGqW2rPxsghSfzghPDn: "USDD", TUpMhErZL2fhh4sVNULAbNKLokS4GjC1F4: "TUSD",
};

export const ROUTES = [
  {"id":"tron.account","group":"tron","method":"GET","url":`${GRID}/v1/accounts/{address}`,"auth":null,"pattern":{"address":T_ADDR},"input":{"address":"TRON address (T...)"},"returns":"{data: [] (empty = account never activated) | [{balance (sun), frozen[] {frozen_balance, expire_time} (Stake 1.0 bandwidth), account_resource {frozen_balance_for_energy {frozen_balance, expire_time} (Stake 1.0 energy), delegated_frozen_balance_for_energy, delegated_frozenV2_balance_for_energy}, delegated_frozen_balance_for_bandwidth, delegated_frozenV2_balance_for_bandwidth, frozenV2[] {type, amount} (Stake 2.0), unfrozenV2[] {type, unfreeze_amount, unfreeze_expire_time}, votes[], allowance, trc20[] {<contract>: raw balance}}]} - 1 TRX = 1,000,000 sun","example":{"address":EX},"cache":60},
  {"id":"tron.reward","group":"tron","method":"POST","url":`${GRID}/wallet/getReward`,"body":{"address":"{address}","visible":true},"auth":null,"pattern":{"address":T_ADDR},"input":{"address":"TRON address (T...)"},"returns":"{reward} - voting rewards not withdrawn yet, in sun (an SR's own allowance included); claimed with WithdrawBalance, once per 24 h","example":{"address":EX},"cache":60},
  {"id":"tron.delegated_index","group":"tron","method":"POST","url":`${GRID}/wallet/getdelegatedresourceaccountindex`,"body":{"value":"{address}","visible":true},"auth":null,"pattern":{"address":T_ADDR},"input":{"address":"TRON address (T...)"},"returns":"{account, toAccounts[] (accounts this one delegated Stake 1.0 resources to), fromAccounts[]} - {} when none","example":{"address":"TMPRAmXYchgMvKK5JLiuLKrpcbGo2GsBdM"},"check":"weekly"},
  {"id":"tron.delegated_resource","group":"tron","method":"POST","url":`${GRID}/wallet/getdelegatedresource`,"body":{"fromAddress":"{from}","toAddress":"{to}","visible":true},"auth":null,"pattern":{"from":T_ADDR,"to":T_ADDR},"input":{"from":"TRON address that delegated","to":"TRON address that received"},"returns":"{delegatedResource[] {from, to, frozen_balance_for_bandwidth, expire_time_for_bandwidth, frozen_balance_for_energy, expire_time_for_energy}} - one Stake 1.0 delegation; unfreeze it with UnfreezeBalance + receiver_address","example":{"from":"TMPRAmXYchgMvKK5JLiuLKrpcbGo2GsBdM","to":"TNXoiAJ3dct8Fjg4M9fkLFh9S2v9TXc32G"},"check":"weekly"},
  {"id":"tron.staking","group":"tron","method":"GET","compose":"tronStaking","uses":["tron.account","tron.reward","tron.delegated_index","tron.delegated_resource","token.prices"],"url":"(compose: TronGrid /v1/accounts + /wallet/getReward (+ the Stake 1.0 delegation index when the wallet delegated), priced on DefiLlama)","input":{"address":"TRON address (T...)"},"returns":"{items[] (unstake_ready: Stake 1.0 bandwidth / energy / delegated stakes past their lock, Stake 2.0 unstakes past the 14-day wait; reward: voting rewards not withdrawn), holdings[] (TRX, Stake 2.0 staked, unstakes still waiting), errors[]}","example":{"address":EX}},
  {"id":"tron.tokens","group":"tron","method":"GET","compose":"tronTokens","uses":["tron.account","token.prices"],"url":"(compose: TronGrid /v1/accounts trc20 balances priced on DefiLlama)","input":{"address":"TRON address (T...)"},"returns":"{items[] (token_migration: the old Circle USDC TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8, no longer redeemed), holdings[] (priced TRC20, verified = a known TRON token), errors[]}","example":{"address":"TYDzsYUEpvnYmQk4zGP9sWWcTEd2MiAtW6"}},
];

export const SCAN = {
  kind: "tron", id: "scan.tron", compose: "scanTron", label: "TRON address (T...)", chains: ["tron"], sources: ["tron.staking", "tron.tokens"],
  returns: "Stake 1.0 TRX past its lock never unfrozen (own bandwidth / energy and delegated), voting rewards not withdrawn, Stake 2.0 unstakes past the 14-day wait, the old Circle USDC on TRON (no longer redeemed), TRX + Stake 2.0 + priced TRC20 holdings",
  example: EX,
};

const day = (ms) => new Date(Number(ms)).toISOString().slice(0, 10);
const needTron = (p) => {
  if (!new RegExp(T_ADDR).test(String(p.address || ""))) throw { status: 400, error: "address must be a TRON address (T...)", detail: String(p.address ?? "").slice(0, 64) };
};
async function account(p, ctx) {
  needTron(p);
  const r = await ctx.call("tron.account", { address: p.address });
  if (!r.ok || !Array.isArray(r.data?.data)) throw { status: 502, error: `TronGrid account read failed (upstream ${r.status})`, detail: r.data };
  return r.data.data[0] || null;
}
const trx = (sun) => Number(sun || 0) / SUN;

// Stake 1.0 receivers of this wallet's delegations, with their own lock time (at most 8 read)
async function delegations(address, ctx) {
  const ix = await ctx.call("tron.delegated_index", { address }).catch(() => null);
  const to = (ix?.ok && ix.data?.toAccounts) || [];
  const rows = await Promise.all(to.slice(0, 8).map((t) => ctx.call("tron.delegated_resource", { from: address, to: t }).then((r) => (r.ok ? r.data?.delegatedResource || [] : []), () => [])));
  return { receivers: rows.flat(), more: Math.max(0, to.length - 8) };
}

export const COMPOSE = {
  async tronStaking(p, ctx) {
    const a = await account(p, ctx);
    if (!a) return { items: [], holdings: [], errors: [] };
    const now = Date.now(), items = [], holdings = [], errors = [];
    const [rw, px] = await Promise.all([ctx.call("tron.reward", { address: p.address }).catch((e) => ({ ok: false, status: e?.status, data: e })), pricesOf(ctx, [TRX_PRICE])]);
    const price = trustedPrice(px, TRX_PRICE), usd = (n) => (price == null ? null : round(n * price));
    const base = { chain: "tron", asset: "TRX", protocol: "TRON staking" };

    // voting rewards (an SR's allowance included)
    if (rw.ok && rw.data?.reward != null) {
      const n = trx(rw.data.reward);
      if (n > 0) items.push({
        ...base, category: "reward", amount: round(n, 6), usd: usd(n), status: "ready",
        action: "claim the TRX voting rewards (WithdrawBalance: Tronscan or TronLink, Vote > Claim rewards; once every 24 h)", how_to_claim: VOTES_URL,
        detail: [`${round(n, 4)} TRX of voting rewards never withdrawn`, Number(a.allowance) > 0 && `${round(trx(a.allowance), 4)} TRX of it is the account's own SR allowance`, a.latest_withdraw_time && `last withdrawn ${day(a.latest_withdraw_time)}`, (a.frozen?.length || a.account_resource?.frozen_balance_for_energy) && "claim these before unfreezing the Stake 1.0 TRX below: unfreezing removes the votes"].filter(Boolean).join("; "),
      });
    } else errors.push(`tron.reward: upstream ${rw.status ?? "error"}`);

    // Stake 1.0, own: bandwidth (frozen[]) and energy
    const v1 = [...(a.frozen || []).map((f) => ({ ...f, resource: "BANDWIDTH" })), ...(a.account_resource?.frozen_balance_for_energy?.frozen_balance ? [{ ...a.account_resource.frozen_balance_for_energy, resource: "ENERGY" }] : [])];
    for (const f of v1) {
      const n = trx(f.frozen_balance);
      if (!(n > 0)) continue;
      if (Number(f.expire_time) <= now) items.push({
        ...base, category: "unstake_ready", amount: round(n, 6), usd: usd(n), status: "ready",
        action: `unfreeze the Stake 1.0 ${f.resource.toLowerCase()} stake (UnfreezeBalance, resource ${f.resource}: Tronscan Resources or TronLink, Stake 1.0 > Unfreeze); the TRX is back at once`, how_to_claim: RESOURCES_URL,
        detail: `${round(n, 4)} TRX frozen for ${f.resource.toLowerCase()} under the old Stake 1.0, lock over since ${day(f.expire_time)}, never unfrozen`,
      });
      else holdings.push({ ...base, kind: "locked", amount: round(n, 6), usd: usd(n), verified: true, detail: `Stake 1.0 ${f.resource.toLowerCase()} stake, lock ends ${day(f.expire_time)}` });
    }
    // Stake 1.0 delegated to other accounts
    const dBw = trx(a.delegated_frozen_balance_for_bandwidth), dEn = trx(a.account_resource?.delegated_frozen_balance_for_energy), dn = dBw + dEn;
    if (dn > 0) {
      const { receivers, more } = await delegations(p.address, ctx);
      const list = receivers.flatMap((r) => [
        Number(r.frozen_balance_for_bandwidth) > 0 && `${round(trx(r.frozen_balance_for_bandwidth), 4)} TRX bandwidth to ${r.to} (lock over ${day(r.expire_time_for_bandwidth)})`,
        Number(r.frozen_balance_for_energy) > 0 && `${round(trx(r.frozen_balance_for_energy), 4)} TRX energy to ${r.to} (lock over ${day(r.expire_time_for_energy)})`,
      ]).filter(Boolean);
      items.push({
        ...base, category: "unstake_ready", amount: round(dn, 6), usd: usd(dn), status: "ready",
        action: "unfreeze each Stake 1.0 delegation (UnfreezeBalance with the receiver_address: Tronscan Resources, Stake 1.0 delegations); the TRX comes back to this wallet", how_to_claim: RESOURCES_URL,
        detail: [`${round(dn, 4)} TRX frozen under the old Stake 1.0 and delegated to other accounts (${round(dBw, 4)} bandwidth, ${round(dEn, 4)} energy), never unfrozen; Stake 1.0 locks were 3 days and new ones stopped in April 2023`, list.length && list.join("; "), more && `${more} more receivers`].filter(Boolean).join("; "),
      });
    }

    // Stake 2.0 unstakes: past the wait = withdraw, else still waiting
    const ready = (a.unfrozenV2 || []).filter((u) => Number(u.unfreeze_expire_time) <= now), waiting = (a.unfrozenV2 || []).filter((u) => Number(u.unfreeze_expire_time) > now);
    const rn = ready.reduce((t, u) => t + trx(u.unfreeze_amount), 0);
    if (rn > 0) items.push({
      ...base, category: "unstake_ready", amount: round(rn, 6), usd: usd(rn), status: "ready",
      action: "withdraw the unstaked TRX (WithdrawExpireUnfreeze: Tronscan Resources or TronLink, Stake 2.0 > Withdraw)", how_to_claim: RESOURCES_URL,
      detail: `${round(rn, 4)} TRX unstaked under Stake 2.0, wait over since ${day(Math.min(...ready.map((u) => Number(u.unfreeze_expire_time))))} (${ready.length} unstake${ready.length > 1 ? "s" : ""}), never withdrawn`,
    });
    for (const u of waiting) holdings.push({ ...base, kind: "locked", amount: round(trx(u.unfreeze_amount), 6), usd: usd(trx(u.unfreeze_amount)), verified: true, detail: `Stake 2.0 unstake, withdrawable from ${day(u.unfreeze_expire_time)}` });

    // holdings: TRX and Stake 2.0 stakes (own + delegated out)
    const liquid = trx(a.balance);
    if (liquid > 0) holdings.push({ kind: "token", chain: "tron", asset: "TRX", amount: round(liquid, 6), usd: usd(liquid), verified: true });
    const staked = (a.frozenV2 || []).reduce((t, f) => t + trx(f.amount), 0) + trx(a.delegated_frozenV2_balance_for_bandwidth) + trx(a.account_resource?.delegated_frozenV2_balance_for_energy);
    if (staked > 0) holdings.push({ ...base, kind: "staked", amount: round(staked, 6), usd: usd(staked), verified: true, detail: "Stake 2.0 (own and delegated): unstaking takes 14 days" });
    return { items, holdings, errors };
  },

  async tronTokens(p, ctx) {
    const a = await account(p, ctx);
    const bal = new Map();
    for (const o of a?.trc20 || []) for (const [c, raw] of Object.entries(o)) if (/^\d+$/.test(String(raw)) && BigInt(raw) > 0n) bal.set(c, String(raw));
    if (!bal.size) return { items: [], holdings: [], errors: [] };
    // spam lists run long: the known tokens first, then the rest up to 180 priced in one go
    const list = [...bal.keys()].sort((x, y) => Number(!(x in KNOWN_TRC20) && x !== OLD_USDC) - Number(!(y in KNOWN_TRC20) && y !== OLD_USDC)).slice(0, 180);
    const px = await pricesOf(ctx, list.map((c) => `tron:${c}`));
    const items = [], holdings = [];
    for (const c of list) {
      const coin = px.get(`tron:${c}`.toLowerCase()), dec = coin?.decimals ?? (c === OLD_USDC || c === "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t" ? 6 : null);
      if (dec == null) continue; // no decimals known = no price either: an unknown token is left out
      const amount = Number(BigInt(bal.get(c))) / 10 ** Number(dec), price = trustedPrice(px, `tron:${c}`);
      if (c === OLD_USDC) {
        items.push({
          category: "token_migration", chain: "tron", asset: "USDC", token: c, amount: round(amount, 6), usd: price == null ? null : round(amount * price), protocol: "Circle USDC (TRC20)", status: "team",
          action: "no redeem: Circle stopped minting and redeeming USDC on TRON, so a 1:1 cash-out waits until the Circle team acts; the token still moves, so it can be sold or swapped on a TRON DEX while a market lasts",
          how_to_claim: `https://tronscan.org/#/token20/${c}`,
          detail: `${round(amount, 4)} of the old USDC on TRON (${c}); ${price == null ? "no trusted market price" : `DefiLlama price ${round(price, 4)}`}`,
        });
        continue;
      }
      if (price == null) continue;
      holdings.push({ kind: "token", chain: "tron", asset: KNOWN_TRC20[c] || coin.symbol || c, token: c, amount: round(amount, 6), usd: round(amount * price), verified: c in KNOWN_TRC20 });
    }
    return { items, holdings, errors: [] };
  },
};
