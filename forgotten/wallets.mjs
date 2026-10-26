// forgotten/wallets.mjs - smart wallets an address controls that portfolio APIs never list under the owner (the Token
// Saver set, read 2026-10-20): DeFi Saver DSProxies on Arbitrum / Optimism / Base (Ethereum ones are in
// rewards.legacy), Instadapp DSAs on the same L2s (Zerion already shows Ethereum DSAs under the owner), and Safes
// where the address is the ONLY owner (spam Safes add famous addresses as one owner of many), and ERC-4337 accounts it
// owns on 6 chains (erc4337.mjs: Coinbase Smart Wallet, LightAccount, Modular Account, Kernel, Biconomy, thirdweb,
// SimpleAccount, Safe 4337; a 4337 Safe the Safe list also names is kept once). Each
// wallet's tokens come from Alchemy's Portfolio API; Aave debt tokens become negative rows priced at their underlying.
// A 4337 account whose owner read is unclear is a hint: its tokens come back with hint: true, never as holdings.
import { isEvmAddr } from "../solana.mjs";
import { SPAMMY } from "../chains/alchemy.mjs";
import { multi, prices, priceOf, units, ZERO, LLAMA } from "./evm.mjs";
import { ownedAccounts } from "./erc4337.mjs";

export const DSPROXY_REGISTRY = { arbitrum: "0xeCF15D0aE171F757175c6aBDD2C70e9a8806984C", optimism: "0x7cB647205ec73A026fe3566777e5c73Cd5A11b38", base: "0x2D8BFD9FF88E3106ce7214621b0770c1578749A1" };
export const DSA_RESOLVER = { arbitrum: "0xdF19Da523DA64bBE82eE0E4DFf00d676A8386474", optimism: "0x313FE505ad3ead0D35dD5d6687FB9C6B2469Db3d", base: "0x254A12C367160560BCc2B07c0b0a9cc40EF01f25" };
export const SAFE_NETWORKS = { ethereum: 1, optimism: 10, base: 8453, arbitrum: 42161 };
const ALCHEMY_NET = { ethereum: "eth-mainnet", arbitrum: "arb-mainnet", optimism: "opt-mainnet", base: "base-mainnet", polygon: "polygon-mainnet", bsc: "bnb-mainnet" };
const NATIVE = { polygon: "POL", bsc: "BNB" };
const APP = { DSProxy: "https://tokensaver.fyi", "Instadapp DSA": "https://defi.instadapp.io", Safe: "https://app.safe.global" };

async function discover(ctx, a) {
  const found = [], errors = [];
  const fail = (what) => (e) => errors.push(`${what}: ${String(e?.error || e?.message || e).slice(0, 120)}`);
  let aa = { accounts: [], hints: [] };
  await Promise.all([
    ownedAccounts(ctx, a).then((r) => { aa = r; errors.push(...r.errors); }, fail("4337")),
    ...Object.entries(DSPROXY_REGISTRY).map(([chain, reg]) => multi(ctx, chain, [
      { to: reg, abi: ["function getAllProxies(address user) view returns (address, address[])"], fn: "getAllProxies", args: [a] },
      { to: DSA_RESOLVER[chain], abi: ["function getAuthorityAccounts(address authority) view returns (address[])"], fn: "getAuthorityAccounts", args: [a] },
    ]).then(([px, dsa]) => {
      for (const w of px ? [px[0], ...px[1]] : []) if (w && w !== ZERO) found.push({ chain, wallet: w, kind: "DSProxy" });
      for (const w of dsa || []) found.push({ chain, wallet: w, kind: "Instadapp DSA" });
    }).catch(fail(`discover ${chain}`))),
    ...Object.entries(SAFE_NETWORKS).map(([chain, id]) => ctx.call("holdings.safe_wallets", { address: a, network: String(id) }).then((r) => {
      if (!r.ok) throw { error: `upstream ${r.status}` };
      for (const w of Array.isArray(r.data) ? r.data : []) found.push({ chain, wallet: w, kind: "Safe" });
    }).catch(fail(`safes ${chain}`))),
  ]);
  // keep a wallet only when the address controls it alone: DSProxy owner(), Safe getOwners() == [address]; a DSA
  // lists its authorities and the resolver already answered by authority
  // answers arrive in any order: sort so the follow-up calls are the same for the same wallet
  found.sort((x, y) => `${x.chain}${x.kind}${x.wallet.toLowerCase()}`.localeCompare(`${y.chain}${y.kind}${y.wallet.toLowerCase()}`));
  const byChain = new Map();
  for (const w of found) byChain.set(w.chain, [...(byChain.get(w.chain) || []), w]);
  const kept = [];
  await Promise.all([...byChain].map(async ([chain, list]) => {
    const calls = list.map((w) => (w.kind === "Safe" ? { to: w.wallet, abi: ["function getOwners() view returns (address[])"], fn: "getOwners" }
      : w.kind === "DSProxy" ? { to: w.wallet, abi: ["function owner() view returns (address)"], fn: "owner" } : null));
    const asked = calls.filter(Boolean);
    const answers = asked.length ? await multi(ctx, chain, asked).catch((e) => { fail(`owners ${chain}`)(e); return []; }) : [];
    let j = 0;
    list.forEach((w, i) => {
      const c = calls[i] ? answers[j++] : null;
      const me = (x) => x.toLowerCase() === a.toLowerCase();
      const sole = w.kind === "Safe" ? Array.isArray(c) && c.length === 1 && me(c[0]) : w.kind === "DSProxy" ? typeof c === "string" && me(c) : true;
      if (sole && !kept.some((k) => k.chain === chain && k.wallet.toLowerCase() === w.wallet.toLowerCase())) kept.push(w);
    });
  }));
  // 4337 accounts: ownership already read onchain (or bound by the factory when not deployed yet)
  for (const w of [...aa.accounts, ...aa.hints.map((h) => ({ ...h, hint: true }))]) {
    if (!kept.some((k) => k.chain === w.chain && k.wallet.toLowerCase() === w.wallet.toLowerCase())) kept.push(w);
  }
  kept.sort((x, y) => `${x.chain}${x.kind}${x.wallet.toLowerCase()}`.localeCompare(`${y.chain}${y.kind}${y.wallet.toLowerCase()}`));
  return { wallets: kept, errors };
}

// Aave v3 pools: every reserve's aToken (supplied) and variable debt token (borrowed), read for each wallet
export const AAVE_POOL = { ethereum: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", arbitrum: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", optimism: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", base: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", polygon: "0x794a61358D6845594F94dc1DB02A252b5b4814aD", bsc: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB" };
const RESERVE = ["function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))"];
const ERC20 = ["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"];
async function aaveRows(ctx, chain, wallets) {
  const pool = AAVE_POOL[chain];
  if (!pool || !wallets.length) return [];
  const [list] = await multi(ctx, chain, [{ to: pool, abi: ["function getReservesList() view returns (address[])"], fn: "getReservesList" }]);
  if (!list?.length) return [];
  const data = await multi(ctx, chain, list.map((asset) => ({ to: pool, abi: RESERVE, fn: "getReserveData", args: [asset] })));
  const toks = data.flatMap((d, i) => (d ? [{ token: d.aTokenAddress, underlying: list[i], debt: false }, { token: d.variableDebtTokenAddress, underlying: list[i], debt: true }] : []));
  const res = await multi(ctx, chain, [...toks.flatMap((t) => [{ to: t.token, abi: ERC20, fn: "decimals" }, { to: t.token, abi: ERC20, fn: "symbol" }]),
    ...wallets.flatMap((w) => toks.map((t) => ({ to: t.token, abi: ERC20, fn: "balanceOf", args: [w.wallet] })))]);
  const out = [];
  wallets.forEach((w, wi) => toks.forEach((t, ti) => {
    const bal = res[toks.length * 2 + wi * toks.length + ti], dec = res[ti * 2];
    if (!(bal > 0n) || dec == null) return;
    out.push({ ...w, token: t.token.toLowerCase(), underlying: t.underlying.toLowerCase(), asset: res[ti * 2 + 1] || "?", amount: units(bal, dec), price: null, debt: t.debt, aave: true });
  }));
  return out;
}

export async function smartWallets(p, ctx) {
  if (p.address == null || p.address === "") throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
  const { wallets, errors } = await discover(ctx, p.address);
  const rows = [];
  await Promise.all([
    ...wallets.map(async (w) => {
      const r = await ctx.call("holdings.alchemy_tokens", { address: w.wallet, networks: ALCHEMY_NET[w.chain] }).catch((e) => ({ ok: false, status: 0, data: e }));
      if (!r.ok) { errors.push(`tokens ${w.chain} ${w.wallet}: upstream ${r.status}`); return; }
      for (const t of r.data?.data?.tokens || []) {
        const m = t.tokenMetadata || {}, native = !t.tokenAddress;
        const dec = native ? 18 : m.decimals;
        if (dec == null || !/^0x0*[1-9a-f]/i.test(t.tokenBalance || "0x0")) continue;
        const pr = (t.tokenPrices || []).find((x) => x.currency === "usd");
        const sym = native ? NATIVE[w.chain] || "ETH" : m.symbol || "?";
        if (!pr && SPAMMY.test(`${m.symbol || ""} ${m.name || ""}`)) continue;
        rows.push({ ...w, token: native ? "native" : t.tokenAddress.toLowerCase(), asset: sym, amount: units(BigInt(t.tokenBalance), dec), price: pr ? Number(pr.value) : null, debt: /^(variable|stable)Debt/i.test(sym) });
      }
    }),
    // Alchemy's token index misses some aTokens (aOptWETH of a DSA, 2026-10-20): Aave v3 is read on the pool itself
    ...[...new Set(wallets.map((w) => w.chain))].map((chain) => aaveRows(ctx, chain, wallets.filter((w) => w.chain === chain)).then((list) => rows.push(...list), (e) => errors.push(`aave ${chain}: ${String(e?.error || e?.message || e).slice(0, 100)}`))),
  ]);
  rows.sort((x, y) => `${x.chain}${x.wallet.toLowerCase()}${x.token}${x.aave ? 1 : 0}`.localeCompare(`${y.chain}${y.wallet.toLowerCase()}${y.token}${y.aave ? 1 : 0}`));
  // one row per wallet + token: the Aave read wins over Alchemy's
  const fromAave = new Set(rows.filter((x) => x.aave).map((x) => `${x.chain}:${x.wallet.toLowerCase()}:${x.token}`));
  const kept = rows.filter((x) => x.aave || !fromAave.has(`${x.chain}:${x.wallet.toLowerCase()}:${x.token}`));
  // Aave rows (and Alchemy debt rows) carry no price: price them at their underlying
  const unpriced = kept.filter((x) => x.price == null && (x.aave || x.debt));
  if (unpriced.length) {
    const needUnd = unpriced.filter((x) => !x.underlying);
    const byChain = new Map();
    for (const d of needUnd) byChain.set(d.chain, [...(byChain.get(d.chain) || []), d]);
    await Promise.all([...byChain].map(async ([chain, list]) => {
      const und = await multi(ctx, chain, list.map((d) => ({ to: d.token, abi: ["function UNDERLYING_ASSET_ADDRESS() view returns (address)"], fn: "UNDERLYING_ASSET_ADDRESS" }))).catch(() => []);
      list.forEach((d, i) => { d.underlying = und[i] ? und[i].toLowerCase() : null; });
    }));
    const px = await prices(ctx, unpriced.filter((d) => d.underlying).map((d) => `${LLAMA[d.chain]}:${d.underlying}`));
    for (const d of unpriced) d.price = d.underlying ? priceOf(px, `${LLAMA[d.chain]}:${d.underlying}`) : null;
  }
  const name = (x) => (x.version ? `${x.kind} ${x.version}` : x.kind);
  const items = kept.map((x) => ({
    kind: x.debt ? "loan" : "token", chain: x.chain, protocol: x.kind, wallet: x.wallet, asset: x.asset, token: x.token, amount: x.amount,
    usd: x.price == null ? null : (x.debt ? -1 : 1) * x.amount * x.price, verified: x.price != null, how_to_claim: APP[x.kind] || x.app || null,
    ...(x.hint && { hint: true, why: x.why }),
    detail: x.hint ? `held by ${name(x)} smart account ${x.wallet} on ${x.chain}, made for you by its factory, but ${x.why}: check who controls it before counting it`
      : `${x.debt ? "debt of" : "held by"} your ${name(x)}${x.version ? " smart account" : ""} ${x.wallet} on ${x.chain}${x.deployed === false ? " (not deployed there yet: the factory makes it for you as owner, and its first transaction from the app deploys it)" : ""}`,
  }));
  return { wallets: wallets.map((w) => ({ chain: w.chain, wallet: w.wallet, kind: w.kind, ...(w.version && { version: w.version, deployed: w.deployed }), ...(w.hint && { hint: true, why: w.why }) })), items, errors };
}
