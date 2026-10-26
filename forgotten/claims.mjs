// forgotten/claims.mjs - balances apps keep for a wallet that it can withdraw itself (hiddenfunds.xyz gaps, read
// 2026-10-20):
//   rewards.blur_pool        ETH in Blur Pool on Ethereum (1 pool token = 1 ETH, withdraw(amount) on the pool)
//   rewards.creator_rewards  Zora ProtocolRewards and 0xSplits SplitMain balances on the chains rewards.legacy skips
//   rewards.plasma_vault     Plasma USD Vault shares (XPL pre-deposit) on Plasma and Ethereum, at the accountant rate
// Each function answers { items[] {category, chain, protocol, asset, token, amount, usd, status, action, how_to_claim,
// detail}, errors[] } for findings.mjs (hfClaims).
import { readOn, multiOn, pricesOf, trustedPrice, tokenKey, needEvm, units, round, parts, writeLink } from "./anyrpc.mjs";

const BAL = ["function balanceOf(address) view returns (uint256)"];

// ---- Blur Pool (Ethereum): the ETH bidding pool. balanceOf is ETH the wallet can withdraw now: open bids do not
// lock it (a filled bid takes it), and Blend loans move it out of the pool, so what the pool reports is free
export const BLUR_POOL = "0x0000000000A39bb272e79075ade125fd351887Ac";
export async function blurPool(p, ctx) {
  needEvm(p);
  const [raw, px] = await Promise.all([readOn(ctx, "ethereum", BLUR_POOL, BAL, "balanceOf", [p.address]), pricesOf(ctx, ["coingecko:ethereum"])]);
  if (!(raw > 0n)) return { items: [], errors: [] };
  const amount = units(raw, 18), eth = trustedPrice(px, "coingecko:ethereum");
  return {
    items: [{
      category: "unstake_ready", chain: "ethereum", protocol: "Blur Pool", asset: "ETH", token: BLUR_POOL.toLowerCase(), amount: round(amount, 8), usd: eth == null ? null : round(amount * eth), status: "ready",
      action: `withdraw the ETH from Blur Pool: withdraw(${String(raw)}) (amount in wei) on the pool contract, Write as Proxy`, how_to_claim: `https://etherscan.io/address/${BLUR_POOL}#writeProxyContract`,
      detail: "ETH deposited for Blur bids, still in the pool; 1 pool token = 1 ETH, withdraw any time (docs.blur.foundation)",
    }],
    errors: [],
  };
}

// ---- Zora ProtocolRewards and 0xSplits SplitMain v1 beyond what rewards.legacy reads (it reads Zora on Base and
// SplitMain ETH on Ethereum + Base). ProtocolRewards (same address on Zora, Ethereum, Optimism, Arbitrum, Blast):
// balanceOf = ETH creator / referral rewards to withdraw(to, amount). SplitMain v1 (same address on 8 chains):
// getETHBalance + getERC20Balance(account, token) = earnings distributed to the wallet and never withdrawn
// (withdraw(account, withdrawETH, tokens[])). SplitMain keeps 1 wei / 1 unit behind on purpose (gas saving), so
// balances of 1 are no money. 0xSplits v2 keeps balances in the SplitsWarehouse instead (read on 7 chains).
export const ZORA_REWARDS = "0x7777777F279eba3d3Ad8F4E708545291A6fDBA8B";
export const SPLIT_MAIN = "0x2ed6c4B5dA6378c7897AC67Ba9e43102Feb694EE";
const NATIVE = { polygon: ["POL", "coingecko:polygon-ecosystem-token"], gnosis: ["xDAI", "coingecko:xdai"] };
const nativeOf = (chain) => NATIVE[chain] || ["ETH", "coingecko:ethereum"];
const ZORA_CHAINS = ["zora", "ethereum", "optimism", "arbitrum", "blast"];
const SPLITS_ETH_CHAINS = ["optimism", "arbitrum", "polygon", "gnosis", "zora", "blast"];
// the tokens splits are most often paid in, per chain: [symbol, address, decimals]
export const SPLITS_TOKENS = {
  ethereum: [["USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6], ["WETH", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18], ["DAI", "0x6B175474E89094C44Da98b954EedeAC495271d0F", 18], ["USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6]],
  base: [["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6], ["WETH", "0x4200000000000000000000000000000000000006", 18]],
  optimism: [["USDC", "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", 6], ["USDC.e", "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", 6], ["WETH", "0x4200000000000000000000000000000000000006", 18], ["OP", "0x4200000000000000000000000000000000000042", 18]],
  arbitrum: [["USDC", "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", 6], ["USDC.e", "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", 6], ["WETH", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", 18], ["ARB", "0x912CE59144191C1204E64559FE8253a0e49E6548", 18]],
  polygon: [["USDC", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", 6], ["USDC.e", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", 6], ["WETH", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", 18]],
  gnosis: [["WXDAI", "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", 18], ["USDC", "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83", 6]],
  zora: [["WETH", "0x4200000000000000000000000000000000000006", 18]],
  blast: [["WETH", "0x4300000000000000000000000000000000000004", 18], ["USDB", "0x4300000000000000000000000000000000000003", 18]],
};
const SPLITS = ["function getETHBalance(address account) view returns (uint256)", "function getERC20Balance(address account, address token) view returns (uint256)"];
const MIN_ETH = 100000000000000n; // 0.0001 ETH, as rewards.legacy
// 0xSplits v2: one SplitsWarehouse (ERC-6909) on every chain (0xSplits/splits-contracts-monorepo splits-v2 deployments);
// balanceOf(owner, uint256(uint160(token))), native coin id = the 0xEeee... address; withdraw(owner, token) leaves 1 unit
export const SPLITS_WAREHOUSE = "0x8fb66F38cF86A3d5e8768f8F1754A24A6c661Fb8";
const NATIVE_ID = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const WAREHOUSE_CHAINS = ["ethereum", "optimism", "arbitrum", "base", "polygon", "gnosis", "zora"];
const WAREHOUSE = ["function balanceOf(address owner, uint256 id) view returns (uint256)"];

async function creatorChain(a, chain, ctx) {
  const calls = [];
  if (ZORA_CHAINS.includes(chain)) calls.push({ kind: "zora", to: ZORA_REWARDS, abi: BAL, fn: "balanceOf", args: [a] });
  if (SPLITS_ETH_CHAINS.includes(chain)) calls.push({ kind: "splits_eth", to: SPLIT_MAIN, abi: SPLITS, fn: "getETHBalance", args: [a] });
  for (const [sym, token, dec] of SPLITS_TOKENS[chain] || []) calls.push({ kind: "splits_erc20", sym, token, dec, to: SPLIT_MAIN, abi: SPLITS, fn: "getERC20Balance", args: [a, token] });
  if (WAREHOUSE_CHAINS.includes(chain)) {
    calls.push({ kind: "warehouse_eth", to: SPLITS_WAREHOUSE, abi: WAREHOUSE, fn: "balanceOf", args: [a, BigInt(NATIVE_ID)] });
    for (const [sym, token, dec] of SPLITS_TOKENS[chain] || []) calls.push({ kind: "warehouse_erc20", sym, token, dec, to: SPLITS_WAREHOUSE, abi: WAREHOUSE, fn: "balanceOf", args: [a, BigInt(token)] });
  }
  const res = await multiOn(ctx, chain, calls);
  const [nsym, nkey] = nativeOf(chain), rows = [];
  calls.forEach((c, i) => {
    const raw = res[i];
    const erc20 = c.kind.endsWith("erc20"), zora = c.kind === "zora", v2 = c.kind.startsWith("warehouse");
    if (raw == null || (erc20 ? raw <= 1n : raw < MIN_ETH)) return;
    rows.push({
      category: "reward", chain, protocol: zora ? "Zora" : v2 ? "0xSplits v2" : "0xSplits", asset: erc20 ? c.sym : zora ? "ETH" : nsym, ...(erc20 && { token: c.token.toLowerCase() }),
      amount: round(units(erc20 ? raw - 1n : raw, erc20 ? c.dec : 18), 8), price_key: erc20 ? tokenKey(chain, c.token) : zora ? "coingecko:ethereum" : nkey, status: "ready",
      action: zora ? "withdraw Zora creator rewards (ProtocolRewards.withdraw(to, amount))" : v2 ? `withdraw from the 0xSplits v2 warehouse: withdraw(your address, ${erc20 ? c.token : NATIVE_ID}) on ${SPLITS_WAREHOUSE}` : `withdraw from 0xSplits: SplitMain.withdraw(account, ${erc20 ? `0, [${c.token}]` : "1, []"})`,
      how_to_claim: zora ? writeLink(chain, ZORA_REWARDS) : "https://app.splits.org",
      detail: zora ? `unwithdrawn creator and referral rewards in Zora ProtocolRewards on ${chain}` : `unwithdrawn ${erc20 ? c.sym : nsym} earnings in 0xSplits ${v2 ? "v2 SplitsWarehouse" : "SplitMain"} on ${chain}`,
    });
  });
  return rows;
}

export async function creatorRewards(p, ctx) {
  needEvm(p);
  const chains = [...new Set([...ZORA_CHAINS, ...SPLITS_ETH_CHAINS, ...Object.keys(SPLITS_TOKENS)])];
  const out = await parts(Object.fromEntries(chains.map((c) => [c, () => creatorChain(p.address, c, ctx)])));
  if (out.items.length) {
    const px = await pricesOf(ctx, out.items.map((r) => r.price_key));
    for (const r of out.items) { const pr = trustedPrice(px, r.price_key); r.usd = pr == null ? null : round(r.amount * pr); delete r.price_key; }
  }
  return { items: out.items.sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0)), errors: out.errors };
}

// ---- Plasma USD Vault (the XPL pre-deposit vault, Veda BoringVault). Same share token, accountant and queue address
// on Plasma and Ethereum (read 2026-10-21): shares have 6 decimals and the accountant's getRate() is base units (6
// decimals) per share, base = USDT0 on Plasma, USDT on Ethereum. Redeem on Plasma through the BoringOnChainQueue:
// requestOnChainWithdraw(USDT0, shares, discountBps 0-10, secondsToDeadline), a solver pays within about an hour;
// the queue's withdrawAssets(USDT0) says whether withdrawals are open. On Ethereum the queue is not public: holders
// bridge the shares to Plasma first with teller.bridge (LayerZero), then queue there (so: medium)
export const PLASMA_VAULT = { share: "0xd1074E0AE85610dDBA0147e29eBe0D8E5873a000", accountant: "0x737f2522d09E58a3Ea9dcCFDB127dD0dF5eB3F18", teller: "0x4E7d2186eB8B75fBDcA867761636637E05BaeF1E", queue: "0xffdcc73ac9f8f46a8fcb0b648afdf1cb03345e50" };
const PLASMA_BASE = { plasma: ["USDT0", "0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb"], ethereum: ["USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7"] };
const VAULT = ["function balanceOf(address) view returns (uint256)", "function getRate() view returns (uint256)",
  "function withdrawAssets(address) view returns (bool allowWithdraws, uint24 secondsToMaturity, uint24 minimumSecondsToDeadline, uint16 minDiscount, uint16 maxDiscount, uint96 minimumShares)"];

async function plasmaChain(a, chain, ctx) {
  const [base, baseAddr] = PLASMA_BASE[chain];
  const [shares, rate, wa] = await multiOn(ctx, chain, [
    { to: PLASMA_VAULT.share, abi: VAULT, fn: "balanceOf", args: [a] }, { to: PLASMA_VAULT.accountant, abi: VAULT, fn: "getRate" },
    ...(chain === "plasma" ? [{ to: PLASMA_VAULT.queue, abi: VAULT, fn: "withdrawAssets", args: [PLASMA_BASE.plasma[1]] }] : []),
  ]);
  if (!(shares > 0n)) return [];
  if (rate == null) throw { error: "accountant getRate unreadable" };
  const owed = units(shares * rate / 1000000n, 6), open = chain === "plasma" ? !!wa?.[0] : false;
  return [{
    category: "token_migration", chain, protocol: "Plasma USD Vault", asset: "PlasmaUSD", token: PLASMA_VAULT.share.toLowerCase(), amount: round(units(shares, 6), 6), owed, price_key: tokenKey(chain, baseAddr),
    status: chain === "plasma" ? (open ? "ready" : "queued") : "bridge_first",
    action: chain === "plasma"
      ? `redeem for ${base}: approve the queue ${PLASMA_VAULT.queue} for your PlasmaUSD, then requestOnChainWithdraw(${PLASMA_BASE.plasma[1]}, shares, 0-10 bps discount, deadline >= 10 days); a solver pays in about an hour`
      : `bridge the PlasmaUSD shares to Plasma with teller.bridge on ${PLASMA_VAULT.teller} (LayerZero), then redeem them for USDT0 through the queue there (the Ethereum queue is not public)`,
    how_to_claim: writeLink(chain, chain === "plasma" ? PLASMA_VAULT.queue : PLASMA_VAULT.teller),
    detail: `Plasma USD Vault shares from the XPL pre-deposit or later deposits, worth ${round(owed, 2)} ${base} at the accountant rate ${Number(rate) / 1e6}${chain === "plasma" ? `; queue withdrawals ${open ? "open" : "closed right now"}` : ""}`,
  }];
}

export async function plasmaVault(p, ctx) {
  needEvm(p);
  const out = await parts({ plasma: () => plasmaChain(p.address, "plasma", ctx), ethereum: () => plasmaChain(p.address, "ethereum", ctx) });
  if (out.items.length) {
    const px = await pricesOf(ctx, out.items.map((r) => r.price_key));
    for (const r of out.items) { const pr = trustedPrice(px, r.price_key); r.usd = pr == null ? null : round(r.owed * pr); delete r.price_key; delete r.owed; }
  }
  return out;
}
