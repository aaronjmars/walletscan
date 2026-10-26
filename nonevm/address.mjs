// nonevm/address.mjs - what kind of wallet address a string is, so scan.all and scan.wallets can send it to the right
// scan. Pure (no network). addressKind(s) -> { kind, address, ... } or null:
//   evm       0x + 40 hex (also a Harmony one1... address, turned into its 0x twin: `from` keeps what was pasted)
//   solana    base58 that decodes to 32 bytes
//   bitcoin   1... / 3... (base58check, version 0x00 / 0x05, 25 bytes), bc1q... (segwit v0, bech32), bc1p... (taproot,
//             bech32m); bech32 ones are lowercased
//   tron      T... (base58check, version 0x41, 25 bytes)
//   near      64 lowercase hex (an implicit account, no 0x) or a named account under a NEAR top-level account
//             (alice.near, x.tg, y.sweat...). NEAR's 0x + 40 hex accounts are EVM-shaped and go to scan.evm
//   sui       0x + 64 hex (Aptos uses the same shape; only Sui is scanned so far), lowercased
//   polkadot  SS58 (base58: network prefix + 32-byte account + 2-byte blake2b checksum); the same account is read on
//             Polkadot and Kusama whatever prefix it was pasted with. `account` = the 32 bytes as 0x hex
//   ton       user-friendly (48 chars base64 / base64url, crc16 checked: EQ..., UQ...) or raw (0:<64 hex>);
//             `address` = the raw form, `friendly` = what was pasted
// The decoded lengths keep the base58 kinds apart: Solana 32 bytes, Bitcoin and TRON 25, SS58 35 or 36.
import { createHash } from "node:crypto";
import { base58, bech32, bech32m } from "@scure/base";

const sha256 = (b) => createHash("sha256").update(b).digest();
const b58 = (s) => { try { return Buffer.from(base58.decode(s)); } catch { return null; } };

// base58check: version byte + payload + first 4 bytes of sha256(sha256(version + payload))
function base58check(s) {
  const b = /^[1-9A-HJ-NP-Za-km-z]{25,40}$/.test(s) ? b58(s) : null;
  if (!b || b.length !== 25) return null;
  return sha256(sha256(b.subarray(0, 21))).subarray(0, 4).equals(b.subarray(21)) ? { version: b[0], payload: b.subarray(1, 21) } : null;
}

// segwit address (BIP173 / BIP350): v0 = bech32 with a 20 or 32 byte program, v1+ = bech32m
function segwit(s, hrp = "bc") {
  const low = s.toLowerCase();
  if (s !== low && s !== s.toUpperCase()) return null;
  if (!low.startsWith(`${hrp}1`)) return null;
  for (const [enc, ok] of [[bech32, (v) => v === 0], [bech32m, (v) => v >= 1 && v <= 16]]) {
    try {
      const { prefix, words } = enc.decode(low, 90);
      if (prefix !== hrp || !ok(words[0])) continue;
      const prog = Buffer.from(enc.fromWords(words.slice(1)));
      if (words[0] === 0 && prog.length !== 20 && prog.length !== 32) return null;
      if (words[0] === 1 && prog.length !== 32) return null;
      return { address: low, version: words[0], program: prog.toString("hex"), type: words[0] === 0 ? (prog.length === 20 ? "p2wpkh" : "p2wsh") : words[0] === 1 ? "p2tr" : "segwit" };
    } catch { /* try the other encoding */ }
  }
  return null;
}

export function btcAddress(s) {
  const sw = segwit(s);
  if (sw) return sw;
  const c = base58check(s);
  if (c && (c.version === 0x00 || c.version === 0x05)) return { address: s, type: c.version ? "p2sh" : "p2pkh", hash: c.payload.toString("hex") };
  return null;
}

export function tronAddress(s) {
  const c = /^T/.test(s) ? base58check(s) : null;
  return c && c.version === 0x41 ? { address: s, hex: `41${c.payload.toString("hex")}` } : null;
}

// SS58: prefix 0-63 in one byte, 64-16383 in two; checksum = blake2b-512("SS58PRE" + prefix + account), first 2 bytes
export function ss58(s) {
  const b = /^[1-9A-HJ-NP-Za-km-z]{46,50}$/.test(s) ? b58(s) : null;
  if (!b || (b.length !== 35 && b.length !== 36)) return null;
  const plen = b[0] & 0x40 ? 2 : 1;
  if (b.length !== plen + 34) return null;
  const body = b.subarray(0, plen + 32);
  const sum = createHash("blake2b512").update(Buffer.concat([Buffer.from("SS58PRE"), body])).digest().subarray(0, 2);
  if (!sum.equals(b.subarray(plen + 32))) return null;
  const prefix = plen === 1 ? b[0] : (((b[0] & 0x3f) << 2) | (b[1] >> 6) | ((b[1] & 0x3f) << 8));
  return { address: s, prefix, account: `0x${b.subarray(plen, plen + 32).toString("hex")}` };
}

// account bytes -> SS58 with the given network prefix (0 Polkadot, 2 Kusama, 42 generic)
export function toSs58(accountHex, prefix = 0) {
  const acc = Buffer.from(String(accountHex).replace(/^0x/, ""), "hex");
  const pre = prefix < 64 ? Buffer.from([prefix]) : Buffer.from([((prefix & 0xfc) >> 2) | 0x40, (prefix >> 8) | ((prefix & 0x03) << 6)]);
  const body = Buffer.concat([pre, acc]);
  const sum = createHash("blake2b512").update(Buffer.concat([Buffer.from("SS58PRE"), body])).digest().subarray(0, 2);
  return base58.encode(Buffer.concat([body, sum]));
}

// TON user-friendly address: flags (0x11 bounceable, 0x51 not, +0x80 testnet) + workchain + 32-byte hash + crc16-xmodem
const crc16 = (b) => { let c = 0; for (const x of b) { c ^= x << 8; for (let i = 0; i < 8; i++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff; } return c; };
export function tonAddress(s) {
  const raw = /^(-1|0):([0-9a-fA-F]{64})$/.exec(s);
  if (raw) return { address: `${raw[1]}:${raw[2].toLowerCase()}`, friendly: null };
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(s)) return null;
  const b = Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (b.length !== 36 || ![0x11, 0x51].includes(b[0])) return null; // testnet (0x80 bit) addresses are not scanned
  if (crc16(b.subarray(0, 34)) !== b.readUInt16BE(34)) return null;
  const wc = b[1] === 0xff ? -1 : b[1];
  return { address: `${wc}:${b.subarray(2, 34).toString("hex")}`, friendly: s, bounceable: b[0] === 0x11 };
}

// NEAR: implicit = 64 lowercase hex; named = 2-64 chars of lowercase letters, digits, - _ separated by dots, under a
// known top-level account (a plain word or a DNS-like name is not taken for a NEAR account)
export const NEAR_TLA = ["near", "tg", "sweat", "kaiching", "aurora"];
const NEAR_NAME = /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)+([a-z\d]+[-_])*[a-z\d]+$/;
export function nearAccount(s) {
  if (/^[0-9a-f]{64}$/.test(s)) return { address: s, implicit: true };
  if (NEAR_NAME.test(s) && NEAR_TLA.includes(s.split(".").pop())) return { address: s, implicit: false };
  return null;
}

// Harmony one1... = bech32 of the same 20 bytes as its 0x address
export function harmonyToEvm(s) {
  if (!/^one1[02-9ac-hj-np-z]{38}$/i.test(s)) return null;
  try {
    const { prefix, words } = bech32.decode(s.toLowerCase());
    const b = Buffer.from(bech32.fromWords(words));
    return prefix === "one" && b.length === 20 ? `0x${b.toString("hex")}` : null;
  } catch { return null; }
}

const isEvm = (s) => /^0x[0-9a-fA-F]{40}$/.test(s);
const isSol = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) && b58(s)?.length === 32;

// names (ENS, SNS, Unstoppable, .ton...) are not resolved: the caller is told to paste the address
const NAME = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.(eth|sol|bnb|arb|base|crypto|nft|wallet|x|ton|sui|apt|lens|cb\.id)$/i;
export const isName = (s) => NAME.test(String(s || "").trim());

export function addressKind(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (isEvm(s)) return { kind: "evm", address: s };
  const one = harmonyToEvm(s);
  if (one) return { kind: "evm", address: one, from: s.toLowerCase(), note: "a Harmony one1 address: scanned as its 0x twin" };
  if (isSol(s)) return { kind: "solana", address: s };
  const btc = btcAddress(s);
  if (btc) return { kind: "bitcoin", ...btc };
  const tron = tronAddress(s);
  if (tron) return { kind: "tron", ...tron };
  if (/^0x[0-9a-fA-F]{64}$/.test(s)) return { kind: "sui", address: s.toLowerCase() };
  const near = nearAccount(s);
  if (near) return { kind: "near", ...near };
  const dot = ss58(s);
  if (dot) return { kind: "polkadot", ...dot };
  const ton = tonAddress(s);
  if (ton) return { kind: "ton", ...ton };
  return null;
}

// what each kind looks like, for the 400 answer on an address that is none of them
export const KINDS = {
  evm: "EVM 0x + 40 hex (also Harmony one1...)", solana: "Solana base58", bitcoin: "Bitcoin 1..., 3..., bc1q... or bc1p...", tron: "TRON T...",
  near: "NEAR 64-hex implicit or name.near / name.tg", sui: "Sui 0x + 64 hex", polkadot: "Polkadot / Kusama SS58 (1..., C..., 5...)", ton: "TON EQ... / UQ... or 0:<hex>",
};
export function unknownAddress(raw) {
  const s = String(raw ?? "").trim();
  if (isName(s)) return { status: 400, error: "names are not resolved: paste the wallet address itself", detail: s.slice(0, 64) };
  return { status: 400, error: "not a supported wallet address", detail: { address: s.slice(0, 64), supported: Object.values(KINDS) } };
}
