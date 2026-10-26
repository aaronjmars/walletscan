// forgotten/lockers.mjs - token lockers and launchpad creator fees the other readers miss (read 2026-10-22):
//   pinkLocks  PinkSale's PinkLock (v1, v2 PinkLock02, v3 PinkLock03) on Ethereum, BSC, Base, Arbitrum, Polygon,
//              Avalanche: locks past their unlock date (or the vested part of a vesting lock) never unlocked. Only a
//              trusted price counts: a plain token needs a DefiLlama price with confidence >= 0.9 (most locked memecoins
//              have none and are left out), an LP token counts only the legs of its pair that have one
//   hoodLocks  HoodLock on Robinhood Chain (hoodlock.tech): token locks past their unlock time, vested and unclaimed
//              schedules, and liquidity-position locks past their unlock time (listed as a hint, no amount)
//   klikFees   Klik (klik.finance) launches on Base, Robinhood Chain and Ethereum: the ETH creator fees a claim pays
//              now, read by simulating collectFees(token) from the wallet (it reverts for anyone else)
//   bankrFees  Bankr launches on Doppler (Base, Robinhood Chain, Arbitrum): creator fees not claimed, from Bankr's
//              public fee API (rewards.bankr_creator_fees). Bankr's Clanker launches are left out (Zerion lists Clanker fees)
// Thruster positions inside lockers (Blast) were checked 2026-10-22 and not built: an ownerOf sweep of all 240,356
// Thruster v3 NFTs found no UNCX, Team Finance or Thruster locker among the holders. The biggest contract holder is
// Particle's leverage AMM (0x121B5ac4, 9,223 NFTs, about $4,750 in all), whose every exit needs a signature from
// Particle's offline backend; the only locker of Thruster v2 LP (OpenLeverage xOLE, OLE/WETH) holds about $4k over 664
// expired locks, about $7 a wallet. Thruster NFTs held by the wallet itself are rewards.blast.
import { readOn, multiOn, rpcOn, pricesOf, trustedPrice, tokenKey, needEvm, units, round, errText, writeLink } from "./anyrpc.mjs";
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";

const now = () => Math.floor(Date.now() / 1000);
const day = (t) => new Date(Number(t) * 1000).toISOString().slice(0, 10);
const ERC20 = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const PAIR = ["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112, uint112, uint32)", "function totalSupply() view returns (uint256)"];

// decimals + symbol per token (null when the token does not answer)
async function meta(ctx, chain, tokens) {
  const list = [...new Set(tokens.map((t) => t.toLowerCase()))];
  const r = list.length ? await multiOn(ctx, chain, list.flatMap((t) => [{ to: t, abi: ERC20, fn: "decimals" }, { to: t, abi: ERC20, fn: "symbol" }])) : [];
  return new Map(list.map((t, i) => [t, { decimals: r[2 * i] == null ? null : Number(r[2 * i]), symbol: r[2 * i + 1] }]));
}

// ---- PinkLock ------------------------------------------------------------------------------------------------
// lockers found from PinkSale's deployer (0x8026...5605) on each chain; v1 locks have one unlockDate, v2 / v3 can vest
// (tgeDate + cycles) and answer withdrawableTokens(lockId)
const PINK = {
  ethereum: [["0x71B5759d73262FBb223956913ecF4ecC51057641", 2], ["0x29AEd81d274f94CEa037d05Bb61eB93223A48a77", 2], ["0x33d4cC8716Beb13F814F538Ad3b2de3b036f5e2A", 1]],
  bsc: [["0x407993575c91ce7643a4d4cCACc9A98c36eE1BBE", 2], ["0x7ee058420e5937496F5a2096f04caA7721cF70cc", 1]],
  base: [["0xdD6E31A046b828CbBAfb939C2a394629aff8BBdC", 2]],
  arbitrum: [["0xeBb415084Ce323338CFD3174162964CC23753dFD", 2]],
  polygon: [["0x6C9A0D8B1c7a95a323d744dE30cf027694710633", 2], ["0x5fb71Dbf7248a01bf96cE2AB2DA34EEAbE58c261", 1]],
  avalanche: [["0x9479C6484a392113bB829A15E7c9E033C9e70D30", 2], ["0x4DffB05d1Bc222A2852799e2076e956acb589322", 1]],
};
const PINK_APP = "https://www.pinksale.finance/pinklock";
const PINK_ABI = {
  2: [
    "struct L { uint256 id; address token; address owner; uint256 amount; uint256 lockDate; uint256 tgeDate; uint256 tgeBps; uint256 cycle; uint256 cycleBps; uint256 unlockedAmount; string description; }",
    "function normalLocksForUser(address user) view returns (L[])", "function lpLocksForUser(address user) view returns (L[])", "function withdrawableTokens(uint256 lockId) view returns (uint256)",
  ],
  1: [
    "struct L { uint256 id; address token; address owner; uint256 amount; uint256 lockDate; uint256 unlockDate; }",
    "function normalLocksForUser(address user) view returns (L[])", "function lpLocksForUser(address user) view returns (L[])",
  ],
};

async function pinkChain(ctx, chain, a) {
  const lockers = PINK[chain], t = now();
  const lists = await multiOn(ctx, chain, lockers.flatMap(([c, v]) => [{ to: c, abi: PINK_ABI[v], fn: "normalLocksForUser", args: [a] }, { to: c, abi: PINK_ABI[v], fn: "lpLocksForUser", args: [a] }]));
  let locks = [], running = 0;
  lockers.forEach(([c, v], i) => [0, 1].forEach((k) => {
    for (const l of lists[2 * i + k] || []) {
      const left = v === 1 ? l.amount : l.amount - l.unlockedAmount, opens = v === 1 ? l.unlockDate : l.tgeDate;
      if (left <= 0n) continue;
      if (Number(opens) > t) { running++; continue; }
      locks.push({ locker: c, v, lp: k === 1, id: l.id, token: l.token.toLowerCase(), raw: left, vesting: v === 2 && l.cycle > 0n, opens: day(opens) });
    }
  }));
  // a vesting lock pays only what has vested so far
  const vest = locks.filter((l) => l.v === 2);
  if (vest.length) {
    const w = await multiOn(ctx, chain, vest.map((l) => ({ to: l.locker, abi: PINK_ABI[2], fn: "withdrawableTokens", args: [l.id] })));
    vest.forEach((l, i) => { l.raw = w[i] ?? 0n; });
    locks = locks.filter((l) => l.raw > 0n);
  }
  if (!locks.length) return { items: [], running, unpriced: 0 };
  const lpTokens = [...new Set(locks.filter((l) => l.lp).map((l) => l.token))];
  const pr = lpTokens.length ? await multiOn(ctx, chain, lpTokens.flatMap((p) => PAIR.map((s) => ({ to: p, abi: PAIR, fn: s.match(/function (\w+)/)[1] })))) : [];
  const pair = new Map(lpTokens.map((p, i) => [p, { t0: pr[4 * i]?.toLowerCase(), t1: pr[4 * i + 1]?.toLowerCase(), res: pr[4 * i + 2], supply: pr[4 * i + 3] }]));
  const tokens = [...new Set([...locks.map((l) => l.token), ...[...pair.values()].flatMap((x) => [x.t0, x.t1]).filter(Boolean)])];
  const [m, px] = await Promise.all([meta(ctx, chain, tokens), pricesOf(ctx, tokens.map((x) => tokenKey(chain, x)))]);
  const price = (x) => trustedPrice(px, tokenKey(chain, x));
  const items = [];
  let unpriced = 0;
  for (const l of locks) {
    const tm = m.get(l.token) || {}, dec = tm.decimals ?? 18;
    const base = {
      category: l.vesting ? "vesting" : "unstake_ready", chain, protocol: "PinkLock", token: l.token, status: "ready", deadline: null,
      action: `unlock lock ${l.id} on PinkLock (unlock(${l.id}) on ${l.locker})`, how_to_claim: PINK_APP,
    };
    const p = pair.get(l.token);
    if (l.lp && p?.t0 && p.res && p.supply > 0n) {
      // an LP token is worth its share of the pair's reserves; a leg without a trusted price counts 0
      const share = Number(l.raw) / Number(p.supply);
      const legs = [[p.t0, p.res[0]], [p.t1, p.res[1]]].map(([x, r]) => {
        const lm = m.get(x) || {}, amount = units(r, lm.decimals ?? 18) * share, pp = price(x);
        return { token: x, asset: lm.symbol || null, amount: round(amount, 8), usd: pp == null ? null : round(amount * pp) };
      });
      const priced = legs.filter((g) => g.usd != null);
      if (!priced.length) { unpriced++; continue; }
      items.push({
        ...base, asset: `${legs[0].asset}/${legs[1].asset} LP`, amount: round(units(l.raw, dec), 8), usd: round(priced.reduce((s, g) => s + g.usd, 0)), legs, unpriced: legs.length - priced.length,
        detail: `PinkLock LP lock ${l.id} (${l.vesting ? "vesting, vested part" : `unlocked ${l.opens}`}): ${l.locker} on ${chain}; unlock it, then remove the liquidity of pair ${l.token}; write page ${writeLink(chain, l.locker)}`,
      });
      continue;
    }
    const pp = price(l.token);
    if (pp == null || tm.decimals == null) { unpriced++; continue; }
    const amount = units(l.raw, dec);
    items.push({
      ...base, asset: tm.symbol || null, amount: round(amount, 8), usd: round(amount * pp),
      detail: `PinkLock token lock ${l.id} (${l.vesting ? "vesting, vested part" : `unlocked ${l.opens}`}) on ${l.locker} (${chain}); write page ${writeLink(chain, l.locker)}`,
    });
  }
  return { items, running, unpriced };
}

export async function pinkLocks(p, ctx) {
  needEvm(p);
  const errors = [], items = [];
  let running = 0, unpriced = 0;
  await Promise.all(Object.keys(PINK).map((c) => pinkChain(ctx, c, p.address).then((r) => { items.push(...r.items); running += r.running; unpriced += r.unpriced; }, (e) => errors.push(`${c}: ${errText(e)}`))));
  if (errors.length === Object.keys(PINK).length) throw { status: 502, error: errors.join("; ") };
  return { items, running_locks: running, unpriced_locks: unpriced, errors };
}

// ---- HoodLock (Robinhood Chain) ------------------------------------------------------------------------------
// addresses from hoodlock.tech's own app config (locker, vesting, lpLocker), contracts verified on the explorer
const HOOD = {
  locker: "0xd0f7d8c6e9f6d80c297bebe4f7fd1b9c8125c32f", vesting: "0x910e19bcc4bce46999994ed7297e0fc4431ec72e", lpLocker: "0x91aa2da1956c77f8448e18dcaf53383bcc658e67",
  app: "https://hoodlock.tech/app", explorer: "https://robinhoodchain.blockscout.com",
};
const HOOD_ABI = [
  "struct L { address owner; address token; uint256 amount; uint256 unlockTime; bool withdrawn; }",
  "function locksByOwner(address o) view returns (uint256[])", "function getLock(uint256 id) view returns (L)",
  "struct S { address creator; uint64 start; address beneficiary; uint64 cliff; address token; uint64 end; uint128 total; uint128 claimed; }",
  "function schedulesByBeneficiary(address b) view returns (uint256[])", "function getSchedule(uint256 id) view returns (S)", "function claimable(uint256 id) view returns (uint256)",
];
const HOOD_LP = [
  "struct P { address owner; uint40 unlockTime; uint16 collectFeeBps; bool isV4; bool hookVerified; bool withdrawn; address feeRecipient; address token0; address token1; uint256 tokenId; }",
  "function locksOf(address owner) view returns (uint256[])", "function getLock(uint256 id) view returns (P)",
];

export async function hoodLocks(p, ctx) {
  needEvm(p);
  const a = p.address, c = "robinhood", H = HOOD, t = now();
  const [lockIds, schedIds, lpIds] = await multiOn(ctx, c, [
    { to: H.locker, abi: HOOD_ABI, fn: "locksByOwner", args: [a] }, { to: H.vesting, abi: HOOD_ABI, fn: "schedulesByBeneficiary", args: [a] }, { to: H.lpLocker, abi: HOOD_LP, fn: "locksOf", args: [a] },
  ]);
  if (lockIds == null && schedIds == null && lpIds == null) throw { status: 502, error: "HoodLock contracts did not answer" };
  const L = (lockIds || []).slice(-100), S = (schedIds || []).slice(-100), P = (lpIds || []).slice(-50);
  if (!L.length && !S.length && !P.length) return { items: [], running_locks: 0, errors: [] };
  const r = await multiOn(ctx, c, [
    ...L.map((id) => ({ to: H.locker, abi: HOOD_ABI, fn: "getLock", args: [id] })),
    ...S.flatMap((id) => [{ to: H.vesting, abi: HOOD_ABI, fn: "getSchedule", args: [id] }, { to: H.vesting, abi: HOOD_ABI, fn: "claimable", args: [id] }]),
    ...P.map((id) => ({ to: H.lpLocker, abi: HOOD_LP, fn: "getLock", args: [id] })),
  ]);
  let running = 0;
  const raw = [];
  L.forEach((id, i) => {
    const l = r[i];
    if (!l || l.withdrawn || l.amount === 0n || l.owner.toLowerCase() !== a.toLowerCase()) return;
    if (Number(l.unlockTime) > t) { running++; return; }
    raw.push({ kind: "lock", id, token: l.token.toLowerCase(), raw: l.amount, when: day(l.unlockTime) });
  });
  S.forEach((id, i) => {
    const s = r[L.length + 2 * i], cl = r[L.length + 2 * i + 1];
    if (!s || !(cl > 0n) || s.beneficiary.toLowerCase() !== a.toLowerCase()) return;
    raw.push({ kind: "vest", id, token: s.token.toLowerCase(), raw: cl, self: s.creator.toLowerCase() === a.toLowerCase(), left: s.total - s.claimed - cl, end: day(s.end) });
  });
  const lp = [];
  P.forEach((id, i) => {
    const l = r[L.length + 2 * S.length + i];
    if (!l || l.withdrawn || l.owner.toLowerCase() !== a.toLowerCase()) return;
    if (Number(l.unlockTime) > t) { running++; return; }
    lp.push({ id, l });
  });
  const [m, px] = await Promise.all([meta(ctx, c, [...raw.map((x) => x.token), ...lp.flatMap((x) => [x.l.token0, x.l.token1])]), pricesOf(ctx, raw.map((x) => tokenKey(c, x.token)))]);
  const items = [];
  for (const x of raw) {
    const tm = m.get(x.token) || {};
    if (tm.decimals == null) continue;
    const amount = units(x.raw, tm.decimals), pp = trustedPrice(px, tokenKey(c, x.token));
    const lock = x.kind === "lock";
    items.push({
      category: lock ? "unstake_ready" : "vesting", chain: c, protocol: "HoodLock", asset: tm.symbol || null, token: x.token, amount: round(amount, 8), usd: pp == null ? null : round(amount * pp), status: "ready", deadline: null,
      action: lock ? `withdraw HoodLock lock ${x.id} (Withdraw in the HoodLock app, withdraw(${x.id}) on the locker)` : `claim HoodLock vesting schedule ${x.id} (Claim in the HoodLock app, claim(${x.id}) on the vesting contract)`,
      how_to_claim: H.app,
      detail: lock ? `token lock ${x.id} on ${H.locker}, unlocked ${x.when} and never withdrawn; ${H.explorer}/address/${H.locker}?tab=write_contract`
        : `vesting schedule ${x.id} on ${H.vesting}: vested and not claimed${x.self ? " (a schedule this wallet made for itself)" : ""}; ${round(units(x.left, tm.decimals), 4)} more vests until ${x.end}`,
    });
  }
  for (const { id, l } of lp) {
    const s0 = m.get(l.token0.toLowerCase())?.symbol || "?", s1 = m.get(l.token1.toLowerCase())?.symbol || "?";
    items.push({
      category: "unstake_ready", chain: c, protocol: "HoodLock", asset: `${s0}/${s1} ${l.isV4 ? "v4" : "v3"} position`, amount: 1, usd: null, status: "hint", deadline: null,
      action: `withdraw HoodLock liquidity lock ${id} (the position NFT #${l.tokenId} comes back, then remove its liquidity)`, how_to_claim: H.app,
      detail: `liquidity-position lock ${id} on ${H.lpLocker} unlocked ${day(l.unlockTime)} and never withdrawn; position #${l.tokenId} (${l.isV4 ? "Uniswap v4" : "Uniswap v3"}), value not read`,
    });
  }
  return { items, running_locks: running, errors: [] };
}

// ---- Klik creator fees ---------------------------------------------------------------------------------------
// Klik's launchers (from klik.finance's app config). Each answers getAllTokensByCreator(creator); collectFees(token)
// pays the token's creator fees in ETH and reverts for anyone but the current fee receiver, so an eth_call from the
// wallet returns exactly what a claim pays now. On Robinhood Chain and the Ethereum launcher the ETH waits in the token
// contract, on Base in the launcher. Klik's newer Uniswap v4 launchers (KlikFactory on Ethereum, Unichain, Arbitrum,
// Avalanche, Monad, Ink, X Layer) keep fees elsewhere and are not read here
const KLIK = { base: "0xC7A3b937E24087cFC8aD64A23326a989A3D03011", robinhood: "0x16cF6788B762EE8969744586eD16fc5705140dd7", ethereum: "0x254Bf550657040f78608476cE9AaD820aB2266ad" };
const KLIK_ABI = parseAbi(["function getAllTokensByCreator(address creator) view returns (address[])", "function collectFees(address token) returns (uint256)"]);
const KLIK_APP = "https://klik.finance";

async function klikChain(ctx, chain, a) {
  const launcher = KLIK[chain];
  const tokens = (await readOn(ctx, chain, launcher, KLIK_ABI, "getAllTokensByCreator", [a])).slice(-25);
  if (!tokens.length) return [];
  const pays = await Promise.all(tokens.map(async (t) => {
    const data = encodeFunctionData({ abi: KLIK_ABI, functionName: "collectFees", args: [t] });
    // a revert (no fees, or the fee receiver changed hands) is no claim
    const out = await rpcOn(ctx, chain, "eth_call", [{ from: a, to: launcher, data }, "latest"]).catch(() => null);
    return out ? decodeFunctionResult({ abi: KLIK_ABI, functionName: "collectFees", data: out }) : 0n;
  }));
  const open = tokens.map((t, i) => ({ t: t.toLowerCase(), wei: pays[i] })).filter((x) => x.wei > 0n);
  if (!open.length) return [];
  const [m, px] = await Promise.all([meta(ctx, chain, open.map((x) => x.t)), pricesOf(ctx, ["coingecko:ethereum"])]);
  const eth = trustedPrice(px, "coingecko:ethereum");
  return open.map(({ t, wei }) => {
    const amount = units(wei, 18), sym = m.get(t)?.symbol || t.slice(0, 10);
    return {
      category: "creator_fees", chain, protocol: "Klik", asset: "ETH", amount: round(amount, 8), usd: eth == null ? null : round(amount * eth), status: "ready", deadline: null,
      action: `claim the creator fees of ${sym} on Klik (collectFees(${t}) on the Klik launcher ${launcher})`, how_to_claim: KLIK_APP,
      detail: `creator fees of ${sym} (${t}) launched on Klik, not collected; collectFees pays them to the token's fee receiver only; write page ${chain === "robinhood" ? `${HOOD.explorer}/address/${launcher}` : writeLink(chain, launcher)}`,
    };
  });
}

export async function klikFees(p, ctx) {
  needEvm(p);
  const errors = [], items = [];
  await Promise.all(Object.keys(KLIK).map((c) => klikChain(ctx, c, p.address).then((xs) => items.push(...xs), (e) => errors.push(`${c}: ${errText(e)}`))));
  if (errors.length === Object.keys(KLIK).length) throw { status: 502, error: errors.join("; ") };
  return { items, errors };
}

// ---- Bankr creator fees (Doppler launches) -------------------------------------------------------------------
// Bankr's public fee API reads the Doppler fee managers onchain for the 50 latest launches where the wallet is the
// creator beneficiary; amounts come as decimal strings. A claim (collectFees(poolId) on the fees manager) pays both legs
const BANKR_CHAIN = { base: "base", robinhood: "robinhood", arbitrum: "arbitrum" };

export async function bankrFees(p, ctx) {
  needEvm(p);
  const r = await ctx.call("rewards.bankr_creator_fees", { address: p.address.toLowerCase() });
  if (!r.ok) throw { status: 502, error: `step rewards.bankr_creator_fees failed (upstream ${r.status})`, detail: r.data };
  const rows = (r.data?.tokens || []).filter((x) => x.source === "doppler" && (Number(x.claimable?.token0) > 0 || Number(x.claimable?.token1) > 0));
  if (!rows.length) return { items: [], errors: [] };
  const chainOf = (x) => BANKR_CHAIN[x.chain] || "base";
  // leg addresses: the launched token and the numeraire (quote), in pool order
  const legsOf = (x) => { const tok = x.tokenAddress.toLowerCase(), num = String(x.numeraire || "").toLowerCase(); return x.tokenIsToken0 ? [tok, num] : [num, tok]; };
  const px = await pricesOf(ctx, rows.flatMap((x) => legsOf(x).filter((t) => /^0x[0-9a-f]{40}$/.test(t)).map((t) => tokenKey(chainOf(x), t))));
  const items = rows.map((x) => {
    const chain = chainOf(x), addrs = legsOf(x);
    const legs = [[addrs[0], x.token0Label, x.claimable.token0], [addrs[1], x.token1Label, x.claimable.token1]].map(([token, asset, v]) => {
      const amount = Number(v) || 0, pp = /^0x[0-9a-f]{40}$/.test(token) ? trustedPrice(px, tokenKey(chain, token)) : null;
      return { token: token || null, asset, amount: round(amount, 8), usd: pp == null ? null : round(amount * pp) };
    }).filter((g) => g.amount > 0);
    const priced = legs.filter((g) => g.usd != null);
    const quote = legs.find((g) => g.token === addrs[x.tokenIsToken0 ? 1 : 0]) || legs[0];
    const where = x.feesContract || x.initializer;
    return {
      category: "creator_fees", chain, protocol: "Bankr", asset: legs.map((g) => g.asset).join(" + "), token: quote.token, amount: quote.amount, usd: priced.length ? round(priced.reduce((s, g) => s + g.usd, 0)) : null,
      legs, unpriced: legs.length - priced.length, status: "ready", deadline: null,
      action: `claim the creator fees of ${x.symbol} (Claim fees in the Bankr terminal, or collectFees(${x.poolId}) on ${where})`, how_to_claim: "https://bankr.bot/terminal",
      detail: `Bankr launch ${x.symbol} (${x.tokenAddress}) on ${chain}: creator share ${x.share} of the pool fees, not claimed; Bankr's /public/doppler/build-claim builds the transaction for an outside wallet`,
    };
  });
  return { items, errors: [] };
}
