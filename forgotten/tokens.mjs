// forgotten/tokens.mjs - two Ethereum reads (contracts checked live 2026-10-20):
// oldTokens: tokens whose project moved on, each still redeemable through its official swap path (SAI cash-out,
//   NU and KEEP to T, REPv1 to REPv2, FTM ERC-20 to S, OHM v1 to gOHM); valued at what the swap pays
// expiredLocks: vote locks past their end date (veCRV, veFXS, veBAL) and vlCVX locks past their epoch: withdraw() frees them
import { isEvmAddr } from "../solana.mjs";
import { multi, prices, priceOf, units, writeLink } from "./evm.mjs";

const check = (p) => {
  if (p.address == null || p.address === "") throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
};
const BAL = ["function balanceOf(address) view returns (uint256)"];

export const OLD = {
  sai: "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359", saiTap: "0xBda109309f9FafA6Dd6A9CB9f1Df4085B27Ee8eF", // Tap.cash(wad) pays WETH at fix() (ray)
  nu: "0x4fE83213D56308330EC302a8BD641f1d0113A4Cc", nuVm: "0x1CCA7E410eE41739792eA0A24e00349Dd247680e", // VendingMachine.wrap(amount) -> T
  keep: "0x85Eee30c52B0b379b046Fb0F85F4f3Dc3009aFEC", keepVm: "0xE47c80e8c23f6B4A1aE41c34837a0599D5D16bb0",
  repV1: "0x1985365e9f78359a9B6AD760e32412f4a445E862", repV2: "0x221657776846890989a759BA2973e427DfF5C9bB", // migrateFromLegacyReputationToken()
  ftm: "0x4E15361FD6b4BB609Fa63C81A2be19d873717870", // bridge through the Sonic Gateway, paid in S
  ohmV1: "0x383518188C0C6d7730D91b2c03a03C837814a899", ohmMigrator: "0x184f3FAd8618a6F458C16bae63F70C426fE784B3", oldWsOhm: "0xCa76543Cf381ebBB277bE79574059e32108e3E65", gOhm: "0x0ab87046fBb341D058F17CBC4c1133F25a20a52f",
};

export async function oldTokens(p, ctx) {
  check(p);
  const a = p.address;
  const [sai, nu, keep, rep, ftm, ohm, fix, nuRatio, keepRatio] = await multi(ctx, "ethereum", [
    ...[OLD.sai, OLD.nu, OLD.keep, OLD.repV1, OLD.ftm, OLD.ohmV1].map((to) => ({ to, abi: BAL, fn: "balanceOf", args: [a] })),
    { to: OLD.saiTap, abi: ["function fix() view returns (uint256)"], fn: "fix" },
    { to: OLD.nuVm, abi: ["function ratio() view returns (uint256)"], fn: "ratio" },
    { to: OLD.keepVm, abi: ["function ratio() view returns (uint256)"], fn: "ratio" },
  ]);
  if (![sai, nu, keep, rep, ftm, ohm].some((v) => v > 0n)) return { items: [], errors: [] };
  // OHM v1: the migrator pays gOHM out of its own balance once the v1 supply was migrated; it holds almost none now
  const [gohmOut, migratorGohm] = ohm > 0n ? await multi(ctx, "ethereum", [
    { to: OLD.oldWsOhm, abi: ["function sOHMTowOHM(uint256) view returns (uint256)"], fn: "sOHMTowOHM", args: [ohm] },
    { to: OLD.gOhm, abi: BAL, fn: "balanceOf", args: [OLD.ohmMigrator] },
  ]) : [null, null];
  const px = await prices(ctx, ["coingecko:ethereum", "coingecko:threshold-network-token", "coingecko:augur", "coingecko:sonic-3", "coingecko:governance-ohm"]);
  const usd = (n, key) => { const pr = priceOf(px, key); return pr == null || n == null ? null : n * pr; };
  const items = [];
  if (sai > 0n && fix != null) {
    const eth = units(sai) * (Number(fix) / 1e27);
    items.push({ category: "token_migration", chain: "ethereum", protocol: "Maker SAI", asset: "SAI", token: OLD.sai, amount: units(sai), usd: usd(eth, "coingecko:ethereum"), status: "ready",
      paid: { asset: "WETH", amount: eth }, action: `cash out SAI for ${round6(eth)} WETH (Tap.cash(amount))`, how_to_claim: writeLink("ethereum", OLD.saiTap),
      detail: `Single-collateral Dai was shut down in 2020; its Tap still pays ${Number(fix) / 1e27} WETH per SAI. SAI's market price is meaningless, the WETH it cashes out for is the value` });
  }
  for (const [raw, ratio, sym, token, vm] of [[nu, nuRatio, "NU", OLD.nu, OLD.nuVm], [keep, keepRatio, "KEEP", OLD.keep, OLD.keepVm]]) {
    if (!(raw > 0n) || ratio == null) continue;
    const t = units(raw) * (Number(ratio) / 1e15); // conversionToT(amount) = amount x ratio / 1e15
    items.push({ category: "token_migration", chain: "ethereum", protocol: "Threshold", asset: sym, token, amount: units(raw), usd: usd(t, "coingecko:threshold-network-token"), status: "ready",
      paid: { asset: "T", amount: t }, action: `swap ${sym} for ${round6(t)} T (approve, then VendingMachine.wrap(amount))`, how_to_claim: writeLink("ethereum", vm),
      detail: `NuCypher and Keep merged into Threshold; the ${sym} VendingMachine still swaps ${sym} to T, no deadline` });
  }
  if (rep > 0n) items.push({ category: "token_migration", chain: "ethereum", protocol: "Augur", asset: "REPv1", token: OLD.repV1, amount: units(rep), usd: usd(units(rep), "coingecko:augur"), status: "ready",
    paid: { asset: "REPv2", amount: units(rep) }, action: "migrate REPv1 to REPv2 1:1 (approve REPv2, then REPv2.migrateFromLegacyReputationToken())", how_to_claim: writeLink("ethereum", OLD.repV2),
    detail: "Augur v2 replaced REPv1; only REPv2 trades, REPv1 migrates 1:1 with no deadline" });
  if (ftm > 0n) items.push({ category: "token_migration", chain: "ethereum", protocol: "Sonic", asset: "FTM", token: OLD.ftm, amount: units(ftm), usd: usd(units(ftm), "coingecko:sonic-3"), status: "check",
    paid: { asset: "S", amount: units(ftm) }, action: "bridge FTM (ERC-20) through the Sonic Gateway to receive S on Sonic", how_to_claim: "https://gateway.soniclabs.com",
    detail: "Fantom became Sonic; FTM on Ethereum moves to S through the Sonic Gateway. Valued 1:1 in S: check the rate and any fee the gateway shows" });
  if (ohm > 0n) {
    const g = gohmOut == null ? null : units(gohmOut);
    const paysOut = migratorGohm != null && gohmOut != null && migratorGohm >= gohmOut;
    items.push({ category: "token_migration", chain: "ethereum", protocol: "Olympus", asset: "OHMv1", token: OLD.ohmV1, amount: units(ohm, 9), usd: paysOut ? usd(g, "coingecko:governance-ohm") : null, status: paysOut ? "ready" : "unfunded",
      paid: { asset: "gOHM", amount: g }, action: `migrate OHM v1 to gOHM (approve, then migrate(amount, 0, 2) on the OlympusTokenMigrator)`, how_to_claim: writeLink("ethereum", OLD.ohmMigrator),
      detail: paysOut ? `the migrator pays ${round6(g)} gOHM for it` : `would be ${round6(g)} gOHM, but the migrator holds only ${round6(units(migratorGohm ?? 0n))} gOHM, so the call likely reverts: ask Olympus` });
  }
  return { items, errors: [] };
}

export const LOCKS = {
  veCRV: ["0x5f3b5DfEb7B28CDbD7FAba78963EE202a494e2A2", "CRV", "coingecko:curve-dao-token", "https://www.curve.finance/dao/ethereum/locker/"],
  veFXS: ["0xc8418aF6358FFddA74e09Ca9CC3Fe03Ca6aDC5b0", "FXS", "coingecko:frax-share", "https://app.frax.finance/vefxs"],
  veBAL: ["0xC128a9954e6c874eA3d62ce62B468bA073093F25", "B-80BAL-20WETH", "ethereum:0x5c6ee304399dbdb9c8ef030ab642b10820db8f56", "https://balancer.fi/vebal"],
  vlCVX: ["0x72a19342e8F1838460eBFCCEf09F6585e32db86E", "CVX", "coingecko:convex-finance", "https://curve.convexfinance.com/stake"],
};

export async function expiredLocks(p, ctx) {
  check(p);
  const a = p.address, names = ["veCRV", "veFXS", "veBAL"];
  const res = await multi(ctx, "ethereum", [
    ...names.map((n) => ({ to: LOCKS[n][0], abi: ["function locked(address) view returns (int128 amount, uint256 end)"], fn: "locked", args: [a] })),
    { to: LOCKS.vlCVX[0], abi: ["function lockedBalances(address) view returns (uint256 total, uint256 unlockable, uint256 locked, (uint112 amount, uint112 boosted, uint32 unlockTime)[] lockData)"], fn: "lockedBalances", args: [a] },
  ]);
  const raw = [];
  names.forEach((n, i) => { const r = res[i]; if (r && r[0] > 0n) raw.push({ n, amount: units(r[0]), ends: new Date(Number(r[1]) * 1000).toISOString() }); });
  const cvx = res[3];
  if (cvx && cvx[1] > 0n) raw.push({ n: "vlCVX", amount: units(cvx[1]), ends: null, locked: units(cvx[2]) });
  if (!raw.length) return { items: [], errors: [] };
  const px = await prices(ctx, raw.map((r) => LOCKS[r.n][2]));
  const items = raw.map((r) => {
    const [to, sym, key, app] = LOCKS[r.n], pr = priceOf(px, key);
    const cvxLock = r.n === "vlCVX";
    return {
      category: "unstake_ready", chain: "ethereum", protocol: r.n, asset: sym, amount: r.amount, usd: pr == null ? null : r.amount * pr, ends: r.ends, contract: to, ...(r.locked > 0 && { locked: r.locked }),
      action: cvxLock ? "withdraw expired vlCVX locks (processExpiredLocks(false))" : `withdraw the ${sym} from the ${r.n} lock (withdraw())`, how_to_claim: app,
      detail: cvxLock ? `vlCVX locks past their epoch are unlockable${r.locked > 0 ? `; ${round6(r.locked)} CVX is still locked` : ""}` : `${r.n} lock of ${round6(r.amount)} ${sym} ends ${r.ends.slice(0, 10)}; once ended it earns nothing and can be withdrawn`,
      write: writeLink("ethereum", to),
    };
  });
  return { items, errors: [] };
}

const round6 = (v) => (v == null ? null : Math.round(v * 1e6) / 1e6);
