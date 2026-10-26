// forgotten/venft.mjs - Aerodrome (Base) and Velodrome (Optimism) veNFTs (read 2026-10-20) through the protocols' own
// Sugar view contracts (velodrome-finance/sugar, deployments/*.env): VeSugar.byAccount lists the wallet's locks with
// the rebase each can claim; the voting fees and bribes come from earned(token, id) on each pool's fee and bribe contracts.
// Pools: the ones voted now, plus every pool the veNFT ever voted for (the Voter's Voted logs, needs ALCHEMY_API_KEY),
// since a vote reset leaves its rewards behind. A lock past its end (not permanent) can be withdrawn.
import { isEvmAddr } from "../solana.mjs";
import { read, multi, prices, trusted, units, writeLink, ZERO } from "./evm.mjs";

export const VE = {
  base: {
    protocol: "Aerodrome", token: "0x940181a94A35A4569E4529A3CDfB74e38FD98631", symbol: "AERO", ve: "0xeBf418Fe2512e7E6bd9b87a8F0f294aCDC67e6B4", voter: "0x16613524e02ad97eDfeF371bC883F2F5d6C480A5",
    veSugar: "0x4d6A741cEE6A8cC5632B2d948C050303F6246D24", alchemy: "base-mainnet", app: "https://aerodrome.finance/dash",
  },
  optimism: {
    protocol: "Velodrome", token: "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db", symbol: "VELO", ve: "0xFAf8FD17D9840595845582fCB047DF13f006787d", voter: "0x41C914ee0c7E1A5edCD0295623e6dC557B5aBf3C",
    veSugar: "0xFE0a44d356a9F52c9F1bE0ba0f0877d986438c9C", alchemy: "opt-mainnet", app: "https://velodrome.finance/dash",
  },
};
const VE_ABI = [
  "struct LpVotes { address lp; uint256 weight; }",
  "struct VeNFT { uint256 id; address account; uint8 decimals; uint128 amount; uint256 voting_amount; uint256 governance_amount; uint256 rebase_amount; uint256 expires_at; uint256 voted_at; LpVotes[] votes; address token; bool permanent; uint256 delegate_id; uint256 managed_id; }",
  "function byAccount(address) view returns (VeNFT[])",
];
const VOTER = ["function gauges(address) view returns (address)", "function gaugeToFees(address) view returns (address)", "function gaugeToBribe(address) view returns (address)"];
const REWARD = ["function rewardsListLength() view returns (uint256)", "function rewards(uint256) view returns (address)", "function earned(address token, uint256 tokenId) view returns (uint256)"];
const ERC20 = ["function decimals() view returns (uint8)", "function symbol() view returns (string)"];
const VOTED = "0x452d440efc30dfa14a0ef803ccb55936af860ec6a6960ed27f129bef913f296a"; // Voted(address indexed voter, address indexed pool, uint256 indexed tokenId, uint256 weight, uint256 totalWeight, uint256 timestamp)
const WEEK = 7 * 86400;

// every pool these veNFTs ever voted for, from the Voter's logs (one eth_getLogs, ids OR-ed in topic 3)
async function votedPools(ctx, cfg, ids) {
  const topic = ids.map((id) => `0x${id.toString(16).padStart(64, "0")}`);
  const r = await ctx.call("evm.alchemy_rpc", { network: cfg.alchemy }, { body: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: cfg.voter, topics: [VOTED, null, null, topic], fromBlock: "0x0", toBlock: "latest" }] } });
  if (!r.ok || r.data?.error) throw { status: 502, error: `Voted logs failed (upstream ${r.status})`, detail: r.data?.error };
  return (r.data.result || []).map((l) => [BigInt(l.topics[3]), `0x${l.topics[2].slice(26)}`]);
}

async function chainLocks(a, chain, ctx, nowS) {
  const cfg = VE[chain];
  const locks = (await read(ctx, chain, cfg.veSugar, VE_ABI, "byAccount", [a])).filter((v) => v.id > 0n);
  if (!locks.length) return { items: [], errors: [] };
  const errors = [];
  // a lock deposited into a managed (relay) veNFT earns through that one: its own rewards are empty
  const own = locks.filter((v) => v.managed_id === 0n);
  const pairs = new Map(); // "id:pool" -> [id, pool]
  for (const v of own) for (const x of v.votes) pairs.set(`${v.id}:${x.lp.toLowerCase()}`, [v.id, x.lp]);
  if (own.length && ctx.live("evm.alchemy_rpc")) {
    try { for (const [id, pool] of await votedPools(ctx, cfg, own.map((v) => v.id))) pairs.set(`${id}:${pool.toLowerCase()}`, [id, pool]); } catch (e) { errors.push(`${chain} voted pools: ${String(e?.error || e?.message || e).slice(0, 100)}`); }
  }
  const list = [...pairs.values()];
  // fees + bribes per pool, read on the reward contracts themselves (RewardsSugar walks every token of a pool in one
  // call: over publicnode's 50M gas cap on busy pools, and it reverts on some): gauge -> fee + bribe contracts -> their
  // reward tokens -> earned(token, id)
  const pools = [...new Set(list.map(([, pool]) => pool.toLowerCase()))];
  const gauges = await multi(ctx, chain, pools.map((pool) => ({ to: cfg.voter, abi: VOTER, fn: "gauges", args: [pool] })));
  const live = pools.map((pool, i) => [pool, gauges[i]]).filter(([, g]) => g && g !== ZERO);
  const ends = await multi(ctx, chain, live.flatMap(([, g]) => [{ to: cfg.voter, abi: VOTER, fn: "gaugeToFees", args: [g] }, { to: cfg.voter, abi: VOTER, fn: "gaugeToBribe", args: [g] }]));
  const contracts = []; // { pool, to, kind }
  live.forEach(([pool], i) => [[ends[2 * i], "fees"], [ends[2 * i + 1], "bribes"]].forEach(([to, kind]) => { if (to && to !== ZERO) contracts.push({ pool, to, kind }); }));
  const lens = await multi(ctx, chain, contracts.map((c) => ({ to: c.to, abi: REWARD, fn: "rewardsListLength" })));
  const slots = contracts.flatMap((c, i) => Array.from({ length: Math.min(Number(lens[i] ?? 0n), 40) }, (_, k) => ({ c, k })));
  const toks = await multi(ctx, chain, slots.map(({ c, k }) => ({ to: c.to, abi: REWARD, fn: "rewards", args: [BigInt(k)] })));
  const asks = []; // { c, token, id }
  slots.forEach(({ c }, i) => { if (toks[i]) for (const [id, pool] of list) if (pool.toLowerCase() === c.pool) asks.push({ c, token: toks[i], id }); });
  // earned() walks every epoch since the last claim (1-2M gas each): 15 per Multicall3 stays under the 50M cap
  if (asks.length > 600) { errors.push(`${chain}: ${asks.length} reward reads, only the first 600 checked`); asks.length = 600; }
  const earned = await multi(ctx, chain, asks.map(({ c, token, id }) => ({ to: c.to, abi: REWARD, fn: "earned", args: [token, id] })), { batch: 15 });
  const byToken = new Map();
  asks.forEach(({ c, token, id }, i) => {
    const raw = earned[i];
    if (raw == null) { errors.push(`${chain} earned of veNFT ${id} on ${c.to}: not readable`); return; }
    if (!(raw > 0n)) return;
    const t = token.toLowerCase(), e = byToken.get(t) || byToken.set(t, { raw: 0n, ids: new Set(), pools: new Set(), kinds: new Set() }).get(t);
    e.raw += raw; e.ids.add(String(id)); e.pools.add(c.pool); e.kinds.add(c.kind);
  });
  const tokens = [...byToken.keys()];
  const meta = tokens.length ? await multi(ctx, chain, tokens.flatMap((to) => [{ to, abi: ERC20, fn: "decimals" }, { to, abi: ERC20, fn: "symbol" }])) : [];
  const llama = chain === "base" ? "base" : "optimism", veKey = `${llama}:${cfg.token.toLowerCase()}`;
  const px = await prices(ctx, [veKey, ...tokens.map((t) => `${llama}:${t}`)]);
  const price = (t) => trusted(px.get(`${llama}:${t}`))?.price ?? null, vePrice = price(cfg.token.toLowerCase());
  const items = [];
  tokens.forEach((t, i) => {
    const e = byToken.get(t), dec = meta[2 * i] ?? trusted(px.get(`${llama}:${t}`))?.decimals;
    if (dec == null) { errors.push(`${chain} reward token ${t}: no decimals`); return; }
    const amount = units(e.raw, dec), pr = price(t);
    items.push({
      category: "reward", chain, protocol: cfg.protocol, kind: [...e.kinds].join("+"), asset: meta[2 * i + 1] || t.slice(0, 8), token: t, amount: round6(amount), usd: pr == null ? null : round2(amount * pr), priced: pr != null,
      venft_ids: [...e.ids], pools: e.pools.size,
      action: `claim the ${[...e.kinds].join(" and ")} of veNFT ${[...e.ids].map((x) => `#${x}`).join(", ")} (Dashboard > Voting rewards > Claim)`, how_to_claim: cfg.app,
      detail: `${cfg.protocol} voting ${[...e.kinds].join(" and ")} earned in ${e.pools.size} pool${e.pools.size === 1 ? "" : "s"}, read with earned(token, id) on the fee and bribe contracts`,
    });
  });
  for (const v of own) {
    const amount = units(v.amount, 18), ended = !v.permanent && v.expires_at > 0n && Number(v.expires_at) <= nowS, rebase = units(v.rebase_amount, 18);
    if (rebase > 0) items.push({
      category: "reward", chain, protocol: cfg.protocol, kind: "rebase", asset: cfg.symbol, token: cfg.token.toLowerCase(), amount: round6(rebase), usd: vePrice == null ? null : round2(rebase * vePrice), priced: vePrice != null,
      venft_ids: [String(v.id)], into_lock: !ended,
      action: `claim the rebase of veNFT #${v.id} (Dashboard > Locks > Claim rebase)`, how_to_claim: cfg.app,
      detail: ended ? `rebase of an ended lock: claiming pays it to the wallet` : `rebase of veNFT #${v.id}: claiming adds it to the lock (locked, not spendable)`,
    });
    if (ended && amount > 0) {
      const votedNow = Number(v.voted_at) >= Math.floor(nowS / WEEK) * WEEK;
      items.push({
        category: "unstake_ready", chain, protocol: cfg.protocol, kind: "expired_lock", asset: cfg.symbol, token: cfg.token.toLowerCase(), amount: round6(amount), usd: vePrice == null ? null : round2(amount * vePrice), priced: vePrice != null,
        venft_ids: [String(v.id)], ends: new Date(Number(v.expires_at) * 1000).toISOString(), voted: v.votes.length > 0,
        action: `withdraw the ${cfg.symbol} of veNFT #${v.id}${v.votes.length ? " (reset its votes first)" : ""}`, how_to_claim: cfg.app,
        detail: `lock ended ${new Date(Number(v.expires_at) * 1000).toISOString().slice(0, 10)}; withdraw(${v.id}) on ${writeLink(chain, cfg.ve)}${v.votes.length ? `, after Voter.reset(${v.id})${votedNow ? " (voted this epoch: reset works from the next one)" : ""}` : ""}`,
      });
    }
  }
  return { items, errors };
}

export async function veNfts(p, ctx) {
  if (p.address == null || p.address === "") throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
  const nowS = Math.floor(Date.now() / 1000);
  const items = [], errors = [];
  await Promise.all(Object.keys(VE).map(async (chain) => {
    try { const r = await chainLocks(p.address, chain, ctx, nowS); items.push(...r.items); errors.push(...r.errors); } catch (e) { errors.push(`${chain}: ${String(e?.error || e?.message || e).slice(0, 120)}`); }
  }));
  return { items, errors };
}

const round6 = (v) => (v == null ? null : Math.round(v * 1e6) / 1e6);
const round2 = (v) => (v == null ? null : Math.round(v * 100) / 100);
