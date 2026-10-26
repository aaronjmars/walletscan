// forgotten/karak.mjs - Karak money a wallet left behind (hiddenfunds.xyz gaps, read 2026-10-21):
//   rewards.karak_queue  Karak v1 restaking withdrawals started (startWithdraw) and never finished (finishWithdraw)
//   bridge.k2_claims     ETH, rswETH and USDC left on the K2 chain, paid on Ethereum by Merkle claim since K2 shut down
// Each function answers { items[], errors[] } for findings.mjs (hfClaims).
import { readFileSync } from "node:fs";
import { readOn, multiOn, rpcOn, pricesOf, trustedPrice, tokenKey, needEvm, units, round, errText } from "./anyrpc.mjs";

// ---- Karak v1 queued withdrawals. The DelegationSupervisor keeps every withdrawal a staker queued
// (fetchQueuedWithdrawals, never pruned) and marks the open ones in pendingWithdrawals (isWithdrawPending); after
// withdrawalDelay (7 days) the staker calls finishWithdraw(withdrawals) and each vault redeems its shares to the
// vault's asset. Addresses: the contracts.json files in the Karak app bundle (app.karak.network), Ethereum's
// verified on Etherscan. finishWithdraw was simulated OK on Ethereum and Arbitrum on 2026-10-21 (DelegationSupervisor
// not paused; the VaultSupervisor pause only stops deposits). Karak on K2 is left to bridge.k2_claims.
export const KARAK_DS = {
  ethereum: "0xAfa904152E04aBFf56701223118Be2832A4449E0", arbitrum: "0x48769803c0449532Bd23DB3A413152632753c8f0", bsc: "0x025EA109029cE1da34f41D4C480C0bcf72248A16",
  mantle: "0x025EA109029cE1da34f41D4C480C0bcf72248A16", blast: "0xc1F1bAc60494a9FcbF4cF7fD7B9C32d2C487FFD9", fraxtal: "0x3cd169aeA0acbEA104B69124F3a18843BeFaaAB8",
};
const DS_ABI = [
  "struct WithdrawRequest { address[] vaults; uint256[] shares; address withdrawer; }",
  "struct QueuedWithdrawal { address staker; address delegatedTo; uint256 nonce; uint256 start; WithdrawRequest request; }",
  "function fetchQueuedWithdrawals(address staker) view returns (QueuedWithdrawal[])",
  "function isWithdrawPending(QueuedWithdrawal withdrawal) view returns (bool)",
  "function withdrawalDelay() view returns (uint256)",
];
const VAULT = ["function asset() view returns (address)", "function convertToAssets(uint256 shares) view returns (uint256)", "function name() view returns (string)"];
const ERC20 = ["function symbol() view returns (string)", "function decimals() view returns (uint8)"];
const day = (s) => new Date(Number(s) * 1000).toISOString().slice(0, 10);

async function queueOn(chain, a, ctx, now) {
  const ds = KARAK_DS[chain], all = await readOn(ctx, chain, ds, DS_ABI, "fetchQueuedWithdrawals", [a]);
  if (!all.length) return [];
  const st = await multiOn(ctx, chain, [{ to: ds, abi: DS_ABI, fn: "withdrawalDelay" }, ...all.map((w) => ({ to: ds, abi: DS_ABI, fn: "isWithdrawPending", args: [w] }))]);
  const delay = Number(st[0] ?? 604800), open = all.filter((_, i) => st[i + 1] === true);
  if (!open.length) return [];
  const legs = open.flatMap((w) => w.request.vaults.map((v, j) => ({ w, vault: v.toLowerCase(), shares: w.request.shares[j] })));
  const vr = await multiOn(ctx, chain, legs.flatMap((l) => [{ to: l.vault, abi: VAULT, fn: "asset" }, { to: l.vault, abi: VAULT, fn: "convertToAssets", args: [l.shares] }, { to: l.vault, abi: VAULT, fn: "name" }]));
  legs.forEach((l, i) => { l.asset = vr[3 * i] ? String(vr[3 * i]).toLowerCase() : null; l.raw = vr[3 * i + 1]; l.name = vr[3 * i + 2]; });
  const toks = [...new Set(legs.map((l) => l.asset).filter(Boolean))];
  const [meta, px] = await Promise.all([multiOn(ctx, chain, toks.flatMap((t) => [{ to: t, abi: ERC20, fn: "symbol" }, { to: t, abi: ERC20, fn: "decimals" }])), pricesOf(ctx, toks.map((t) => tokenKey(chain, t)))]);
  const info = new Map(toks.map((t, i) => [t, { symbol: meta[2 * i], decimals: meta[2 * i + 1] }]));
  return legs.map((l) => {
    const m = info.get(l.asset) || {}, ready = Number(l.w.start) + delay <= now;
    if (l.raw == null || m.decimals == null) return { category: "unstake_ready", chain, protocol: "Karak", asset: l.name || null, amount: units(l.shares, 18), usd: null, status: "hint", action: "finish the Karak withdrawal in the Karak app (finishWithdraw)", how_to_claim: "https://app.karak.network", detail: `Karak vault ${l.vault} could not be read: ${String(l.shares)} shares queued ${day(l.w.start)} (amount shown assumes 18 decimals)` };
    const amount = units(l.raw, m.decimals), p = trustedPrice(px, tokenKey(chain, l.asset));
    return {
      category: "unstake_ready", chain, protocol: "Karak", asset: m.symbol || l.asset, token: l.asset, amount: round(amount, 8), usd: p == null ? null : round(amount * p),
      status: ready ? "ready" : "queued", nonce: String(l.w.nonce), vault: l.vault,
      action: ready ? `finish the Karak withdrawal: finishWithdraw on the DelegationSupervisor ${ds} (Karak app, or ${chain === "ethereum" ? "Etherscan" : "the explorer"} Write as Proxy with the withdrawal from fetchQueuedWithdrawals)` : `wait for the Karak withdrawal delay to pass (${day(Number(l.w.start) + delay)}), then finishWithdraw`,
      how_to_claim: "https://app.karak.network",
      detail: `${l.name || "Karak vault"} (${l.vault}): withdrawal ${l.w.nonce} of ${String(l.shares)} shares started ${day(l.w.start)}, ${ready ? `delay over since ${day(Number(l.w.start) + delay)}, never finished` : "still in the delay"}; amount = the vault's convertToAssets now`,
    };
  });
}

export async function karakQueue(p, ctx) {
  needEvm(p);
  const errors = [], items = [], now = Math.floor(Date.now() / 1000), chains = Object.keys(KARAK_DS);
  await Promise.all(chains.map((c) => queueOn(c, p.address, ctx, now).then((xs) => items.push(...xs), (e) => errors.push(`${c}: ${errText(e)}`))));
  if (errors.length === chains.length) throw { status: 502, error: errors.join("; ") };
  items.sort((x, y) => chains.indexOf(x.chain) - chains.indexOf(y.chain) || Number(x.nonce ?? 0) - Number(y.nonce ?? 0));
  return { items, errors };
}

// ---- K2 (Karak's L2, chain 2410) shut down on 2026-09-15: its OptimismPortal and L1StandardBridge on Ethereum were
// upgraded so normal withdrawals revert and balances are paid by Merkle proof instead: claimETH(amount, proof) on the
// portal, claimTokens(tokens, amounts, proof) on the bridge (verified sources on Etherscan; leaf = the wallet + its
// total, claimedETH / claimedTokens hold what was paid). After RECOVERY_TIMESTAMP 1820707200 (2027-09-12) the guardian
// can pause claims and take what is left. The tree is not published: k2bridge.karak.network hands a proof only to a
// wallet that signs in. So the amount here is the wallet's own K2 balance at the last block, read on K2's RPC: on 80
// claims checked (2026-10-21) the paid ETH was never below it (higher when a K2 withdrawal was still in flight), so it
// is a floor, and a claim already made (claimed > 0) pays the whole leaf. WETH on K2 is not counted: the ETH claims
// checked left it out. The L1 bridge holds USDC and rswETH (the two tokens claimed so far).
export const K2_PORTAL = "0xeeCE9CD7Abd1CC84d9dfc7493e7e68079E47eA73";
export const K2_BRIDGE = "0xBA61F25dd9f2d5f02D01B1C2c1c5F0B14c4B48A3";
const K2_WETH = "0x4200000000000000000000000000000000000006";
// [symbol, L1 token, K2 token (its l1Token / remoteToken), decimals]
const K2_TOKENS = [["rswETH", "0xFAe103DC9cf190eD75350761e95403b7b8aFa6c0", "0xf948aACec00289Fc33D8226391f7e04bb457aD49", 18], ["USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xa415021bC5c4C3b5B989116DC35Ae95D9C962c8D", 6]];
const CLAIM_ABI = ["function claimedETH(address) view returns (uint256)", "function claimedTokens(address, address) view returns (uint256)", "function paused() view returns (bool)"];
const BAL = ["function balanceOf(address) view returns (uint256)"];
const K2 = JSON.parse(readFileSync(new URL("../data/sunset-chains.json", import.meta.url), "utf8")).find((s) => s.id === "karak-k2") || {};
export const K2_ENDS = K2.closes || "2027-09-12";
export const K2_APP = "https://k2bridge.karak.network";

export async function k2Claims(p, ctx) {
  needEvm(p);
  const a = p.address;
  // K2's RPC (no Multicall3 there) one call at a time, then the claimed amounts on Ethereum in one Multicall3
  const eth = BigInt(await rpcOn(ctx, "karak", "eth_getBalance", [a, "latest"]));
  const weth = await readOn(ctx, "karak", K2_WETH, BAL, "balanceOf", [a]);
  const tok = [];
  for (const t of K2_TOKENS) tok.push(await readOn(ctx, "karak", t[2], BAL, "balanceOf", [a]));
  if (!(eth > 0n) && !(weth > 0n) && !tok.some((b) => b > 0n)) return { items: [], errors: [] };
  const [l1, px] = await Promise.all([
    multiOn(ctx, "ethereum", [{ to: K2_PORTAL, abi: CLAIM_ABI, fn: "claimedETH", args: [a] }, { to: K2_PORTAL, abi: CLAIM_ABI, fn: "paused" }, ...K2_TOKENS.map((t) => ({ to: K2_BRIDGE, abi: CLAIM_ABI, fn: "claimedTokens", args: [a, t[1]] }))]),
    pricesOf(ctx, ["coingecko:ethereum", ...K2_TOKENS.map((t) => tokenKey("ethereum", t[1]))]),
  ]);
  if (l1[0] == null || l1.slice(2).some((x) => x == null)) throw { status: 502, error: "K2 claim state on Ethereum could not be read" };
  if (l1[1] === true) return { items: [], errors: ["K2 claims are paused on Ethereum: the guardian may be recovering what is left"] };
  const row = ({ fn, ...o }) => ({
    category: "bridge_stuck", chain: "ethereum", protocol: "K2 (Karak)", status: "unconfirmed", deadline: K2_ENDS, how_to_claim: K2_APP,
    action: `claim it on ${K2_APP}: sign in with this wallet for the Merkle proof, then ${fn} on Ethereum`, ...o,
  });
  const items = [];
  const ethPx = trustedPrice(px, "coingecko:ethereum");
  if (l1[0] === 0n && eth > 0n) {
    const amount = units(eth, 18);
    items.push(row({ asset: "ETH", amount: round(amount, 8), usd: ethPx == null ? null : round(amount * ethPx), fn: "claimETH",
      detail: `${round(amount, 6)} ETH left on K2 at its last block, not claimed on Ethereum (claimedETH 0 on the portal ${K2_PORTAL}); the claim pays at least this (also K2 withdrawals that never finished)${weth > 0n ? `; ${round(units(weth, 18), 6)} WETH on K2 is not counted here` : ""}; the guardian can take what is left after ${K2_ENDS}` }));
  } else if (l1[0] === 0n && weth > 0n) {
    const amount = units(weth, 18);
    items.push(row({ asset: "ETH", amount: round(amount, 8), usd: ethPx == null ? null : round(amount * ethPx), status: "hint", fn: "claimETH",
      detail: `${round(amount, 6)} WETH left on K2, nothing claimed on Ethereum; the K2 claim tree may not count WETH (sign in on ${K2_APP} to see)` }));
  }
  K2_TOKENS.forEach(([symbol, l1Token, , decimals], i) => {
    if (!(tok[i] > 0n) || l1[2 + i] !== 0n) return;
    const amount = units(tok[i], decimals), pr = trustedPrice(px, tokenKey("ethereum", l1Token));
    items.push(row({ asset: symbol, token: l1Token.toLowerCase(), amount: round(amount, 8), usd: pr == null ? null : round(amount * pr), fn: "claimTokens",
      detail: `${round(amount, 6)} ${symbol} left on K2 at its last block, not claimed on Ethereum (claimedTokens 0 on the bridge ${K2_BRIDGE}); the claim pays at least this; the guardian can take what is left after ${K2_ENDS}` }));
  });
  return { items, errors: [] };
}
