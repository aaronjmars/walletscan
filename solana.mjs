// solana.mjs - Solana address math for compose routes: program-derived addresses (PDAs) and associated token
// accounts, plus the program ids and rent numbers the scan uses. No RPC here: compose.mjs reads the accounts.
import { createHash } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";

export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
export const WSOL = "So11111111111111111111111111111111111111112";
export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"; // pump.fun bonding curves
export const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"; // PumpSwap, where coins go after bonding
export const LAMPORTS = 1e9;
// rent-exempt minimum of a 0-byte system account (a PDA vault holding only SOL), before the Sept 2026 rent cut;
// the creator-fee claim leaves this much behind
export const RENT_EMPTY = 890880;

export const isSolAddr = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || "")) && (() => { try { return base58.decode(s).length === 32; } catch { return false; } })();
export const isEvmAddr = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s || ""));

const onCurve = (bytes) => {
  try { ed25519.Point.fromHex(bytes); return true; } catch { return false; }
};

// findProgramAddress: seeds are 32-byte keys (base58), seed("text") or raw bytes (a Uint8Array, e.g. a u64 LE), then
// a bump from 255 down; the first hash off the ed25519 curve is the address
export const seed = (s) => ({ text: s });
export function findPda(seeds, programId) {
  const parts = seeds.map((s) => (s instanceof Uint8Array ? Buffer.from(s) : s && s.text != null ? Buffer.from(s.text) : Buffer.from(base58.decode(s))));
  const program = Buffer.from(base58.decode(programId));
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256").update(Buffer.concat([...parts, Buffer.from([bump]), program, Buffer.from("ProgramDerivedAddress")])).digest();
    if (!onCurve(h)) return { address: base58.encode(h), bump };
  }
  throw new Error("no PDA found");
}

export const ata = (owner, mint, tokenProgram = TOKEN_PROGRAM) => findPda([owner, tokenProgram, mint], ATA_PROGRAM).address;

// pump.fun creator fee vaults of a creator wallet: bonding-curve fees sit as SOL in a PDA of the pump program,
// PumpSwap fees as WSOL in the token account of a PDA of the AMM program
export function pumpVaults(creator) {
  const curve = findPda([seed("creator-vault"), creator], PUMP_PROGRAM).address;
  const ammAuthority = findPda([seed("creator_vault"), creator], PUMP_AMM).address;
  return { curve, ammAuthority, ammWsol: ata(ammAuthority, WSOL) };
}
