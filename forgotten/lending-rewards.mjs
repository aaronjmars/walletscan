// forgotten/lending-rewards.mjs - lending incentives a wallet earned and never claimed (read 2026-10-22).
// Aave V3: each market's RewardsController keeps what a supplier or borrower earned (WAVAX on Avalanche, ARB on
// Arbitrum, SD / MaticX / stMATIC on Polygon, aEthUSDS on Ethereum...) until the wallet calls claimAllRewards. Markets
// = Pool + RewardsController from bgd-labs/aave-address-book src/ts/AaveV3<Market>.ts
// (https://github.com/bgd-labs/aave-address-book/tree/main/src/ts). A controller with an empty getRewardsList costs one
// call; the others get the pool's reserves (getReservesList, getReserveData: aToken + variable debt token) and
// getAllUserRewards(assets, wallet), which adds what accrued since the wallet's last move. Aave V2 works the same way with
// one reward per IncentivesController (getRewardsBalance): stkAAVE on Ethereum (paid by staking AAVE the controller
// holds), WMATIC on Polygon, WAVAX on Avalanche; its programs ended in 2022-2023, so what is left there is forgotten
// for sure. A reward is paid from a rewards vault (allowance to the transfer strategy): we read what the vault can pay
// now, since an empty vault makes the claim revert. Merkl pays most of the new Aave incentives (rewards.merkl): not here.
// Compound III: CometRewards owes COMP per Comet market (getRewardOwed(comet, wallet), not a view but fine in
// eth_call: it accrues baseTrackingAccrued first). Markets = comet + rewards from compound-finance/comet
// deployments/<network>/<market>/roots.json (https://github.com/compound-finance/comet/tree/main/deployments). Every
// market's reward speed reads 0 on 2026-10-22 and most CometRewards hold close to no COMP (a mass claim emptied the
// Ethereum one on 2026-06-17): the claim pays the whole amount or reverts, so what the contract cannot cover is
// "unfunded" until governance tops it up (proposal 551 did it for Arbitrum, Base and Unichain in March 2026,
// https://tally.xyz/gov/compound/proposal/551). Ronin's two markets have no reward configured (left out).
// Not covered: Aave on zkSync, X Layer, MegaETH, Monad and Harmony (no keyless publicnode host).
import { multiOn, pricesOf, trustedPrice, needEvm, round, errText, tokenKey, units } from "./anyrpc.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const AAVE = "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9";
// chain, market, pool, RewardsController, app.aave.com marketName
export const AAVE_V3 = [
  ["ethereum", "Core", "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2", "0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb", "proto_mainnet_v3"],
  ["ethereum", "Prime", "0x4e033931ad43597d96D6bcc25c280717730B58B1", "0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb", "proto_lido_v3"],
  ["ethereum", "EtherFi", "0x0AA97c284e98396202b6A04024F5E2c65026F3c0", "0x8164Cc65827dcFe994AB23944CBC90e0aa80bFcb", "proto_etherfi_v3"],
  ["ethereum", "Horizon", "0xAe05Cd22df81871bc7cC2a04BeCfb516bFe332C8", "0x1D5D386a90CEA8AcEa9fa75389e97CF5F1AE21D3", "proto_horizon_v3"],
  ["arbitrum", "Arbitrum", "0x794a61358D6845594F94dc1DB02A252b5b4814aD", "0x929EC64c34a17401F460460D4B9390518E5B473e", "proto_arbitrum_v3"],
  ["avalanche", "Avalanche", "0x794a61358D6845594F94dc1DB02A252b5b4814aD", "0x929EC64c34a17401F460460D4B9390518E5B473e", "proto_avalanche_v3"],
  ["optimism", "Optimism", "0x794a61358D6845594F94dc1DB02A252b5b4814aD", "0x929EC64c34a17401F460460D4B9390518E5B473e", "proto_optimism_v3"],
  ["polygon", "Polygon", "0x794a61358D6845594F94dc1DB02A252b5b4814aD", "0x929EC64c34a17401F460460D4B9390518E5B473e", "proto_polygon_v3"],
  ["base", "Base", "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5", "0xf9cc4F0D883F1a1eb2c253bdb46c254Ca51E1F44", "proto_base_v3"],
  ["bsc", "BNB", "0x6807dc923806fE8Fd134338EABCA509979a7e0cB", "0xC206C2764A9dBF27d599613b8F9A63ACd1160ab4", "proto_bnb_v3"],
  ["gnosis", "Gnosis", "0xb50201558B00496A145fE76f7424749556E326D8", "0xaD4F91D26254B6B0C6346b390dDA2991FDE2F20d", "proto_gnosis_v3"],
  ["metis", "Metis", "0x90df02551bB792286e8D4f13E0e357b4Bf1D6a57", "0x30C1b8F0490fa0908863d6Cbd2E36400b4310A6B", "proto_metis_v3"],
  ["scroll", "Scroll", "0x11fCfe756c05AD438e312a7fd934381537D3cFfe", "0xa3f3100C4f1D0624DB9DB97b40C13885Ce297799", "proto_scroll_v3"],
  ["linea", "Linea", "0xc47b8C00b0f69a36fa203Ffeac0334874574a8Ac", "0xc67bb8F2314fA0df50cBa314c6509A7bdAD500C0", "proto_linea_v3"],
  ["sonic", "Sonic", "0x5362dBb1e601abF3a4c14c22ffEdA64042E5eAA3", "0x24bD6e9ca54F1737467DEf82dCA9702925B3Aa59", "proto_sonic_v3"],
  ["celo", "Celo", "0x3E59A31363E2ad014dcbc521c4a0d5757d9f3402", "0x4725A0FdbEB14A77964bC1C221eE3a7982263103", "proto_celo_v3"],
  ["mantle", "Mantle", "0x458F293454fE0d67EC0655f3672301301DD51422", "0x682482a584eE20fefc01f4575c45C5d84de6F619", "proto_mantle_v3"],
  ["soneium", "Soneium", "0xDd3d7A7d03D9fD9ef45f3E587287922eF65CA38B", "0xE9Dfe1cbD5F10C56c1466F6AC88e1Fb304Be3780", "proto_soneium_v3"],
  ["plasma", "Plasma", "0x925a2A7214Ed92428B5b1B090F80b25700095e12", "0x3A57eAa3Ca3794D66977326af7991eB3F6dD5a5A", "proto_plasma_v3"],
  ["ink", "Ink (Tydro)", "0x2816cf15F6d2A220E789aA011D5EE4eB6c47FEbA", "0xD93e3Ae8f69D04d484d1652Ca569d4b0522414DF", null],
].map(([chain, market, pool, rewards, app]) => ({ v: 3, chain, market, pool, rewards, app }));
// chain, LendingPool, IncentivesController, marketName; stake = the controller pays by staking AAVE it holds (stkAAVE)
export const AAVE_V2 = [
  ["ethereum", "0x7d2768dE32b0b80b7a3454c06BdAc94A69DDc7A9", "0xd784927Ff2f95ba542BfC824c8a8a98F3495f6b5", "proto_mainnet", true],
  ["polygon", "0x8dFf5E27EA6b7AC08EbFdf9eB090F32ee9a30fcf", "0x357D51124f59836DeD84c8a1730D72B749d8BC23", "proto_polygon", false],
  ["avalanche", "0x4F01AeD16D97E3aB5ab2B501154DC9bb0F1A5A2C", "0x01D83Fe6A10D2f2B7AF17034343746188272cAc9", "proto_avalanche", false],
].map(([chain, pool, rewards, app, stake]) => ({ v: 2, chain, market: "V2", pool, rewards, app, stake }));

const A = {
  pool: ["function getReservesList() view returns (address[])"],
  v3: ["function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 currentLiquidityRate, uint128 variableBorrowIndex, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, uint16 id, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint128 accruedToTreasury, uint128 unbacked, uint128 isolationModeTotalDebt))"],
  v2: ["function getReserveData(address asset) view returns ((uint256 configuration, uint128 liquidityIndex, uint128 variableBorrowIndex, uint128 currentLiquidityRate, uint128 currentVariableBorrowRate, uint128 currentStableBorrowRate, uint40 lastUpdateTimestamp, address aTokenAddress, address stableDebtTokenAddress, address variableDebtTokenAddress, address interestRateStrategyAddress, uint8 id))"],
  ctl: [
    "function getRewardsList() view returns (address[])", "function getTransferStrategy(address reward) view returns (address)",
    "function getAllUserRewards(address[] assets, address user) view returns (address[] rewardsList, uint256[] unclaimedAmounts)",
    "function getRewardsBalance(address[] assets, address user) view returns (uint256)", "function REWARD_TOKEN() view returns (address)",
  ],
  vault: ["function getRewardsVault() view returns (address)"],
  erc20: ["function decimals() view returns (uint8)", "function symbol() view returns (string)", "function balanceOf(address) view returns (uint256)", "function allowance(address owner, address spender) view returns (uint256)", "function UNDERLYING_ASSET_ADDRESS() view returns (address)"],
  comet: ["struct RewardOwed { address token; uint256 owed; }", "function getRewardOwed(address comet, address account) returns (RewardOwed)"],
};
const lc = (a) => String(a).toLowerCase();
const appLink = (m) => (m.app ? `https://app.aave.com/?marketName=${m.app}` : "https://app.tydro.com");
const minOf = (a, b) => (a == null ? b : b == null ? a : a < b ? a : b);

// what each (controller, reward) can pay right now: min(vault balance, allowance to the strategy), or the AAVE the V2
// Ethereum controller holds to stake; null when the strategy is not a pull-from-vault one (cannot tell)
async function payable(ctx, chain, owed) {
  const keys = [...new Map(owed.map((o) => [`${lc(o.m.rewards)}:${lc(o.reward)}`, o])).entries()].map(([k, o]) => ({ k, o }));
  // V3: controller -> transfer strategy -> its vault; V2: the controller pulls from its own vault
  const first = await multiOn(ctx, chain, keys.map(({ o }) => (o.m.v === 3 ? { to: o.m.rewards, abi: A.ctl, fn: "getTransferStrategy", args: [o.reward] } : { to: o.m.rewards, abi: A.vault, fn: "getRewardsVault" })));
  keys.forEach((x, i) => { if (x.o.m.v === 3) x.spender = first[i]; else { x.spender = x.o.m.rewards; x.vault = first[i]; } });
  const v3 = keys.filter((x) => x.o.m.v === 3 && x.spender);
  (await multiOn(ctx, chain, v3.map((x) => ({ to: x.spender, abi: A.vault, fn: "getRewardsVault" })))).forEach((v, i) => { v3[i].vault = v; });
  const reads = keys.map((x) => (x.o.m.stake ? [{ to: AAVE, abi: A.erc20, fn: "balanceOf", args: [x.o.m.rewards] }]
    : x.vault ? [{ to: x.o.reward, abi: A.erc20, fn: "balanceOf", args: [x.vault] }, { to: x.o.reward, abi: A.erc20, fn: "allowance", args: [x.vault, x.spender] }] : []));
  const res = await multiOn(ctx, chain, reads.flat());
  let at = 0;
  return new Map(keys.map((x, i) => {
    const r = res.slice(at, (at += reads[i].length));
    return [x.k, { vault: x.o.m.stake ? x.o.m.rewards : x.vault, can: !r.length || r.some((v) => v == null) ? null : r.reduce(minOf) }];
  }));
}

async function aaveOn(ctx, chain, user) {
  const markets = [...AAVE_V3, ...AAVE_V2].filter((m) => m.chain === chain), v3ctl = [...new Set(markets.filter((m) => m.v === 3).map((m) => m.rewards))];
  const r1 = await multiOn(ctx, chain, [...markets.map((m) => ({ to: m.pool, abi: A.pool, fn: "getReservesList" })), ...v3ctl.map((c) => ({ to: c, abi: A.ctl, fn: "getRewardsList" }))]);
  const lists = new Map(v3ctl.map((c, i) => [c, r1[markets.length + i] || []]));
  // a V3 market whose controller lists no reward has nothing to pay; V2 controllers keep paying past their end
  const live = markets.map((m, i) => ({ m, reserves: r1[i] || [] })).filter((x) => x.reserves.length && (x.m.v === 2 || lists.get(x.m.rewards).length));
  if (!live.length) return [];
  const flat = live.flatMap((x) => x.reserves.map((asset) => ({ x, asset })));
  const data = await multiOn(ctx, chain, flat.map((f) => ({ to: f.x.m.pool, abi: f.x.m.v === 3 ? A.v3 : A.v2, fn: "getReserveData", args: [f.asset] })));
  for (const x of live) x.assets = [];
  flat.forEach((f, i) => { const d = data[i]; if (d) f.x.assets.push(...[d.aTokenAddress, d.variableDebtTokenAddress].filter((t) => t && t !== ZERO)); });
  const ask = live.filter((x) => x.assets.length);
  const calls = ask.map((x) => (x.m.v === 3 ? [{ to: x.m.rewards, abi: A.ctl, fn: "getAllUserRewards", args: [x.assets, user] }]
    : [{ to: x.m.rewards, abi: A.ctl, fn: "getRewardsBalance", args: [x.assets, user] }, { to: x.m.rewards, abi: A.ctl, fn: "REWARD_TOKEN" }]));
  const r3 = await multiOn(ctx, chain, calls.flat()), owed = [];
  let at = 0;
  ask.forEach((x, i) => {
    const [r, token] = r3.slice(at, (at += calls[i].length));
    if (x.m.v === 3) (r?.[0] || []).forEach((reward, j) => r[1][j] > 0n && owed.push({ m: x.m, reward, raw: r[1][j] }));
    else if (r > 0n && token) owed.push({ m: x.m, reward: token, raw: r });
  });
  if (!owed.length) return [];
  const toks = [...new Set(owed.map((o) => lc(o.reward)))];
  const [meta, pay] = await Promise.all([
    multiOn(ctx, chain, toks.flatMap((t) => [{ to: t, abi: A.erc20, fn: "decimals" }, { to: t, abi: A.erc20, fn: "symbol" }, { to: t, abi: A.erc20, fn: "UNDERLYING_ASSET_ADDRESS" }])),
    payable(ctx, chain, owed),
  ]);
  const info = new Map(toks.map((t, i) => [t, { decimals: meta[3 * i], symbol: meta[3 * i + 1], under: meta[3 * i + 2] ? lc(meta[3 * i + 2]) : null }]));
  for (const o of owed) if (o.m.stake) info.get(lc(o.reward)).under = lc(AAVE);
  // a reward paid as an aToken (aEthUSDS) is worth its underlying when DefiLlama has no price for it (stkAAVE: AAVE)
  const px = await pricesOf(ctx, toks.flatMap((t) => [tokenKey(chain, t), info.get(t).under && tokenKey(chain, info.get(t).under)]));
  // what the wallet is owed per (controller, reward) over all markets, to hold against what the vault can pay
  const total = new Map();
  for (const o of owed) { const k = `${lc(o.m.rewards)}:${lc(o.reward)}`; total.set(k, (total.get(k) || 0n) + o.raw); }
  return owed.map((o) => {
    const t = lc(o.reward), m = info.get(t), dec = m.decimals ?? 18, amount = units(o.raw, dec), k = `${lc(o.m.rewards)}:${t}`, p = trustedPrice(px, tokenKey(chain, t)) ?? (m.under ? trustedPrice(px, tokenKey(chain, m.under)) : null);
    const { vault, can } = pay.get(k) || {}, status = can == null ? "unverified" : can >= total.get(k) ? "ready" : "unfunded", sym = m.symbol || "reward";
    const where = o.m.v === 3 && lc(o.m.market) !== chain ? `Aave V3 ${o.m.market} market on ${chain}` : `Aave V${o.m.v} on ${chain}`;
    // one reward at a time: claimAllRewards reverts for every reward when one vault is short
    const claim = o.m.v === 3 ? `claimRewardsToSelf(<the market's aToken and debt token list>, max, ${t}) on the RewardsController ${o.m.rewards}` :`claimRewards(<aToken and debt token list>, max, <your wallet>) on the IncentivesController ${o.m.rewards}`;
    return {
      category: "reward", chain, protocol: o.m.v === 3 ? "Aave V3" : "Aave V2", asset: sym, token: t, amount: round(amount, 6), usd: p == null ? null : round(amount * p),
      status, deadline: null, market: o.m.market, controller: o.m.rewards,
      action: status === "unfunded" ? `claim ${sym} in the Aave app (${where}: Dashboard, Claim) once Aave refills the rewards vault: the claim reverts until the Aave team acts` : `claim ${sym} in the Aave app (${where}: Dashboard, Claim), or call ${claim}`,
      how_to_claim: appLink(o.m),
      detail: [`${sym} incentives earned supplying or borrowing on ${where}, accrued in ${o.m.rewards} and never claimed`,
        o.m.stake && "paid as stkAAVE (staked AAVE: unstaking has a cooldown)",
        can == null ? "could not read what the rewards vault can pay (not a pull-from-vault strategy)" : status === "unfunded" ? `the rewards vault ${vault} can pay ${round(units(can, dec), 4)} ${sym} now, less than this: the claim reverts until Aave refills it` : `the rewards vault ${vault} can pay it now`,
      ].filter(Boolean).join("; "),
    };
  });
}

export async function aaveIncentives(p, ctx) {
  needEvm(p);
  const chains = [...new Set([...AAVE_V3, ...AAVE_V2].map((m) => m.chain))], errors = [], items = [];
  await Promise.all(chains.map((c) => aaveOn(ctx, c, p.address).then((xs) => items.push(...xs), (e) => errors.push(`${c}: ${errText(e)}`))));
  if (errors.length === chains.length) throw { status: 502, error: errors.join("; ") };
  return { items, errors };
}

// chain, market (base asset), Comet; CometRewards per chain
export const COMETS = [
  ["ethereum", "USDC", "0xc3d688B66703497DAA19211EEdff47f25384cdc3"], ["ethereum", "WETH", "0xA17581A9E3356d9A858b789D68B4d866e593aE94"],
  ["ethereum", "USDT", "0x3Afdc9BCA9213A35503b077a6072F3D0d5AB0840"], ["ethereum", "wstETH", "0x3D0bb1ccaB520A66e607822fC55BC921738fAFE3"],
  ["ethereum", "USDS", "0x5D409e56D886231aDAf00c8775665AD0f9897b56"], ["ethereum", "WBTC", "0xe85Dc543813B8c2CFEaAc371517b925a166a9293"],
  ["arbitrum", "USDC.e", "0xA5EDBDD9646f8dFF606d7448e414884C7d905dCA"], ["arbitrum", "USDC", "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf"],
  ["arbitrum", "USDT", "0xd98Be00b5D27fc98112BdE293e487f8D4cA57d07"], ["arbitrum", "WETH", "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486"],
  ["base", "AERO", "0x784efeB622244d2348d4F2522f8860B96fbEcE89"], ["base", "USDbC", "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf"],
  ["base", "USDC", "0xb125E6687d4313864e53df431d5425969c15Eb2F"], ["base", "USDS", "0x2c776041CCFe903071AF44aa147368a9c8EEA518"],
  ["base", "WETH", "0x46e6b214b524310239732D51387075E0e70970bf"],
  ["optimism", "USDC", "0x2e44e174f7D53F0212823acC11C01A11d58c5bCB"], ["optimism", "USDT", "0x995E394b8B2437aC8Ce61Ee0bC610D617962B214"],
  ["optimism", "WETH", "0xE36A30D249f7761327fd973001A32010b521b6Fd"],
  ["polygon", "USDC.e", "0xF25212E676D1F7F89Cd72fFEe66158f541246445"], ["polygon", "USDT", "0xaeB318360f27748Acb200CE616E389A6C9409a07"],
  ["scroll", "USDC", "0xB2f97c1Bd3bf02f5e74d13f02E3e26F93D77CE44"],
  ["linea", "USDC", "0x8D38A3d6B3c3B7d96D6536DA7Eef94A9d7dbC991"], ["linea", "WETH", "0x60F2058379716A64a7A5d29219397e79bC552194"],
  ["mantle", "USDe", "0x606174f62cd968d8e684c645080fa694c1D7786E"],
  ["unichain", "USDC", "0x2c7118c4C88B9841FCF839074c26Ae8f035f2921"], ["unichain", "WETH", "0x6C987dDE50dB1dcDd32Cd4175778C2a291978E2a"],
].map(([chain, market, comet]) => ({ chain, market, comet }));
export const COMET_REWARDS = {
  ethereum: "0x1B0e765F6224C21223AeA2af16c1C46E38885a40", arbitrum: "0x88730d254A2f7e6AC8388c3198aFd694bA9f7fae", base: "0x123964802e6ABabBE1Bc9547D72Ef1B69B00A6b1",
  optimism: "0x443EA0340cb75a160F31A440722dec7b5bc3C2E9", polygon: "0x45939657d1CA34A8FA39A924B71D28Fe8431e581", scroll: "0x70167D30964cbFDc315ECAe02441Af747bE0c5Ee",
  linea: "0x2c7118c4C88B9841FCF839074c26Ae8f035f2921", mantle: "0xCd83CbBFCE149d141A5171C3D6a0F0fCCeE225Ab", unichain: "0x6f7D514bbD4aFf3BcD1140B7344b32f063dEe486",
};
const COMP_GECKO = "coingecko:compound-governance-token";

async function cometOn(ctx, chain, user) {
  const markets = COMETS.filter((m) => m.chain === chain), rewards = COMET_REWARDS[chain];
  const r1 = await multiOn(ctx, chain, markets.map((m) => ({ to: rewards, abi: A.comet, fn: "getRewardOwed", args: [m.comet, user] })));
  const owed = markets.map((m, i) => ({ m, token: r1[i]?.token, raw: r1[i]?.owed })).filter((o) => o.raw > 0n && o.token && o.token !== ZERO);
  if (!owed.length) return [];
  const toks = [...new Set(owed.map((o) => lc(o.token)))];
  const [meta, px] = await Promise.all([
    multiOn(ctx, chain, toks.flatMap((t) => [{ to: t, abi: A.erc20, fn: "decimals" }, { to: t, abi: A.erc20, fn: "symbol" }, { to: t, abi: A.erc20, fn: "balanceOf", args: [rewards] }])),
    pricesOf(ctx, [...toks.map((t) => tokenKey(chain, t)), COMP_GECKO]),
  ]);
  const info = new Map(toks.map((t, i) => [t, { decimals: meta[3 * i] ?? 18, symbol: meta[3 * i + 1], held: meta[3 * i + 2] }]));
  const total = new Map();
  for (const o of owed) total.set(lc(o.token), (total.get(lc(o.token)) || 0n) + o.raw);
  return owed.map((o) => {
    const t = lc(o.token), m = info.get(t), sym = m.symbol || "COMP", amount = units(o.raw, m.decimals);
    // bridged COMP on an L2 often has no DefiLlama price of its own: it is worth COMP
    const p = trustedPrice(px, tokenKey(chain, t)) ?? (sym === "COMP" ? trustedPrice(px, COMP_GECKO) : null);
    const status = m.held == null ? "unverified" : m.held >= total.get(t) ? "ready" : "unfunded";
    return {
      category: "reward", chain, protocol: "Compound III", asset: sym, token: t, amount: round(amount, 6), usd: p == null ? null : round(amount * p),
      status, deadline: null, market: `${o.m.market} (${o.m.comet})`,
      action: status === "unfunded" ? `claim ${sym} in the Compound app (${o.m.market} market on ${chain}) once governance refills CometRewards: the claim reverts until the Compound team acts` : `claim ${sym} in the Compound app (${o.m.market} market on ${chain}), or call claim(${o.m.comet}, <your wallet>, true) on CometRewards ${rewards} (anyone may send it, the ${sym} goes to the wallet)`,
      how_to_claim: "https://app.compound.finance/",
      detail: [`${sym} earned on the Compound III ${o.m.market} market on ${chain} (getRewardOwed on CometRewards ${rewards}) and never claimed`,
        m.held == null ? "could not read what CometRewards holds" : status === "unfunded" ? `CometRewards holds ${round(units(m.held, m.decimals), 4)} ${sym} now, less than this: the claim reverts until governance tops it up` : "CometRewards holds enough to pay it now"].join("; "),
    };
  });
}

export async function compoundRewards(p, ctx) {
  needEvm(p);
  const chains = Object.keys(COMET_REWARDS), errors = [], items = [];
  await Promise.all(chains.map((c) => cometOn(ctx, c, p.address).then((xs) => items.push(...xs), (e) => errors.push(`${c}: ${errText(e)}`))));
  if (errors.length === chains.length) throw { status: 502, error: errors.join("; ") };
  return { items, errors };
}
