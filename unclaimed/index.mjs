// unclaimed/ - money a wallet left in contracts it used, read straight from each protocol (found through the
// zkCodex Unclaimed Finder catalog, read 2026-10-20; zkcodex.com itself is never called at scan time):
//   bridge.polygon_zkevm   Polygon zkEVM sunset exit claims (Polygon's claimer API + isClaimed on the bridge)
//   rewards.hedgey         Hedgey vesting and lockup plan NFTs: what planBalanceOf says can be redeemed now
//   rewards.flaunch        Flaunch creator fees in the Base FeeEscrow
//   rewards.uniswap_fees   Uniswap v3 (simulated collect) and v4 (fee growth math) uncollected fees
//   rewards.superfluid     Superfluid distribution pool shares never claimed (getClaimableNow)
//   rewards.token_locks    UNCX token vesting, Team Finance locks past their unlock date, Unvest vesting tokens
// Every read is an eth_call (JSON-RPC batches through evm.rpc) or a keyless index; nothing signs or sends.
// Each function answers { items[] {protocol, chain, asset, token, amount, usd, ...}, ... } for findings.mjs.
import { encodeFunctionData, decodeFunctionResult, parseAbi, keccak256, encodeAbiParameters } from "viem";

// chain key (findings.mjs EVM_CHAINS name) -> publicnode host (evm.rpc {chain}), DefiLlama key, Alchemy network, native coin
export const CHAINS = {
  ethereum: { rpc: "ethereum", llama: "ethereum", alchemy: "eth-mainnet", native: "coingecko:ethereum" },
  base: { rpc: "base", llama: "base", alchemy: "base-mainnet", native: "coingecko:ethereum" },
  arbitrum: { rpc: "arbitrum-one", llama: "arbitrum", alchemy: "arb-mainnet", native: "coingecko:ethereum" },
  optimism: { rpc: "optimism", llama: "optimism", alchemy: "opt-mainnet", native: "coingecko:ethereum" },
  polygon: { rpc: "polygon-bor", llama: "polygon", alchemy: "polygon-mainnet", native: "coingecko:polygon-ecosystem-token" },
  unichain: { rpc: "unichain", llama: "unichain", alchemy: "unichain-mainnet", native: "coingecko:ethereum" },
  bsc: { rpc: "bsc", llama: "bsc", alchemy: "bnb-mainnet", native: "coingecko:binancecoin" },
  linea: { rpc: "linea", llama: "linea", alchemy: "linea-mainnet", native: "coingecko:ethereum" },
  scroll: { rpc: "scroll", llama: "scroll", alchemy: "scroll-mainnet", native: "coingecko:ethereum" },
  mantle: { rpc: "mantle", llama: "mantle", alchemy: "mantle-mainnet", native: "coingecko:mantle" },
  celo: { rpc: "celo", llama: "celo", alchemy: "celo-mainnet", native: "coingecko:celo" },
  gnosis: { rpc: "gnosis", llama: "xdai", alchemy: "gnosis-mainnet", native: "coingecko:xdai" },
  berachain: { rpc: "berachain", llama: "berachain", alchemy: "berachain-mainnet", native: "coingecko:berachain-bera" },
};
const ZERO = "0x0000000000000000000000000000000000000000";
const BATCH = 40;

const isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
const bad = (p) => { if (!isEvm(p.address)) throw { status: 400, error: "address must be an EVM 0x address" }; };
const units = (raw, dec) => Number(raw) / 10 ** Number(dec ?? 18);
const errText = (e) => String(e?.error || e?.message || e).slice(0, 120);

// one read = { to, abi, fn, args, from? }; answers come back decoded, null when the call reverted or the
// contract does not exist on that chain
const q = (to, abi, fn, args = [], from) => ({ to, abi, fn, args, from });
async function reads(ctx, chain, list) {
  const out = new Array(list.length).fill(null);
  // Polygon zkEVM has its own route: publicnode no longer serves it
  const [route, params] = chain === "polygon-zkevm" ? ["bridge.zkevm_rpc", {}] : ["evm.rpc", { chain: CHAINS[chain]?.rpc || chain }];
  for (let i = 0; i < list.length; i += BATCH) {
    const body = list.slice(i, i + BATCH).map((x, j) => ({
      jsonrpc: "2.0", id: i + j, method: "eth_call",
      params: [{ to: x.to, data: encodeFunctionData({ abi: x.abi, functionName: x.fn, args: x.args }), ...(x.from && { from: x.from }) }, "latest"],
    }));
    const r = await ctx.call(route, params, { body });
    if (!r.ok || !Array.isArray(r.data)) throw { status: 502, error: `${chain} RPC batch failed (upstream ${r.status})` };
    for (const a of r.data) {
      const x = list[a?.id];
      if (!x || !a.result || a.result === "0x") continue;
      try { out[a.id] = decodeFunctionResult({ abi: x.abi, functionName: x.fn, data: a.result }); } catch { /* not this contract */ }
    }
  }
  return out;
}

const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function balanceOf(address) view returns (uint256)"]);
// token address -> { symbol, decimals } (decimals null = not an ERC-20 we can read)
async function tokenMeta(ctx, chain, addrs) {
  const list = [...new Set(addrs.map((a) => a.toLowerCase()))].filter((a) => a !== ZERO);
  const res = await reads(ctx, chain, list.flatMap((a) => [q(a, erc20, "decimals"), q(a, erc20, "symbol")]));
  const out = new Map(list.map((a, i) => [a, { symbol: res[2 * i + 1] ?? null, decimals: res[2 * i] == null ? null : Number(res[2 * i]) }]));
  out.set(ZERO, { symbol: null, decimals: 18 });
  return out;
}

// DefiLlama prices: keys "chain:address" or "coingecko:id" -> Map(lowercase key -> { price, symbol, decimals })
async function prices(ctx, keys) {
  const all = [...new Set(keys.filter(Boolean).map((k) => k.toLowerCase()))], out = new Map();
  for (let i = 0; i < all.length; i += 60) {
    const r = await ctx.call("token.prices", { coins: all.slice(i, i + 60).join(",") }).catch(() => null);
    for (const [k, v] of Object.entries(r?.ok ? r.data?.coins || {} : {})) out.set(k.toLowerCase(), v);
  }
  return out;
}
const priceKey = (chain, token) => (String(token).toLowerCase() === ZERO ? CHAINS[chain].native : `${CHAINS[chain].llama}:${String(token).toLowerCase()}`);
// fill usd on rows { chain, token, amount } from one DefiLlama call
async function price(ctx, rows) {
  const px = await prices(ctx, rows.map((r) => r.price_key || priceKey(r.chain, r.token)));
  for (const r of rows) {
    const c = px.get(String(r.price_key || priceKey(r.chain, r.token)).toLowerCase());
    const p = c && (c.confidence ?? 1) >= 0.9 ? c.price : null; // a thin market (DefiLlama confidence under 0.9) is no price
    r.usd = p && r.amount != null ? r.amount * p : null;
    delete r.price_key;
  }
  return rows;
}

// run one read per chain in parallel; a chain whose RPC fails is named in errors, the rest still answer
async function perChain(chains, fn) {
  const items = [], errors = [];
  await Promise.all(chains.map((c) => fn(c).then((xs) => items.push(...xs), (e) => errors.push(`${c}: ${errText(e)}`))));
  return { items, errors };
}

// ---- Polygon zkEVM exit claims (Ethereum) ---------------------------------------------------------------------
// Polygon's claimer lists every exit leaf owed to a wallet after the zkEVM sunset (2026-07-03); isClaimed on the
// LxLy bridge says which were taken. origin_network 0 = a token native to Ethereum (or ETH), else a token born on
// zkEVM that the claim mints as its wrapped copy on Ethereum. getTokenWrappedAddress answers 0x0 when that copy was
// never deployed (the claim deploys it): such a leaf is not ETH; its name and decimals come from the token on zkEVM.
const ZKEVM_BRIDGE = "0x2a3DD3EB832aF982ec71669E178424b10Dca2EDe";
const zkevmAbi = parseAbi([
  "function isClaimed(uint32 leafIndex, uint32 sourceBridgeNetwork) view returns (bool)",
  "function getTokenWrappedAddress(uint32 originNetwork, address originTokenAddress) view returns (address)",
]);
async function zkevmExits(p, ctx) {
  bad(p);
  const r = await ctx.call("bridge.zkevm_claimer", { address: p.address });
  if (!r.ok) throw { status: 502, error: `step bridge.zkevm_claimer failed (upstream ${r.status})`, detail: r.data };
  const leaves = (r.data?.bridges || []).filter((b) => Number(b.leaf_type) === 0 && Number(b.destination_network) === 0 && BigInt(b.amount || 0) > 0n);
  if (!leaves.length) return { items: [], known: false };
  const claimed = await reads(ctx, "ethereum", leaves.map((b) => q(ZKEVM_BRIDGE, zkevmAbi, "isClaimed", [Number(b.deposit_count), 1])));
  const wrapped = await reads(ctx, "ethereum", leaves.map((b) => q(ZKEVM_BRIDGE, zkevmAbi, "getTokenWrappedAddress", [Number(b.origin_network), b.origin_token_address])));
  const unmapped = (b, i) => Number(b.origin_network) !== 0 && String(wrapped[i] || "").toLowerCase() === ZERO;
  const tokenOf = (b, i) => (Number(b.origin_network) === 0 ? b.origin_token_address.toLowerCase() : unmapped(b, i) ? null : String(wrapped[i] || "").toLowerCase() || null);
  const meta = await tokenMeta(ctx, "ethereum", leaves.map(tokenOf).filter(Boolean));
  const born = leaves.filter(unmapped).map((b) => b.origin_token_address);
  const own = born.length ? await tokenMeta(ctx, "polygon-zkevm", born).catch(() => new Map()) : new Map();
  const items = leaves.map((b, i) => {
    const token = tokenOf(b, i), m = unmapped(b, i) ? own.get(b.origin_token_address.toLowerCase()) : token ? meta.get(token) : null, eth = token === ZERO;
    return {
      protocol: "Polygon zkEVM", chain: "ethereum", deposit_count: Number(b.deposit_count), token, asset: eth ? "ETH" : m?.symbol || null,
      amount: m?.decimals == null ? null : units(b.amount, m.decimals), raw: String(b.amount), claimed: claimed[i] === true, read: claimed[i] != null,
      ...(unmapped(b, i) && { unmapped: true }),
      // a zkEVM-born token has no Ethereum market of its own: left unpriced
      price_key: Number(b.origin_network) === 0 && token ? priceKey("ethereum", token) : "none:none",
    };
  });
  await price(ctx, items);
  return { items, known: true };
}

// ---- Hedgey plans -------------------------------------------------------------------------------------------
// every plan is an ERC-721 (enumerable): tokenOfOwnerByIndex, then planBalanceOf(id, now, now) = what redeems now
// and what stays locked. Same addresses on most chains (hedgey.gitbook.io deployments, read 2026-10-20).
const HEDGEY = {
  "0x2CDE9919e81b20B4B33DD562a48a84b54C48F00C": "vesting", "0x1bb64AF7FE05fc69c740609267d2AbE3e119Ef82": "vesting",
  "0x1961A23409CA59EEDCA6a99c97E4087DaD752486": "lockup", "0x73cD8626b3cD47B009E68380720CFE6679A3Ec3D": "lockup",
  "0xA600EC7Db69DFCD21f19face5B209a55EAb7a7C0": "lockup", "0xdE8465D44eBfC761Ee3525740E06C916886E1aEB": "lockup",
  "0x06B6D0AbD9dfC7F04F478B089FD89d4107723264": "lockup", "0x38E74A3DA3bd27dd581d5948ba19F0f684a5272f": "lockup",
};
const HEDGEY_CHAINS = ["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc", "linea", "scroll", "mantle", "celo", "gnosis", "berachain"];
const HEDGEY_MAX = 30; // plans read per contract
const hedgeyAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function plans(uint256) view returns (address token, uint256 amount)",
  "function planBalanceOf(uint256 planId, uint256 timeStamp, uint256 redemptionTime) view returns (uint256 balance, uint256 remainder, uint256 latestUnlock)",
]);
async function hedgeyPlans(p, ctx) {
  bad(p);
  const a = p.address, now = BigInt(Math.floor(Date.now() / 1000)), contracts = Object.keys(HEDGEY);
  const { items, errors } = await perChain(HEDGEY_CHAINS, async (chain) => {
    const counts = await reads(ctx, chain, contracts.map((c) => q(c, hedgeyAbi, "balanceOf", [a])));
    const idx = contracts.flatMap((c, i) => Array.from({ length: Math.min(HEDGEY_MAX, Number(counts[i] || 0n)) }, (_, k) => [c, k]));
    if (!idx.length) return [];
    const ids = await reads(ctx, chain, idx.map(([c, k]) => q(c, hedgeyAbi, "tokenOfOwnerByIndex", [a, BigInt(k)])));
    const plans = idx.map(([c], i) => [c, ids[i]]).filter(([, id]) => id != null);
    const res = await reads(ctx, chain, plans.flatMap(([c, id]) => [q(c, hedgeyAbi, "plans", [id]), q(c, hedgeyAbi, "planBalanceOf", [id, now, now])]));
    const meta = await tokenMeta(ctx, chain, plans.map((_, i) => res[2 * i]?.[0]).filter(Boolean));
    return plans.map(([c, id], i) => {
      const token = String(res[2 * i]?.[0] || "").toLowerCase(), bal = res[2 * i + 1], m = meta.get(token);
      if (!token || !bal || m?.decimals == null) return null;
      return {
        protocol: "Hedgey", chain, contract: c, kind: HEDGEY[c], plan_id: String(id), token, asset: m.symbol,
        amount: units(bal[0], m.decimals), locked: units(bal[1], m.decimals), next_unlock: Number(bal[2]) ? new Date(Number(bal[2]) * 1000).toISOString().slice(0, 10) : null,
      };
    }).filter(Boolean);
  });
  await price(ctx, items);
  return { items, errors };
}

// ---- Flaunch creator fees (Base) ----------------------------------------------------------------------------
const FLAUNCH_ESCROW = "0x72e6f7948b1b1a343b477f39aabd2e35e6d27dde";
const flaunchAbi = parseAbi(["function balances(address) view returns (uint256)"]);
async function flaunchFees(p, ctx) {
  bad(p);
  const [wei] = await reads(ctx, "base", [q(FLAUNCH_ESCROW, flaunchAbi, "balances", [p.address])]);
  const eth = wei ? units(wei, 18) : 0;
  const items = eth > 0 ? await price(ctx, [{ protocol: "Flaunch", chain: "base", token: ZERO, asset: "ETH", amount: eth, contract: FLAUNCH_ESCROW }]) : [];
  return { items, claimable_eth: eth };
}

// ---- Uniswap v3 + v4 uncollected fees -------------------------------------------------------------------------
// positions from Alchemy's NFT API (v4 PositionManager is not enumerable). v3: collect() simulated as the owner =
// fees + tokens left in a closed position. v4: (feeGrowthInside now - at last touch) x liquidity / 2^128 per token,
// from StateView; a hook can change what a position is paid, so v4 is an estimate.
const UNI = {
  ethereum: { v3: "0xc36442b4a4522e871399cd717abdd847ab11fe88", v4: "0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e", sv: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227" },
  base: { v3: "0x03a520b32c04bf3beef7beb72e919cf822ed34f1", v4: "0x7c5f5a4bbd8fd63184577525326123b519429bdc", sv: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71" },
  arbitrum: { v3: "0xc36442b4a4522e871399cd717abdd847ab11fe88", v4: "0xd88f38f930b7952f2db2432cb002e7abbf3dd869", sv: "0x76fd297e2d437cd7f76d50f01afe6160f86e9990" },
  optimism: { v3: "0xc36442b4a4522e871399cd717abdd847ab11fe88", v4: "0x3c3ea4b57a46241e54610e5f022e5c45859a1017", sv: "0xc18a3169788f4f75a170290584eca6395c75ecdb" },
  polygon: { v3: "0xc36442b4a4522e871399cd717abdd847ab11fe88", v4: "0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9", sv: "0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a" },
  unichain: { v3: "0x943e6e07a7e8e791dafc44083e54041d743c46e9", v4: "0x4529a01c7a0410167c5740c487a8de60232617bf", sv: "0x86e8631a016f9068c3f085faf484ee3f5fdee8f2" },
  bsc: { v3: "0x7b8a01b39d58278b5de7e48c8449c9f4f5170613", v4: "0x7a4a5c919ae2541aed11041a1aeee68f1287f95b", sv: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4" },
};
const MAX128 = (1n << 128n) - 1n;
const uniAbi = parseAbi([
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }",
  "function collect(CollectParams params) returns (uint256 amount0, uint256 amount1)",
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "function getPoolAndPositionInfo(uint256 tokenId) view returns (PoolKey poolKey, uint256 info)",
  "function getPositionInfo(bytes32 poolId, address owner, int24 tickLower, int24 tickUpper, bytes32 salt) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
  "function getFeeGrowthInside(bytes32 poolId, int24 tickLower, int24 tickUpper) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
]);
const int24 = (v) => { const x = Number(v & 0xffffffn); return x >= 0x800000 ? x - 0x1000000 : x; };
const M256 = (1n << 256n) - 1n;
// v4 fees owed for one position (pure, exported for the test): growth deltas wrap like the contract's unchecked math
export const v4Owed = (now, last, liquidity) => (((now - last) & M256) * liquidity) >> 128n;
export const v4Ticks = (info) => ({ tickLower: int24(info >> 8n), tickUpper: int24(info >> 32n) });
async function uniswapFees(p, ctx) {
  bad(p);
  const a = p.address;
  const { items, errors } = await perChain(Object.keys(UNI), async (chain) => {
    const u = UNI[chain];
    const r = await ctx.call("evm.alchemy_nfts", { network: CHAINS[chain].alchemy, owner: a, v3: u.v3, v4: u.v4 });
    if (!r.ok) throw { error: `Alchemy NFTs ${r.status}` };
    const nfts = (r.data?.ownedNfts || []).slice(0, 100);
    const of = (n) => String(n.contractAddress || n.contract?.address || "").toLowerCase(); // withMetadata=false answers contractAddress
    const v3 = nfts.filter((n) => of(n) === u.v3).map((n) => BigInt(n.tokenId));
    const v4 = nfts.filter((n) => of(n) === u.v4).map((n) => BigInt(n.tokenId));
    const rows = [];
    if (v3.length) {
      const res = await reads(ctx, chain, v3.flatMap((id) => [q(u.v3, uniAbi, "positions", [id]), q(u.v3, uniAbi, "collect", [{ tokenId: id, recipient: a, amount0Max: MAX128, amount1Max: MAX128 }], a)]));
      v3.forEach((id, i) => {
        const pos = res[2 * i], got = res[2 * i + 1];
        if (!pos || !got) return;
        rows.push({ version: "v3", id: String(id), legs: [[pos[2], got[0]], [pos[3], got[1]]], liquidity: pos[7] > 0n });
      });
    }
    if (v4.length) {
      const info = await reads(ctx, chain, v4.map((id) => q(u.v4, uniAbi, "getPoolAndPositionInfo", [id])));
      const pos = v4.map((id, i) => {
        if (!info[i]) return null;
        const [key, packed] = info[i];
        const poolId = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
        return { id, key, poolId, ...v4Ticks(packed) };
      }).filter(Boolean);
      const res = await reads(ctx, chain, pos.flatMap((x) => [
        q(u.sv, uniAbi, "getPositionInfo", [x.poolId, u.v4, x.tickLower, x.tickUpper, `0x${x.id.toString(16).padStart(64, "0")}`]),
        q(u.sv, uniAbi, "getFeeGrowthInside", [x.poolId, x.tickLower, x.tickUpper]),
      ]));
      pos.forEach((x, i) => {
        const pi = res[2 * i], fg = res[2 * i + 1];
        if (!pi || !fg || pi[0] === 0n) return;
        rows.push({ version: "v4", id: String(x.id), hooks: x.key.hooks.toLowerCase() !== ZERO ? x.key.hooks : null,
          legs: [[x.key.currency0, v4Owed(fg[0], pi[1], pi[0])], [x.key.currency1, v4Owed(fg[1], pi[2], pi[0])]], liquidity: true });
      });
    }
    if (!rows.length) return [];
    const meta = await tokenMeta(ctx, chain, rows.flatMap((x) => x.legs.map((l) => l[0])));
    return rows.map((x) => ({
      protocol: `Uniswap ${x.version.toUpperCase()}`, chain, version: x.version, position_id: x.id, hooks: x.hooks ?? null, closed: !x.liquidity,
      legs: x.legs.filter(([, raw]) => raw > 0n).map(([t, raw]) => {
        const token = String(t).toLowerCase(), m = meta.get(token);
        return { token, asset: token === ZERO ? "ETH" : m?.symbol ?? null, amount: m?.decimals == null ? null : units(raw, m.decimals), chain };
      }).filter((l) => l.amount != null),
    })).filter((x) => x.legs.length);
  });
  await price(ctx, items.flatMap((x) => x.legs));
  for (const x of items) for (const l of x.legs) delete l.chain;
  return { items, errors };
}

// ---- Superfluid distribution pools (GDA) ----------------------------------------------------------------------
// pool memberships from Superfluid's own subgraphs, then getClaimableNow(member) on each pool: a share the wallet
// never claimed or connected to. Pool tokens are Super Tokens (18 decimals); priced on their underlying token
// when they wrap one, else on themselves (ETHx-style native wrappers on the chain's coin).
const SUPERFLUID = { base: "base-mainnet", optimism: "optimism-mainnet", arbitrum: "arbitrum-one", ethereum: "eth-mainnet", polygon: "polygon-mainnet", bsc: "bsc-mainnet", celo: "celo-mainnet", gnosis: "xdai-mainnet", scroll: "scroll-mainnet" };
const NATIVE_SUPER = new Set(["ETHx", "MATICx", "POLx", "BNBx", "xDAIx", "CELOx", "AVAXx"]);
const sfAbi = parseAbi(["function getClaimableNow(address memberAddr) view returns (int256 claimableBalance, uint256 timestamp)"]);
async function superfluidPools(p, ctx) {
  bad(p);
  const a = p.address.toLowerCase();
  const { items, errors } = await perChain(Object.keys(SUPERFLUID), async (chain) => {
    const r = await ctx.call("rewards.superfluid_members", { network: SUPERFLUID[chain], account: a });
    if (!r.ok || r.data?.errors) throw { error: `subgraph ${r.status}` };
    const members = (r.data?.data?.poolMembers || []).filter((m) => m.pool?.id);
    if (!members.length) return [];
    const res = await reads(ctx, chain, members.map((m) => q(m.pool.id, sfAbi, "getClaimableNow", [a])));
    return members.map((m, i) => {
      const raw = res[i]?.[0] ?? 0n;
      if (raw <= 0n) return null;
      const t = m.pool.token || {}, under = String(t.underlyingAddress || ZERO).toLowerCase();
      return {
        protocol: "Superfluid", chain, pool: m.pool.id, token: t.id, asset: t.symbol, amount: units(raw, t.decimals ?? 18), connected: !!m.isConnected,
        price_key: under !== ZERO ? priceKey(chain, under) : NATIVE_SUPER.has(t.symbol) ? CHAINS[chain].native : priceKey(chain, t.id),
      };
    }).filter(Boolean);
  });
  await price(ctx, items);
  return { items, errors };
}

// ---- token locks and vesting: UNCX, Team Finance, Unvest --------------------------------------------------------
const UNCX = { base: "0xa82685520c463a752d5319e6616e4e5fd0215e33", ethereum: "0xDba68f07d1b7Ca219f78ae8582C213d975c25cAf" }; // UNCX TokenVesting
const TEAM_FINANCE = { ethereum: "0xe2fe530c047f2d85298b07d9333c05737f1435fb" }; // Team Finance LockToken
const UNVEST_FACTORY = "0x934f1d13adc07ea112dabef4fa21d7639895b3e4"; // VestingTokenFactory, same address on each chain
const UNVEST_CHAINS = ["base", "ethereum", "arbitrum", "polygon"];
const UNVEST_CREATED = "0x9020e4abe651b6323f3420a1335588cd97e6c1407ba23ab0b00ca8c5db73bb65"; // VestingTokenCreated(underlying indexed, vestingToken)
const lockAbi = parseAbi([
  "function getUserLockedTokensLength(address user) view returns (uint256)",
  "function getUserLockedTokenAtIndex(address user, uint256 index) view returns (address)",
  "function getUserLocksForTokenLength(address user, address token) view returns (uint256)",
  "function getUserLockIDForTokenAtIndex(address user, address token, uint256 index) view returns (uint256)",
  "function getWithdrawableTokens(uint256 lockID) view returns (uint256)",
  "function getDepositsByWithdrawalAddress(address withdrawalAddress) view returns (uint256[])",
  "function lockedToken(uint256 id) view returns (address tokenAddress, address withdrawalAddress, uint256 tokenAmount, uint256 unlockTime, bool withdrawn)",
  "function claimableBalanceOf(address account) view returns (uint256)",
]);
const range = (n, max = 30) => Array.from({ length: Math.min(max, Number(n || 0n)) }, (_, i) => BigInt(i));
async function uncxLocks(ctx, chain, a) {
  const c = UNCX[chain];
  const [n] = await reads(ctx, chain, [q(c, lockAbi, "getUserLockedTokensLength", [a])]);
  const tokens = (await reads(ctx, chain, range(n).map((i) => q(c, lockAbi, "getUserLockedTokenAtIndex", [a, i])))).filter(Boolean);
  const counts = await reads(ctx, chain, tokens.map((t) => q(c, lockAbi, "getUserLocksForTokenLength", [a, t])));
  const pairs = tokens.flatMap((t, i) => range(counts[i]).map((k) => [t, k]));
  const ids = await reads(ctx, chain, pairs.map(([t, k]) => q(c, lockAbi, "getUserLockIDForTokenAtIndex", [a, t, k])));
  const locks = pairs.map(([t], i) => [t, ids[i]]).filter(([, id]) => id != null);
  const free = await reads(ctx, chain, locks.map(([, id]) => q(c, lockAbi, "getWithdrawableTokens", [id])));
  return locks.map(([t, id], i) => ({ protocol: "UNCX", chain, contract: c, lock_id: String(id), token: t.toLowerCase(), raw: free[i] ?? 0n })).filter((x) => x.raw > 0n);
}
async function teamFinanceLocks(ctx, chain, a, now) {
  const c = TEAM_FINANCE[chain];
  const [ids] = await reads(ctx, chain, [q(c, lockAbi, "getDepositsByWithdrawalAddress", [a])]);
  const list = (ids || []).slice(-50);
  const res = await reads(ctx, chain, list.map((id) => q(c, lockAbi, "lockedToken", [id])));
  const out = [];
  let running = 0;
  list.forEach((id, i) => {
    const d = res[i];
    if (!d || d[4] || d[2] === 0n || d[1].toLowerCase() !== a.toLowerCase()) return;
    if (Number(d[3]) > now) { running++; return; }
    out.push({ protocol: "Team Finance", chain, contract: c, lock_id: String(id), token: d[0].toLowerCase(), raw: d[2], unlocked: new Date(Number(d[3]) * 1000).toISOString().slice(0, 10) });
  });
  return { out, running };
}
async function unvestTokens(ctx, chain, a) {
  const r = await ctx.call("evm.alchemy_rpc", { network: CHAINS[chain].alchemy }, { body: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ address: UNVEST_FACTORY, topics: [UNVEST_CREATED], fromBlock: "0x0", toBlock: "latest" }] } });
  if (!r.ok || !Array.isArray(r.data?.result)) throw { error: `Alchemy getLogs ${r.status}` };
  const vts = r.data.result.map((l) => ({ vt: `0x${l.data.slice(26, 66)}`, underlying: `0x${l.topics[1].slice(26)}` }));
  const res = await reads(ctx, chain, vts.map((v) => q(v.vt, lockAbi, "claimableBalanceOf", [a])));
  return vts.map((v, i) => ({ protocol: "Unvest", chain, contract: v.vt, token: v.vt.toLowerCase(), underlying: v.underlying.toLowerCase(), raw: res[i] ?? 0n })).filter((x) => x.raw > 0n);
}
async function tokenLocks(p, ctx) {
  bad(p);
  const a = p.address, now = Math.floor(Date.now() / 1000), errors = [], raw = [];
  let running = 0;
  const run = (what, f) => f().then((xs) => raw.push(...xs), (e) => errors.push(`${what}: ${errText(e)}`));
  await Promise.all([
    ...Object.keys(UNCX).map((c) => run(`uncx ${c}`, () => uncxLocks(ctx, c, a))),
    ...Object.keys(TEAM_FINANCE).map((c) => run(`team_finance ${c}`, async () => { const r = await teamFinanceLocks(ctx, c, a, now); running += r.running; return r.out; })),
    ...(ctx.live("evm.alchemy_rpc") ? UNVEST_CHAINS.map((c) => run(`unvest ${c}`, () => unvestTokens(ctx, c, a))) : []),
  ]);
  const byChain = new Map();
  for (const x of raw) byChain.set(x.chain, [...(byChain.get(x.chain) || []), x]);
  const items = [];
  await Promise.all([...byChain].map(async ([chain, xs]) => {
    const meta = await tokenMeta(ctx, chain, xs.map((x) => x.token));
    for (const x of xs) {
      const m = meta.get(x.token);
      if (m?.decimals == null) continue;
      const { raw: r, underlying, ...rest } = x;
      items.push({ ...rest, asset: m.symbol, amount: units(r, m.decimals), ...(underlying && { price_key: priceKey(chain, underlying) }) });
    }
  }));
  await price(ctx, items);
  return { items, running_locks: running, errors };
}

export const UNCLAIMED = { zkevmExits, hedgeyPlans, flaunchFees, uniswapFees, superfluidPools, tokenLocks };
