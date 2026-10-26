// nonevm/dot-scale.mjs - Substrate storage key hashing and the few SCALE decoders nonevm/dot.mjs needs. Pure.
//   twox128(text)          pallet / item prefix (xxhash64 seeds 0 and 1, little-endian)
//   twox64Concat(bytes)    xxhash64 seed 0 + the key itself (Staking.Bonded, NominationPools.PoolMembers...)
//   blake2_128Concat(bytes) blake2b-128 + the key itself (System.Account, Staking.Ledger, Assets.Account...)
import { blake2b } from "@noble/hashes/blake2b";

const M = (1n << 64n) - 1n;
const P1 = 0x9e3779b185ebca87n, P2 = 0xc2b2ae3d27d4eb4fn, P3 = 0x165667b19e3779f9n, P4 = 0x85ebca77c2b2ae63n, P5 = 0x27d4eb2f165667c5n;
const rotl = (x, r) => ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M;
const u64 = (b, i) => { let v = 0n; for (let k = 7; k >= 0; k--) v = (v << 8n) | BigInt(b[i + k]); return v; };
const u32 = (b, i) => BigInt((b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + b[i + 3] * 0x1000000);
const round = (acc, input) => (rotl((acc + input * P2) & M, 31) * P1) & M;
const merge = (h, v) => ((((h ^ round(0n, v)) * P1) & M) + P4) & M;

export function xxhash64(bytes, seed = 0n) {
  const b = bytes instanceof Uint8Array ? bytes : Buffer.from(bytes);
  const len = b.length;
  let i = 0, h;
  if (len >= 32) {
    let v1 = (seed + P1 + P2) & M, v2 = (seed + P2) & M, v3 = seed & M, v4 = (seed - P1) & M;
    for (; i + 32 <= len; i += 32) { v1 = round(v1, u64(b, i)); v2 = round(v2, u64(b, i + 8)); v3 = round(v3, u64(b, i + 16)); v4 = round(v4, u64(b, i + 24)); }
    h = (rotl(v1, 1) + rotl(v2, 7) + rotl(v3, 12) + rotl(v4, 18)) & M;
    h = merge(merge(merge(merge(h, v1), v2), v3), v4);
  } else h = (seed + P5) & M;
  h = (h + BigInt(len)) & M;
  for (; i + 8 <= len; i += 8) h = ((rotl(h ^ round(0n, u64(b, i)), 27) * P1) + P4) & M;
  if (i + 4 <= len) { h = ((rotl(h ^ ((u32(b, i) * P1) & M), 23) * P2) + P3) & M; i += 4; }
  for (; i < len; i++) h = (rotl(h ^ ((BigInt(b[i]) * P5) & M), 11) * P1) & M;
  h ^= h >> 33n; h = (h * P2) & M; h ^= h >> 29n; h = (h * P3) & M; h ^= h >> 32n;
  return h;
}
const le8 = (v) => { const o = Buffer.alloc(8); o.writeBigUInt64LE(v); return o.toString("hex"); };
export const twox64 = (bytes) => le8(xxhash64(bytes, 0n));
export const twox128 = (text) => { const b = Buffer.from(text); return le8(xxhash64(b, 0n)) + le8(xxhash64(b, 1n)); };
const hexBytes = (h) => Buffer.from(String(h).replace(/^0x/, ""), "hex");
export const twox64Concat = (h) => twox64(hexBytes(h)) + String(h).replace(/^0x/, "");
export const blake2_128Concat = (h) => Buffer.from(blake2b(hexBytes(h), { dkLen: 16 })).toString("hex") + String(h).replace(/^0x/, "");
export const storageKey = (pallet, item, ...parts) => `0x${twox128(pallet)}${twox128(item)}${parts.join("")}`;
export const u32le = (n) => { const o = Buffer.alloc(4); o.writeUInt32LE(n); return o.toString("hex"); };

// a cursor over a SCALE hex value
export class Scale {
  constructor(hex) { this.b = hexBytes(hex); this.i = 0; }
  get left() { return this.b.length - this.i; }
  u8() { return this.b[this.i++]; }
  uint(n) { let v = 0n; for (let k = n - 1; k >= 0; k--) v = (v << 8n) | BigInt(this.b[this.i + k]); this.i += n; return v; }
  u32() { return Number(this.uint(4)); }
  u128() { return this.uint(16); }
  bytes(n) { const o = this.b.subarray(this.i, this.i + n); this.i += n; return o; }
  compact() {
    const m = this.b[this.i] & 3;
    if (m === 0) return BigInt(this.u8() >> 2);
    if (m === 1) return this.uint(2) >> 2n;
    if (m === 2) return this.uint(4) >> 2n;
    const n = (this.u8() >> 2) + 4;
    return this.uint(n);
  }
}

// StakingLedger { stash: AccountId32, total: Compact<u128>, active: Compact<u128>, unlocking: Vec<{ value: Compact<u128>, era: Compact<u32> }>, ... }
export function decodeLedger(hex) {
  const s = new Scale(hex);
  const stash = `0x${s.bytes(32).toString("hex")}`, total = s.compact(), active = s.compact();
  const n = Number(s.compact()), unlocking = [];
  for (let k = 0; k < n; k++) unlocking.push({ value: s.compact(), era: Number(s.compact()) });
  return { stash, total, active, unlocking };
}
// PoolMember { pool_id: u32, points: u128, last_recorded_reward_counter: u128, unbonding_eras: BTreeMap<u32, u128> }
export function decodePoolMember(hex) {
  const s = new Scale(hex);
  const pool_id = s.u32(), points = s.u128(); s.u128();
  const n = Number(s.compact()), unbonding = [];
  for (let k = 0; k < n; k++) unbonding.push({ era: s.u32(), points: s.u128() });
  return { pool_id, points, unbonding };
}
// SubPools { no_era: UnbondPool { points: u128, balance: u128 }, with_era: BTreeMap<u32, UnbondPool> }
export function decodeSubPools(hex) {
  const s = new Scale(hex);
  const no_era = { points: s.u128(), balance: s.u128() };
  const n = Number(s.compact()), with_era = new Map();
  for (let k = 0; k < n; k++) with_era.set(s.u32(), { points: s.u128(), balance: s.u128() });
  return { no_era, with_era };
}
// BondedPoolInner { commission..., member_counter u32, points u128, ... }: only points is needed, and it sits after a
// variable-size commission struct, so the pool's bonded points come from the ledger of its bonded account instead
// AccountInfo { nonce u32, consumers u32, providers u32, sufficients u32, data { free u128, reserved u128, frozen u128, flags u128 } }
export function decodeAccount(hex) {
  const s = new Scale(hex);
  s.u32(); s.u32(); s.u32(); s.u32();
  return { free: s.u128(), reserved: s.u128(), frozen: s.u128() };
}
// ActiveEraInfo { index: u32, start: Option<u64> }
export const decodeActiveEra = (hex) => (hex ? new Scale(hex).u32() : null);
// pallet-assets AssetAccount { balance: u128, status: u8, reason: enum, extra }
export const decodeAssetBalance = (hex) => (hex ? new Scale(hex).u128() : 0n);
