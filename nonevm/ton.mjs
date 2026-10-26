// nonevm/ton.mjs - TON (scan.ton): UTONIC uTON restaking money and plain balances, read keyless on tonapi.io
// (anonymous tier, about 1 call a second: every call here goes one after another).
//
// ton.utonic (read 2026-10-22 from the UTONIC app bundle, utonic.org static/js/main.*.js):
//   uTON jetton master EQAfF5j3... (0:1f1798f7...) get_minter_data -> [totalSupply, lastPriceDay, lastPrice, priceInc]:
//   the app prices 1 uTON at (lastPrice + priceInc x (days since 1970 - lastPriceDay)) / 1e9 TON, a price that only
//   grows. Unstaking burns uTON: the TON withdrawal proxy EQA4xu7S... (0:38c6eed2...) then holds one withdraw
//   contract per burn: the wallet's uTON jetton wallet get_complete_wallet_data -> [balance, withdrawals count, ...],
//   proxy get_withdraw_address(owner, index) -> the contract, its get_withdraw_data -> [id, uTON, TON, burn time,
//   unlock time (burn + 3 days), burn price, finished]. After the unlock the owner presses Claim in the app; the app
//   only lets a claim through when the proxy's TON balance minus the claim stays at 1 TON or more ("Insufficient TON
//   reserve, please wait for a refill"). On 2026-10-22 the proxy held 9 TON while 2.95M uTON were out: claims
//   bigger than that wait on the team, so those rows are hints (low, team_must_release) priced at the app's price.
//   uTON has no market (tonapi rates 0): its only value is that redemption.
// ton.holdings: TON balance (DefiLlama coingecko:the-open-network) and jettons tonapi lists with a price; only
//   whitelisted jettons count as verified, unpriced jettons not on the whitelist are left out (airdropped spam).
import { addressKind } from "./address.mjs";
import { pricesOf, trustedPrice } from "../forgotten/anyrpc.mjs";

const TONAPI = "https://tonapi.io/v2";
export const UTON = { master: "0:1f1798f724c2296652e6002bfb51bed11fb5a689532e5788af7203581ef367a8", proxy: "0:38c6eed2bf0e0a45fe1bad4caeec5a56f9acbcf91945b6a8ca6a0709c7348509", app: "https://utonic.org" };
const TON_PRICE = "coingecko:the-open-network";
const RESERVE_MIN = 1e9; // nanoTON the app keeps in the proxy after a claim
const MAX_WITHDRAWALS = 16; // newest withdraw contracts read per wallet (2 calls each at ~1/s)
const PROOF = { withdrawals: "0:307220f8da037ced06a53ae3374835d2443308aa7623be4f6ab0452cead5a3ab", holder: "0:0b988dba1f04d5a2a23dfae802fab33297a6cd015cbb4769d8607b636442def8" };

const ADDR = "^(-1|0):[0-9a-fA-F]{64}$|^[A-Za-z0-9_-]{48}$";
export const ROUTES = [
  {"id":"ton.account","group":"ton","method":"GET","url":`${TONAPI}/accounts/{address}`,"auth":null,"pattern":{"address":ADDR},"input":{"address":"TON address (raw 0:<hex> or EQ... / UQ...)"},"returns":"{address (raw), balance (nanoTON), status (active | uninit | nonexist | frozen), interfaces[], is_wallet}","example":{"address":PROOF.withdrawals},"check":"daily","cache":60,"retry":4},
  {"id":"ton.jettons","group":"ton","method":"GET","url":`${TONAPI}/accounts/{address}/jettons?currencies=usd`,"auth":null,"pattern":{"address":ADDR},"input":{"address":"TON address"},"returns":"{balances[] {balance (raw), price.prices.USD, wallet_address.address, jetton {address, name, symbol, decimals, verification (whitelist | none | blacklist)}}}","example":{"address":PROOF.holder},"check":"daily","cache":60,"retry":4},
  {"id":"ton.method","group":"ton","method":"GET","url":`${TONAPI}/blockchain/accounts/{address}/methods/{method}?args={arg1:opt}&args={arg2:opt}`,"auth":null,"pattern":{"address":ADDR,"method":"^[a-z_][a-z0-9_]*$"},"input":{"address":"contract address","method":"get method name, e.g. get_jetton_data","arg1":"optional first argument (an address becomes a slice, a number an int)","arg2":"optional second argument"},"returns":"{success, exit_code, stack[] {type num | cell | slice, num (hex) | cell (BOC hex)}, decoded?} - HTTP 404 {error: entity not found} = no such contract","example":{"address":UTON.master,"method":"get_minter_data"},"check":"daily","cache":30,"retry":4},
  {"id":"ton.utonic","group":"ton","method":"GET","compose":"tonUtonic","uses":["ton.method","ton.account","token.prices"],"url":"(compose: uTON master get_minter_data (the app's price) + get_wallet_address, the jetton wallet's get_complete_wallet_data (balance, burn count), then for each burn the TON proxy's get_withdraw_address + get_withdraw_data, and the proxy's TON balance (the claim reserve))","input":{"address":"TON address"},"returns":"{items[] {category unstake_ready, chain ton, protocol UTONIC, asset (uTON | TON), amount, usd, status (ready: claim now | pending: 3-day unlock or burn first | hint: the proxy reserve is short, waits on the team), action, how_to_claim, detail, withdraw_contract, unlocks}, price_ton (TON per uTON), reserve_ton, errors[]}","example":{"address":PROOF.withdrawals},"check":"weekly"},
  {"id":"ton.holdings","group":"ton","method":"GET","compose":"tonHoldings","uses":["ton.account","ton.jettons","token.prices"],"url":"(compose: tonapi account balance + jettons with tonapi USD prices, TON priced on DefiLlama)","input":{"address":"TON address"},"returns":"{items[], holdings[] {kind token, chain ton, asset, token (jetton master), amount, usd, verified (TON, or a whitelisted jetton), detail}, errors[]} - uTON is left to ton.utonic","example":{"address":PROOF.holder},"check":"weekly"},
];

// ---- small TON readers ------------------------------------------------------------------------------------------
const need = (p) => {
  const k = addressKind(p.address);
  if (!k || k.kind !== "ton") throw { status: 400, error: "address must be a TON address (EQ... / UQ... or 0:<hex>)", detail: String(p.address ?? "").slice(0, 64) };
  return k.address;
};
const big = (x) => (x?.num == null ? null : x.num.startsWith("-") ? -BigInt(x.num.slice(1)) : BigInt(x.num));
const day = (s) => (s ? new Date(Number(s) * 1000).toISOString().slice(0, 10) : null);
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const nano = (v) => Number(v) / 1e9;

// the address in a one-cell BOC (hex) holding a MsgAddressInt (addr_std: tag 10, anycast 0, workchain int8, 256-bit hash)
export function cellAddress(hex) {
  const b = Buffer.from(String(hex), "hex");
  if (b.length < 44 || b.readUInt32BE(0) !== 0xb5ee9c72) return null;
  const size = b[4] & 7, off = b[5];
  let i = 6 + 3 * size + off + size + (b[4] & 0x80 ? size : 0);
  const bits = [...b.subarray(i + 2, i + 2 + Math.ceil(b[i + 1] / 2))].map((x) => x.toString(2).padStart(8, "0")).join("");
  if (bits.slice(0, 3) !== "100") return null;
  const wc = parseInt(bits.slice(3, 11), 2);
  return `${wc > 127 ? wc - 256 : wc}:${BigInt(`0b${bits.slice(11, 267)}`).toString(16).padStart(64, "0")}`;
}

// one get method: the stack, or null when the contract does not exist (404) or the method failed (exit code)
async function method(ctx, address, name, args = []) {
  const r = await ctx.call("ton.method", { address, method: name, ...(args[0] != null && { arg1: String(args[0]) }), ...(args[1] != null && { arg2: String(args[1]) }) });
  if (r.status === 404) return null;
  if (!r.ok) throw { status: 502, error: `ton ${name} failed (upstream ${r.status})`, detail: r.data };
  if (!r.data?.success) return null;
  return r.data;
}

// ---- ton.utonic -------------------------------------------------------------------------------------------------
export async function tonUtonic(p, ctx, { now = Date.now() } = {}) {
  const owner = need(p);
  const minter = await method(ctx, UTON.master, "get_minter_data");
  const m = minter?.stack || [];
  if (m.length < 4) throw { status: 502, error: "uTON get_minter_data gave no price" };
  const [supply, lastDay, lastPrice, inc] = m.slice(0, 4).map(big);
  const today = Math.floor(now / 86400000);
  const rate = Number(lastPrice + inc * BigInt(Math.max(0, today - Number(lastDay)))) / 1e9; // TON per uTON
  const wa = await method(ctx, UTON.master, "get_wallet_address", [owner]);
  const wallet = wa?.decoded?.jetton_wallet_address || (wa?.stack?.[0]?.cell && cellAddress(wa.stack[0].cell));
  if (!wallet) throw { status: 502, error: "uTON get_wallet_address gave no address" };
  const wd = await method(ctx, wallet, "get_complete_wallet_data");
  const out = { items: [], price_ton: round(rate, 6), errors: [] };
  if (!wd) return out; // no uTON wallet: never held uTON
  const balance = big(wd.stack[0]) ?? 0n, count = Number(big(wd.stack[1]) ?? 0n);
  if (balance <= 0n && count === 0) return out;
  const errors = out.errors;
  const proxy = await ctx.call("ton.account", { address: UTON.proxy });
  const reserve = proxy.ok ? Number(proxy.data?.balance ?? 0) : null;
  if (reserve == null) errors.push(`proxy reserve: upstream ${proxy.status}`);
  out.reserve_ton = reserve == null ? null : round(nano(reserve), 4);
  const px = await pricesOf(ctx, [TON_PRICE]);
  const tonUsd = trustedPrice(px, TON_PRICE);
  const usdOf = (ton) => (tonUsd == null ? null : round(ton * tonUsd));
  // an unknown reserve (its read failed) blocks nothing, but then no row is "ready" (claimable now) either
  const covers = (nanoTon) => reserve == null || reserve - nanoTon >= RESERVE_MIN;
  const short = (ton) => `wait until the UTONIC team acts: its withdrawal proxy (EQA4xu7Svw4KRf4brUyu7FpW-ay8-RlFtqjKagcJxzSFCU7r) holds ${round(nano(reserve ?? 0), 2)} TON, short of ${round(ton, 2)} TON (the app says "insufficient TON reserve, wait for a refill")`;
  const base = { category: "unstake_ready", chain: "ton", protocol: "UTONIC", how_to_claim: UTON.app };

  // withdrawals already burned: newest first, each its own contract
  const first = Math.max(0, count - MAX_WITHDRAWALS);
  if (first > 0) errors.push(`${first} older uTON withdrawals not read (only the newest ${MAX_WITHDRAWALS})`);
  for (let i = count - 1; i >= first; i--) {
    try {
      const a = await method(ctx, UTON.proxy, "get_withdraw_address", [owner, i]);
      const w = a?.stack?.[0]?.cell && cellAddress(a.stack[0].cell);
      if (!w) continue;
      const d = await method(ctx, w, "get_withdraw_data");
      const s = d?.stack || [];
      if (s.length < 7) continue; // contract gone: nothing left there
      const [, uton, ton, burnAt, unlockAt, burnPrice, finished] = s.slice(0, 7).map(big);
      if (finished === 1n || !(ton > 0n)) continue;
      const tonAmt = nano(ton), unlocked = Number(unlockAt) * 1000 <= now;
      const fact = `withdrawal #${i}: ${round(nano(uton), 4)} uTON burned ${day(burnAt)} at ${round(Number(burnPrice) / 1e9, 6)} TON each, ${unlocked ? `unlocked ${day(unlockAt)}, never claimed` : `unlocks ${day(unlockAt)}`}; contract ${w}`;
      const ok = covers(Number(ton));
      out.items.push({
        ...base, asset: "TON", amount: round(tonAmt, 6), usd: usdOf(tonAmt), withdraw_contract: w, unlocks: day(unlockAt),
        status: !ok ? "hint" : unlocked && reserve != null ? "ready" : "pending",
        action: !ok ? `${short(tonAmt)}; then press Claim on this withdrawal in the UTONIC app (Unstake tab)` : unlocked ? "press Claim on this withdrawal in the UTONIC app (Unstake tab, connect this wallet)" : `press Claim in the UTONIC app after ${day(unlockAt)}`,
        detail: [fact, !ok && "claims bigger than the proxy's TON reserve cannot go through until the team refills it", "only claim in the official app: anyone asking for a seed phrase is a scam"].filter(Boolean).join("; "),
      });
    } catch (e) {
      errors.push(`withdrawal #${i}: ${e?.error || e?.message || e}`);
    }
  }

  // uTON still held: burn it in the app, wait 3 days, claim the TON
  if (balance > 0n) {
    const amt = nano(balance), tonAmt = amt * rate, ok = covers(Number(balance) * rate);
    const over = supply != null && balance > supply;
    out.items.push({
      ...base, asset: "uTON", token: UTON.master, amount: round(amt, 6), usd: usdOf(tonAmt), status: ok && !over ? "pending" : "hint",
      action: ok && !over ? "unstake (burn) the uTON in the UTONIC app, wait 3 days, then press Claim to get the TON" : `${short(tonAmt)}; then unstake (burn) the uTON in the UTONIC app, wait 3 days and press Claim`,
      detail: [`${round(amt, 4)} uTON, worth ${round(tonAmt, 4)} TON at the app's price of ${round(rate, 6)} TON per uTON; uTON has no market, its value is that redemption`,
        over && "this wallet holds more uTON than the minter's recorded supply: probably not backed",
        "only claim in the official app: anyone asking for a seed phrase is a scam"].filter(Boolean).join("; "),
    });
  }
  return out;
}

// ---- ton.holdings -----------------------------------------------------------------------------------------------
export async function tonHoldings(p, ctx) {
  const address = need(p);
  const errors = [], holdings = [];
  const acc = await ctx.call("ton.account", { address });
  if (!acc.ok) throw { status: 502, error: `ton account read failed (upstream ${acc.status})`, detail: acc.data };
  const px = await pricesOf(ctx, [TON_PRICE]);
  const tonUsd = trustedPrice(px, TON_PRICE);
  const bal = nano(acc.data?.balance ?? 0);
  if (bal > 0) holdings.push({ kind: "token", chain: "ton", asset: "TON", amount: round(bal, 6), usd: tonUsd == null ? null : round(bal * tonUsd), verified: true, detail: `account ${acc.data?.status || "?"}` });
  if (acc.data?.status === "nonexist") return { items: [], holdings, errors };
  const j = await ctx.call("ton.jettons", { address });
  if (!j.ok) errors.push(`jettons: upstream ${j.status}`);
  for (const b of (j.ok && j.data?.balances) || []) {
    const t = b.jetton || {};
    if (!t.address || t.address === UTON.master || t.verification === "blacklist" || b.wallet_address?.is_scam) continue;
    const amount = Number(b.balance) / 10 ** Number(t.decimals ?? 9), price = Number(b.price?.prices?.USD) || 0;
    const verified = t.verification === "whitelist";
    if (!(amount > 0) || (!verified && !(price > 0))) continue;
    holdings.push({ kind: "token", chain: "ton", asset: t.symbol || t.name || "?", token: t.address, amount: round(amount, 6), usd: price > 0 ? round(amount * price) : null, verified, detail: [t.name, price > 0 ? "price: tonapi" : "no price"].filter(Boolean).join("; ") });
  }
  return { items: [], holdings, errors };
}

export const COMPOSE = { tonUtonic, tonHoldings };

export const SCAN = {
  kind: "ton", id: "scan.ton", compose: "scanTon", chains: ["ton"], label: "TON (EQ... / UQ... or 0:<hex>)",
  sources: ["ton.utonic", "ton.holdings"], ms: { "ton.utonic": 80000 },
  returns: "UTONIC uTON (held uTON valued at the app's redemption price, burned withdrawals unlocked and never claimed; rows wait on the team while the withdrawal proxy's TON reserve is short), TON and priced jetton balances (tonapi)",
  example: PROOF.withdrawals,
};
