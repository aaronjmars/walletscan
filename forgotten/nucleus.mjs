// forgotten/nucleus.mjs - Nucleus vault shares never redeemed on Ethereum (rewards.nucleus_vaults, read 2026-10-21).
// Nucleus deprecated its vaults on 2025-12-19 and took the withdraw page down; the vaults stay permissionless: the
// teller's bulkWithdraw(asset, shares, minimumAssets, to) burns the shares and pays one asset the vault still holds,
// at the accountant's rate in that asset (docs.nucleusearn.io deprecation guide). Vaults and tellers are the docs'
// Deployed Assets page, cross-checked onchain (teller.vault(), teller.accountant()); earnETH is 0x9Ed15383
// (DefiLlama's nucleus adapter: the docs row 0x215DC1cC is rswBTC). A scan reads balanceOf on every vault (one
// Multicall3), then for the vaults held: the accountant's getRate (base asset per share), whether anyone may call
// bulkWithdraw (authority isCapabilityPublic) and the teller may still exit the vault (canCall: earnETH's teller lost
// that role, so its shares come back as a hint), and per asset the teller pays, the vault's balance and
// getRateInQuoteSafe. A vault only pays out what it holds, so the row counts the part the held assets cover: all of
// it = ready, part = partial, nothing = hint. Not read: nALPHA / nTBILL / nOPAL... on Plume and Ethereum are Nest
// vaults (Plume's live RWA vaults, redeemed in the Nest app every day), not deprecated Nucleus ones; the Sei, Boba,
// Swell, Form and Rari copies of these vaults hold a few ETH and bridge back to Ethereum first.
import { multiOn, pricesOf, trustedPrice, tokenKey, needEvm, units, round, writeLink } from "./anyrpc.mjs";

const WETH = ["WETH", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18], WBTC = ["WBTC", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8], USDC = ["USDC", "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", 6];
const A = {
  apxETH: ["apxETH", "0x9Ba021B0a9b958B5E75cE9f6dff97C7eE52cb3E6", 18], ezETH: ["ezETH", "0xbf5495Efe5DB9ce00f80364C8B423567e58d2110", 18], wstETH: ["wstETH", "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", 18],
  weETH: ["weETH", "0xCd5fE23C85820F7B72D0926FC9b05b43E359b7ee", 18], pufETH: ["pufETH", "0xD9A442856C234a39a81a089C06451EBAa4306a72", 18], pzETH: ["pzETH", "0x8c9532a60E0E7C6BbD2B2c1303F63aCE1c3E9811", 18],
  swETH: ["swETH", "0xf951E335afb289353dc249e82926178EaC7DEd78", 18], rswETH: ["rswETH", "0xFAe103DC9cf190eD75350761e95403b7b8aFa6c0", 18], pxETH: ["pxETH", "0x04C154b66CB340F3Ae24111CC767e0184Ed00Cc6", 18],
  SolvBTC: ["SolvBTC", "0x7A56E1C57C7475CCf742a1832B028F0456652F97", 18], swBTC: ["swBTC", "0x8DB2350D78aBc13f5673A411D4700BCF87864dDE", 8], LBTC: ["LBTC", "0x8236a87084f8B84306f72007F36F2618A5634494", 8],
};
// [symbol, share token, teller, accountant, teller authority, share decimals, base, assets the teller pays (isSupported
// and held by the vault on 2026-10-21)]. rariETH is left out: bulkWithdraw is not public on its teller (0.016 shares left)
const V = (symbol, vault, teller, accountant, authority, dec, base, pays) => ({ symbol, vault, teller, accountant, authority, dec, base, pays });
export const NUCLEUS_VAULTS = [
  V("tETH", "0x19e099B7aEd41FA52718D780dDA74678113C0b32", "0x6Ae187EacF40ebd1e571a655dB92A1f47452E0Bf", "0x8c1902A5996978F2628558DD93d309F7e3926dfD", "0xa9220c99Bf3620Ac7e6F0Ff1cbde410635Fb87Fa", 18, WETH, [WETH, A.weETH, A.apxETH, A.pufETH]),
  V("unifiETH", "0x196ead472583bc1e9af7a05f860d9857e1bd3dcc", "0x08eb2eccdf6ebd7aba601791f23ec5b5f68a1d53", "0xA9fB7e2922216deBE3Fd5E1bBE7591eE446Dc21c", "0x11EB44DdcC14b8EC4B4B9d6B3324C1Ee00179a7D", 18, WETH, [A.pufETH, WETH]),
  V("earnETH", "0x9Ed15383940CC380fAEF0a75edacE507cC775f22", "0x685aDb4797fb38D4Fc4a69750aa048B398160429", "0x411c78BC8c36c3c66784514f28c56209e1DF2755", "0x1F5dddF627C3796a589c6271b36A570f18d3a016", 18, WETH, [A.swETH, A.ezETH, A.apxETH, A.rswETH, A.wstETH, A.pxETH, WETH, A.weETH]),
  V("tUSD", "0x722a851B6798D65b80526562Fc3a36E19b1F883b", "0x9Ff67b826b34feE9bf4135962754a808C4a14Fbc", "0x66455247E6f56Cb60DfcAeA669037841a8414804", "0xEd707d34CBc875Ab4159fEAB8a71F8dF810992bC", 6, USDC, [USDC]),
  V("unifiUSD", "0x82c40e07277eBb92935f79cE92268F80dDc7caB4", "0x5d3Fb47FE7f3F4Ce8fe55518f7E4F7D6061B54DD", "0xe0bDb7b9225A2CeB42998dc2E51D4D3CDeb7e3Be", "0xB836A199b04Fc8fda3a39d7B4AddEEAfBf5D81d6", 6, USDC, [USDC]),
  V("unifiBTC", "0x170d847a8320f3b6a77ee15b0cae430e3ec933a0", "0x0743647a607822781f9d0a639454e76289182f0b", "0x2afb28b0561d99b5e00829EC2eF54946a00a35f7", "0x0cea26647031F180E66b58A9449e25CF9026d50B", 8, WBTC, [WBTC, A.LBTC]),
  V("earnBTC", "0x66E47E6957B85Cf62564610B76dD206BB04d831a", "0x1DA9ceFA0F46b2087b2cF7dbF9E62Dd94076Ece1", "0x6bBf58f1A95D22f497fD2e7f640fAE94481b1A08", "0x05FAE28773ab9dAfD5C8997AcEe5099fa0D1f219", 8, WBTC, [WBTC, A.SolvBTC, A.swBTC, A.LBTC]),
  V("FETH", "0x6C587402dC88Ef187670F744dFB9d6a09Ff7fd76", "0xd567b6D8e9C95d8a29e60018156becaBDC63E851", "0x8ca1d13De3039142186aA57656Adbe0fD2620D2B", "0x1f10E54Fe0223752B3DcFDfD5A3377A93dd724B3", 18, WETH, [A.pzETH, WETH, A.wstETH, A.ezETH]),
  V("ssETH", "0xA8A3A5013104e093245164eA56588DBE10a3Eb48", "0x97D0B97A9FA017f8aD2565a5c6AED5745f3918b9", "0x6035832F65b0cf20064681505b73A6dE307a04cB", "0x6cDD5833285bf954957a9483b869B36BD5A26277", 18, WETH, [WETH, A.apxETH, A.ezETH]),
  V("seiyanETH", "0x9fAaEA2CDd810b21594E54309DC847842Ae301Ce", "0xB52C7d88F0514796877B04cF945E56cC4C66CD05", "0x24152894Decc7384b05E8907D6aDAdD82c176499", "0xEfD9931eD35820C88196351E132421f5917736bE", 18, WETH, [A.apxETH, WETH]),
  V("bobaETH", "0x52e4d8989fa8b3e1c06696e7b16def5d7707a0d1", "0xCd721cd24811013c35fFd4BaeF63F07A600EA8bA", "0x78cba912751dB70CBd77C1111A4d1aDD077AD99A", "0xC94908650DCa066657a582D6B88E9Dc51fB0BFFB", 18, WETH, [WETH]),
];
export const BULK_WITHDRAW = "0x3e64ce99"; // bulkWithdraw(address,uint256,uint256,address)
export const VAULT_EXIT = "0x18457e61"; // exit(address,address,uint256,address,uint256), what bulkWithdraw calls on the vault
const ABI = ["function balanceOf(address) view returns (uint256)", "function getRate() view returns (uint256)", "function getRateInQuoteSafe(address quote) view returns (uint256)", "function isCapabilityPublic(address target, bytes4 functionSig) view returns (bool)",
  "function canCall(address user, address target, bytes4 functionSig) view returns (bool)"];

// how many of `shares` the vault's held payout assets cover (bulkWithdraw can be split over assets), and the first
// asset that pays all of them alone. pays: [{ symbol, token, dec, held, rate }] with rate = asset units per share
export function coverage(shares, one, pays) {
  let left = shares, whole = null;
  for (const p of pays) {
    if (p.rate == null || p.held == null || !(p.rate > 0n)) continue;
    const out = shares * p.rate / one, can = p.held * one / p.rate;
    if (!whole && out > 0n && p.held >= out) whole = { ...p, out };
    left -= can < left ? can : left;
  }
  return { covered: shares - left, whole };
}

export async function nucleusVaults(p, ctx) {
  needEvm(p);
  const bals = await multiOn(ctx, "ethereum", NUCLEUS_VAULTS.map((v) => ({ to: v.vault, abi: ABI, fn: "balanceOf", args: [p.address.toLowerCase()] }))); // lowercase: viem rejects a bad mixed-case checksum
  const held = NUCLEUS_VAULTS.map((v, i) => [v, bals[i]]).filter(([, b]) => b != null && b > 0n);
  if (!held.length) return { items: [], errors: [] };
  const calls = held.flatMap(([v]) => [{ to: v.accountant, abi: ABI, fn: "getRate" }, { to: v.authority, abi: ABI, fn: "isCapabilityPublic", args: [v.teller, BULK_WITHDRAW] },
    { to: v.authority, abi: ABI, fn: "canCall", args: [v.teller, v.vault, VAULT_EXIT] },
    ...v.pays.flatMap(([, token]) => [{ to: token, abi: ABI, fn: "balanceOf", args: [v.vault] }, { to: v.accountant, abi: ABI, fn: "getRateInQuoteSafe", args: [token] }])]);
  const [res, px] = await Promise.all([multiOn(ctx, "ethereum", calls), pricesOf(ctx, held.map(([v]) => tokenKey("ethereum", v.base[1])))]);
  const items = [], errors = [];
  let k = 0;
  for (const [v, shares] of held) {
    const rate = res[k++], isPublic = res[k++] === true, canExit = res[k++] === true, open = isPublic && canExit;
    const pays = v.pays.map(([symbol, token, dec]) => ({ symbol, token, dec, held: res[k++], rate: res[k++] }));
    if (rate == null) { errors.push(`${v.symbol}: accountant getRate unreadable`); continue; }
    const one = 10n ** BigInt(v.dec), [base, baseAddr, baseDec] = v.base;
    const owed = units(shares * rate / one, baseDec), price = trustedPrice(px, tokenKey("ethereum", baseAddr));
    const { covered, whole } = open ? coverage(shares, one, pays) : { covered: 0n, whole: null };
    const f = Number(covered) / Number(shares), payable = pays.filter((x) => x.held > 0n && x.rate != null).map((x) => x.symbol);
    const status = f >= 0.999 ? "ready" : f > 0 ? "partial" : "hint";
    items.push({
      category: "token_migration", chain: "ethereum", protocol: "Nucleus", asset: v.symbol, token: v.vault.toLowerCase(), amount: round(units(shares, v.dec), 8), usd: price == null || f === 0 ? null : round(owed * Math.min(f, 1) * price), status,
      action: whole ? `redeem: bulkWithdraw(${whole.token}, ${String(shares)}, 0, your address) on the teller ${v.teller} pays about ${round(units(whole.out, whole.dec), 6)} ${whole.symbol}`
        : f > 0 ? `redeem: bulkWithdraw(asset, shares, 0, your address) on the teller ${v.teller}, split over the assets the vault still holds (${payable.join(", ")})`
        : `nothing to redeem right now: ${open ? `the vault holds none of the assets its teller pays (${v.pays.map((x) => x[0]).join(", ")})` : !isPublic ? "bulkWithdraw is not open to holders on this teller" : "redemptions are shut on this vault (its teller can no longer call exit on it)"}`,
      how_to_claim: writeLink("ethereum", v.teller),
      detail: `Nucleus ${v.symbol} vault shares (Nucleus deprecated its vaults on 2025-12-19, no app), worth ${round(owed, 6)} ${base} at the accountant rate${f > 0 && f < 0.999 ? `; the assets the vault still holds cover only ${round(f * 100, 1)}% of it (first come, first served)` : ""} (docs.nucleusearn.io deprecation guide)`,
    });
  }
  return { items, errors };
}
