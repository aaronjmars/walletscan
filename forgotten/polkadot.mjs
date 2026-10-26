// forgotten/polkadot.mjs - DOT from the 2017 Polkadot sale (and the KSM given to the same buyers in 2019) never claimed
// (rewards.dot_sale, read 2026-10-21). A buyer got DOT allocation indicator tokens on Ethereum
// (0xb59f67A8BfF5d8Cd03f6AC17265c550Ed8F33907, 3 decimals, old DOT: 1 = 100 DOT since the 2020 redenomination). Those
// not claimed before genesis sit in the claims pallet (polkadot runtime_common::claims), keyed by the Ethereum
// address: Claims (amount), Vesting (part of it locked), Signing (a statement must be attested: 0 Regular, 1 SAFT).
// A claim removes the entry, so an entry = unclaimed. Since the 2025 Asset Hub migration the pallet lives on Polkadot
// Asset Hub and Kusama Asset Hub (the relay chains' storage is empty), read with state_queryStorageAt over their
// public RPCs. Claiming needs the buying Ethereum wallet to sign a message naming a Polkadot account (Polkadot-JS
// Claims app, wiki.polkadot.com/learn/learn-guides-claims); there is no deadline.
import { readOn, pricesOf, trustedPrice, needEvm, round } from "./anyrpc.mjs";

export const DOT_INDICATOR = "0xb59f67A8BfF5d8Cd03f6AC17265c550Ed8F33907";
// twox128("Claims") twice = Claims.Claims; then Claims.Vesting and Claims.Signing (Identity hasher: + the 20 bytes)
const PALLET = "0x9c5d795d0297be56027a4b2464e33397";
const KEY = { claims: `${PALLET}9c5d795d0297be56027a4b2464e33397`, vesting: `${PALLET}5f27b51b5ec208ee9cb25b55d8728243`, signing: `${PALLET}c0793c53db77bf57f00ed54aa9119289` };
export const DOT_NETS = {
  polkadot: { symbol: "DOT", decimals: 10, price: "coingecko:polkadot", app: "https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Fpolkadot-asset-hub-rpc.polkadot.io#/claims", what: "the 2017 Polkadot sale" },
  kusama: { symbol: "KSM", decimals: 12, price: "coingecko:kusama", app: "https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Fkusama-asset-hub-rpc.polkadot.io#/claims", what: "the 2019 Kusama claim for DOT buyers" },
};
const STATEMENT = { "0x00": "Regular", "0x01": "SAFT" };
// little-endian unsigned int from a SCALE hex value, `len` bytes from byte `at`
export const le = (hex, at = 0, len = 16) => { const b = String(hex).slice(2).slice(at * 2, (at + len) * 2); let v = 0n; for (let i = b.length - 2; i >= 0; i -= 2) v = (v << 8n) | BigInt(parseInt(b.slice(i, i + 2), 16)); return v; };

async function claimOn(net, a, ctx) {
  const id = a.slice(2).toLowerCase(), keys = [KEY.claims + id, KEY.vesting + id, KEY.signing + id];
  const r = await ctx.call("rewards.dot_rpc", { chain: net }, { body: { jsonrpc: "2.0", id: 1, method: "state_queryStorageAt", params: [keys] } });
  if (!r.ok || r.data?.error || !Array.isArray(r.data?.result)) throw { status: 502, error: `${net} Asset Hub claims read failed (upstream ${r.status})`, detail: r.data?.error || r.data };
  const got = new Map((r.data.result[0]?.changes || []).map(([k, v]) => [k, v]));
  const amt = got.get(keys[0]);
  if (!amt) return null;
  const vest = got.get(keys[1]), sig = got.get(keys[2]);
  return { net, raw: le(amt), locked: vest ? le(vest) : 0n, statement: sig ? STATEMENT[sig] || sig : null };
}

export async function dotSale(p, ctx) {
  needEvm(p);
  const errors = [], found = [];
  await Promise.all(Object.keys(DOT_NETS).map((n) => claimOn(n, p.address, ctx).then((x) => x && found.push(x), (e) => errors.push(`${n}: ${e?.error || e?.message || e}`))));
  if (errors.length === Object.keys(DOT_NETS).length) throw { status: 502, error: errors.join("; ") };
  if (!found.length) return { items: [], errors };
  const nets = Object.keys(DOT_NETS);
  found.sort((x, y) => nets.indexOf(x.net) - nets.indexOf(y.net));
  const [bought, px] = await Promise.all([
    readOn(ctx, "ethereum", DOT_INDICATOR, ["function balanceOf(address) view returns (uint256)"], "balanceOf", [p.address]).catch(() => null),
    pricesOf(ctx, found.map((x) => DOT_NETS[x.net].price)),
  ]);
  const items = found.map((x) => {
    const n = DOT_NETS[x.net], amount = Number(x.raw) / 10 ** n.decimals, pr = trustedPrice(px, n.price), locked = Number(x.locked) / 10 ** n.decimals;
    return {
      category: "airdrop", chain: x.net, protocol: x.net === "polkadot" ? "Polkadot claims" : "Kusama claims", asset: n.symbol, amount: round(amount, 6), usd: pr == null ? null : round(amount * pr), status: "ready",
      ...(locked > 0 && { locked: round(locked, 6) }), ...(x.statement && { statement: x.statement }),
      action: `claim the ${n.symbol} in the Polkadot-JS Claims app (${x.net === "polkadot" ? "Polkadot" : "Kusama"} Asset Hub): sign the message with this Ethereum wallet, naming the ${x.net === "polkadot" ? "Polkadot" : "Kusama"} account that gets it${x.statement ? ` and accepting the ${x.statement} statement (claimAttest)` : ""}`,
      how_to_claim: n.app,
      detail: [`${round(amount, 4)} ${n.symbol} waiting in the ${x.net === "polkadot" ? "Polkadot" : "Kusama"} Asset Hub claims pallet for this Ethereum address (${n.what}), never claimed; no deadline`,
        locked > 0 && `${round(locked, 4)} of it is vesting-locked after the claim`,
        bought != null && bought > 0n && `the address holds ${Number(bought) / 1000} DOT allocation indicator (old DOT, x100 = DOT) on Ethereum`,
        "the claim only asks for a signed message in the official app: anyone asking for a seed phrase or a transaction is a scam"].filter(Boolean).join("; "),
    };
  });
  return { items, errors };
}
