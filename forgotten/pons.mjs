// Pons v2, including archived deployments. Profile data discovers token addresses only; balances and current
// beneficiaries come from contracts. ABI and release split verified against Sourcify's matched source on 4663:
// https://sourcify.dev/server/v2/contract/4663/0x42df2a798f82289E177311362e8f5ccC45c1219c?fields=abi,sources
import { readFileSync } from "node:fs";
import { multiOn, pricesOf, trustedPrice, needEvm, isEvm, units, round, errText } from "./anyrpc.mjs";

export const PONS = JSON.parse(readFileSync(new URL("../data/pons.json", import.meta.url), "utf8"));
const ZERO = "0x0000000000000000000000000000000000000000";
const ABI = [
  "function feeEscrow() view returns (address)", "function buybackVault() view returns (address)",
  "function balanceOf(address recipient) view returns (uint256)",
  "function balanceOfToken(address recipient,address token) view returns (uint256)",
  "function releasable(address token) view returns (uint256)",
  "function vestingTerms(address token) view returns (address creatorRecipient,address protocolRecipient,uint16 protocolFeeShareBps)",
  "function symbol() view returns (string)", "function decimals() view returns (uint8)",
];
const low = (x) => String(x || "").toLowerCase();
export function vestShare(raw, terms, wallet) {
  if (!terms || terms.length !== 3 || !(raw > 0n)) return 0n;
  const [creator, protocol, bps] = terms;
  if (!Number.isInteger(Number(bps)) || Number(bps) < 0 || Number(bps) > 10000) return 0n;
  const protocolAmount = raw * BigInt(bps) / 10000n;
  return (low(creator) === low(wallet) ? raw - protocolAmount : 0n) + (low(protocol) === low(wallet) ? protocolAmount : 0n);
}

export async function pons(p, ctx) {
  needEvm(p);
  const address = low(p.address), errors = [];
  let profile = {}, discoveryFailed = false;
  try {
    const r = await ctx.call("rewards.pons_profile", { address });
    if (!r.ok || !Array.isArray(r.data?.launches)) throw new Error(`profile upstream ${r.status}`);
    profile = r.data;
  } catch (e) { discoveryFailed = true; errors.push(`launch discovery: ${errText(e)}`); }
  const launches = profile.launches || [];
  const extra = String(p.tokens || "").split(",").map(low).filter(isEvm);
  const allLaunchTokens = [...new Set([...launches.map((l) => low(l.address)).filter(isEvm), ...extra])];
  const launchTokens = allLaunchTokens.slice(0, 200);
  const tokenSet = new Set([...PONS.quote_tokens.map((t) => t.address), ...launchTokens]);
  for (const l of launches) if (isEvm(l.quote?.address) && low(l.quote.address) !== ZERO) tokenSet.add(low(l.quote.address));
  const tokens = [...tokenSet];

  const refs = await multiOn(ctx, "robinhood", PONS.factories.flatMap((to) => [
    { to, abi: ABI, fn: "feeEscrow" }, { to, abi: ABI, fn: "buybackVault" },
  ]));
  const escrows = [...new Set([...PONS.escrows, ...refs.filter((_, i) => i % 2 === 0).filter(isEvm).map(low)])].filter((x) => x !== ZERO);
  const vaults = [...new Set(refs.filter((_, i) => i % 2 === 1).filter(isEvm).map(low))].filter((x) => x !== ZERO);
  for (let i = 0; i < PONS.factories.length; i++) if (refs[i * 2] == null || refs[i * 2 + 1] == null) errors.push(`factory ${PONS.factories[i]}: deployment lookup failed`);

  const feeCalls = escrows.flatMap((escrow) => [
    { escrow, token: ZERO, fn: "balanceOf", args: [address] },
    ...tokens.map((token) => ({ escrow, token, fn: "balanceOfToken", args: [address, token] })),
  ]);
  const balances = await multiOn(ctx, "robinhood", feeCalls.map((c) => ({ to: c.escrow, abi: ABI, fn: c.fn, args: c.args })));
  const rawRows = [];
  feeCalls.forEach((c, i) => {
    if (balances[i] == null) errors.push(`escrow ${c.escrow} ${c.token}: unreadable balance`);
    if (balances[i] > 0n) rawRows.push({ ...c, raw: balances[i], category: "creator_fees" });
  });

  // A vault's releasable() is BOTH beneficiaries combined. Its snapshotted terms, not today's factory policy,
  // determine this wallet's amount. Already-released tokens are in the escrow ledger above and stay separate.
  const vestCalls = vaults.flatMap((vault) => launchTokens.map((token) => ({ vault, token })));
  const v = await multiOn(ctx, "robinhood", vestCalls.flatMap(({ vault, token }) => [
    { to: vault, abi: ABI, fn: "releasable", args: [token] }, { to: vault, abi: ABI, fn: "vestingTerms", args: [token] },
  ]));
  vestCalls.forEach((c, i) => {
    const raw = vestShare(v[i * 2], v[i * 2 + 1], address);
    if (v[i * 2] == null || v[i * 2 + 1] == null) errors.push(`vault ${c.vault} ${c.token}: unreadable vest`);
    if (raw > 0n) rawRows.push({ ...c, raw, category: "vesting" });
  });
  const held = [...new Set(rawRows.map((r) => r.token).filter((t) => t !== ZERO))];
  const [meta, px] = await Promise.all([
    multiOn(ctx, "robinhood", held.flatMap((to) => [{ to, abi: ABI, fn: "decimals" }, { to, abi: ABI, fn: "symbol" }])),
    pricesOf(ctx, ["coingecko:ethereum", ...held.map((t) => `robinhood:${t}`)]),
  ]);
  const metas = new Map(held.map((token, i) => [token, { dec: meta[i * 2], symbol: meta[i * 2 + 1] }]));
  const items = [];
  for (const row of rawRows) {
    const m = row.token === ZERO ? { dec: 18, symbol: "ETH" } : metas.get(row.token);
    if (m?.dec == null || Number(m.dec) > 36) { errors.push(`${row.token}: decimals unreadable`); continue; }
    const amount = units(row.raw, m.dec), key = row.token === ZERO ? "coingecko:ethereum" : `robinhood:${row.token}`;
    const price = trustedPrice(px, key), vest = row.category === "vesting";
    items.push({ category: row.category, chain: "robinhood", protocol: "Pons v2", token: row.token, asset: m.symbol || row.token,
      amount, usd: price == null ? null : round(amount * price), status: "ready", position: `${row.escrow || row.vault}:${row.token}`,
      action: vest ? `release the vested buyback tokens from vault ${row.vault}, then claimToken(${row.token}) from the Pons fee escrow` : row.token === ZERO ? `claim the ETH fees from Pons escrow ${row.escrow}` : `claimToken(${row.token}) from Pons escrow ${row.escrow}`,
      how_to_claim: `https://ponsfamily.com/profile/${address}`,
      detail: vest ? `this wallet's share of unreleased vested tokens, using the vault's snapshotted beneficiary terms; already-credited escrow fees are separate` : `unwithdrawn ${m.symbol || row.token} fees in Pons escrow ${row.escrow}; unswept curve/hook fees are not included`,
    });
  }
  const truncated = profile.launchesTruncated || allLaunchTokens.length > launchTokens.length;
  return { items, errors, coverage: { status: discoveryFailed || truncated ? "truncated" : errors.length ? "failed" : "complete",
    ...(discoveryFailed || truncated ? { reason: discoveryFailed ? "launch discovery unavailable; registered quote escrows still checked" : "Pons launch discovery was truncated" } : {}),
    escrows: escrows.length, quote_assets: tokens.length, launch_tokens: launchTokens.length,
    scope: "v2 escrow balances for registered quote assets and discovered launch tokens; v2 buybacks of profile launches and explicit tokens" } };
}
