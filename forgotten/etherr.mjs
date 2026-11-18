// forgotten/etherr.mjs - rewards.etherr_old_tokens: tokens the wallet still holds from the Etherr "Claimables 2015-2017" list
// (https://etherr.eth.limo/: Ethereum contracts from 2015-2017 that may still pay something). One Multicall3 balanceOf over
// the list's 1,185 token contracts and 3 NFT contracts (data/etherr-tokens.json, copied from the page on 2026-11-18). The
// page's other 1,389 rows (address sets, flags, registries, state changes) have no per-wallet balance to read, so they are
// not checked. A hit only means the wallet holds the old token: the list says "potentially claimable", not how, so every
// row is a low-confidence hint with no price (out of the totals).
import { readFileSync } from "node:fs";
import { isEvmAddr } from "../solana.mjs";
import { multi, units } from "./evm.mjs";

export const TOKENS = JSON.parse(readFileSync(new URL("../data/etherr-tokens.json", import.meta.url), "utf8"));
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const LIST = "https://etherr.eth.limo/";
const BATCH = 25;

// Multicall3 balanceOf for a slice of the list. One gas-hungry old contract can run a whole eth_call out of gas (public
// RPCs cap it), so a failed slice is halved until the bad contract stands alone and answers null (counted in `skipped`).
async function slice(ctx, calls, skipped) {
  try { return await multi(ctx, "ethereum", calls, { batch: calls.length }); } catch (e) {
    if (calls.length === 1) { skipped.push(calls[0].to); return [null]; }
    const mid = calls.length >> 1;
    return [...await slice(ctx, calls.slice(0, mid), skipped), ...await slice(ctx, calls.slice(mid), skipped)];
  }
}
async function balances(ctx, owner, skipped) {
  const calls = TOKENS.map((t) => ({ to: t.address, abi: ERC20, fn: "balanceOf", args: [owner] })), parts = [];
  for (let i = 0; i < calls.length; i += BATCH) parts.push(calls.slice(i, i + BATCH));
  return (await Promise.all(parts.map((c) => slice(ctx, c, skipped)))).flat();
}

export async function etherrOldTokens(p, ctx) {
  if (p.address == null || p.address === "") throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
  const owner = p.address, errors = [];
  const skipped = [], bals = await balances(ctx, owner, skipped);
  if (skipped.length) errors.push(`etherr list: ${skipped.length} of ${TOKENS.length} contracts could not be read (eth_call out of gas or failed)`);
  const held = TOKENS.map((t, i) => ({ t, bal: bals[i] ?? 0n })).filter((h) => h.bal > 0n);
  if (!held.length) return { items: [], errors };
  const meta = await multi(ctx, "ethereum", held.flatMap((h) => [{ to: h.t.address, abi: ERC20, fn: "decimals" }, { to: h.t.address, abi: ERC20, fn: "symbol" }]));
  const items = held.map((h, i) => {
    const { t, bal } = h, dec = meta[2 * i], sym = meta[2 * i + 1];
    const asset = (typeof sym === "string" && sym.trim().slice(0, 24)) || t.name || `${t.address.slice(0, 10)}...`;
    const amount = t.nft ? Number(bal) : units(bal, dec == null ? 18 : Number(dec));
    return {
      category: "unstake_ready", chain: "ethereum", protocol: "Etherr 2015-2017 list", asset, token: t.address, amount, usd: null, confidence: "low",
      action: `check ${t.name || asset} (${t.address}) on Etherr: the list marks this ${t.created.slice(0, 4)} contract as potentially claimable`,
      how_to_claim: LIST,
      detail: `the wallet holds ${amount} ${asset} on ${t.address} (created ${t.created}). Etherr's Claimables 2015-2017 list names the contract but not how to claim; read the contract on Etherscan first. No price: old tokens are mostly worthless, so this is a hint, not a total`,
    };
  });
  return { items, errors };
}
