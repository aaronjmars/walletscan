// perps/evm-vaults.mjs - EVM perp venues read from one vault-style contract per chain: the GMX v1 Vault and its forks
// (GMX v1, Fulcrom, Mummy, Morphex) through one generic reader, plus single-contract reads (Perpetual Protocol v2,
// Vela, KiloEx, JOJO). Every amount here is USD-denominated onchain, so no price lookup is needed.
import { parseAbi } from "viem";

// ---- GMX v1 style Vault
// Vault addresses read 2026-10-20 (gmx, fulcrom, mummy-finance, morphex; each
// answered allWhitelistedTokensLength or whitelistedTokenCount live). list "all" = allWhitelistedTokens (keeps tokens
// de-listed later, which can still back positions); "wl" = Fulcrom's whitelistedTokenCount/whitelistedTokens.
const GMX_V1 = [
  { chain: "arbitrum", vault: "0x489ee077994B6658eAfA855C308275EAd8097C4A", list: "all" },
  { chain: "avalanche", vault: "0x9ab2De34A33fB459b538c43f251eB825645e8595", list: "all" },
];
const FULCROM = [
  { chain: "cronos", vault: "0x8C7Ef34aa54210c76D6d5E475f43e0c11f876098", list: "wl" },
  { chain: "zksync", vault: "0x7d5b0215EF203D0660BC37d5D09d964fd6b55a1E", list: "wl" },
  { chain: "cronos-zkevm", vault: "0xdDDf221d5293619572616574Ff46a2760f162075", list: "wl" },
];
const MUMMY = [
  { chain: "fantom", vault: "0xA6D7D0e650aa40FFa42d845A354c12c2bc0aB15f", list: "all" },
  { chain: "fantom", vault: "0x7e9E9d925846B110B025041cfdF9942f2C401F4F", list: "all" },
  { chain: "optimism", vault: "0xA6D7D0e650aa40FFa42d845A354c12c2bc0aB15f", list: "all" },
  { chain: "arbitrum", vault: "0x304951d7172bCAdA54ccAC1E4674862b3d5b3d5b", list: "all" },
  { chain: "base", vault: "0xA6D7D0e650aa40FFa42d845A354c12c2bc0aB15f", list: "all" },
];
const MORPHEX = [
  { chain: "fantom", vault: "0x3CB54f0eB62C371065D739A34a775CC16f46563e", list: "all" },
  { chain: "fantom", vault: "0x245cD6d33578de9aF75a3C0c636c726b1A8cbdAa", list: "all" },
  { chain: "bsc", vault: "0x46940Dc651bFe3F2CC3E04cf9dC5579B50Cf0765", list: "all" },
];

const vaultAbi = parseAbi([
  "function allWhitelistedTokensLength() view returns (uint256)",
  "function allWhitelistedTokens(uint256) view returns (address)",
  "function whitelistedTokenCount() view returns (uint256)",
  "function whitelistedTokens(uint256) view returns (address)",
  "function stableTokens(address) view returns (bool)",
  "function shortableTokens(address) view returns (bool)",
  "function getPosition(address account, address collateralToken, address indexToken, bool isLong) view returns (uint256 size, uint256 collateral, uint256 averagePrice, uint256 entryFundingRate, uint256 reserveAmount, uint256 realisedPnl, bool hasRealisedProfit, uint256 lastIncreasedTime)",
  "function getPositionDelta(address account, address collateralToken, address indexToken, bool isLong) view returns (bool hasProfit, uint256 delta)",
  "function getMinPrice(address token) view returns (uint256)",
  "function getMaxPrice(address token) view returns (uint256)",
]);
const symAbi = parseAbi(["function symbol() view returns (string)"]);
const usd30 = (v) => Number(v) / 1e30; // 1e30-scaled USD -> number
const round2 = (x) => Math.round(x * 100) / 100;

// every open position of `address` in the given vaults of one chain, four or five multicalls: token count, token list,
// stable/shortable flags + symbols, getPosition for every valid key, then the PnL of the open ones: the vault's own
// getPositionDelta, or (Fulcrom has none) the same formula from getMinPrice/getMaxPrice; neither answers when the
// chain's oracle is dead (Morphex Fantom), so PnL stays unknown there.
// Valid keys as GMX v1 validates them: longs use collateral == index (non-stable), shorts a stable collateral
// against a shortable index.
async function v1Positions(io, chain, vaults, address) {
  const count = await io.multicall(chain, vaults.map((v) => ({ to: v.vault, abi: vaultAbi, functionName: v.list === "wl" ? "whitelistedTokenCount" : "allWhitelistedTokensLength" })));
  const idx = vaults.flatMap((v, i) => Array.from({ length: Number(count[i] ?? 0) }, (_, k) => ({ v, k })));
  const addrs = await io.multicall(chain, idx.map(({ v, k }) => ({ to: v.vault, abi: vaultAbi, functionName: v.list === "wl" ? "whitelistedTokens" : "allWhitelistedTokens", args: [BigInt(k)] })));
  const tokens = vaults.map((v) => [...new Set(idx.map((x, i) => (x.v === v ? addrs[i] : null)).filter(Boolean))].map((t) => ({ v, t })));
  const all = tokens.flat();
  const meta = await io.multicall(chain, all.flatMap(({ v, t }) => [
    { to: v.vault, abi: vaultAbi, functionName: "stableTokens", args: [t] },
    { to: v.vault, abi: vaultAbi, functionName: "shortableTokens", args: [t] },
    { to: t, abi: symAbi, functionName: "symbol" },
  ]));
  all.forEach((x, i) => Object.assign(x, { stable: meta[3 * i] === true, shortable: meta[3 * i + 1] === true, sym: meta[3 * i + 2] || `${x.t.slice(0, 8)}...` }));
  const keys = tokens.flatMap((list) => {
    const stables = list.filter((x) => x.stable);
    return list.filter((x) => !x.stable).flatMap((ix) => [
      { v: ix.v, col: ix, ix, isLong: true },
      ...(ix.shortable ? stables.map((col) => ({ v: ix.v, col, ix, isLong: false })) : []),
    ]);
  });
  const args = (k) => [address, k.col.t, k.ix.t, k.isLong];
  const pos = await io.multicall(chain, keys.map((k) => ({ to: k.v.vault, abi: vaultAbi, functionName: "getPosition", args: args(k) })));
  const open = keys.map((k, i) => ({ ...k, size: pos[i]?.[0] ?? 0n, collateral: pos[i]?.[1] ?? 0n, avg: pos[i]?.[2] ?? 0n })).filter((k) => k.size > 0n);
  if (!open.length) return [];
  const delta = await io.multicall(chain, open.flatMap((k) => [
    { to: k.v.vault, abi: vaultAbi, functionName: "getPositionDelta", args: args(k) },
    { to: k.v.vault, abi: vaultAbi, functionName: k.isLong ? "getMinPrice" : "getMaxPrice", args: [k.ix.t] },
  ]));
  return open.map((k, i) => {
    const own = delta[2 * i], px = delta[2 * i + 1];
    let d = own ? (own[0] ? 1n : -1n) * own[1] : null;
    // GMX v1 Vault.getDelta: size * |price - averagePrice| / averagePrice, profit when the price moved the trade's way
    if (d == null && px && k.avg > 0n) d = (k.size * (px - k.avg)) / k.avg * (k.isLong ? 1n : -1n);
    return { chain, vault: k.v.vault, isLong: k.isLong, index: k.ix.sym, collateralSym: k.col.sym, size: usd30(k.size), collateral: usd30(k.collateral), net: usd30(k.collateral + (d ?? 0n)), pnl: d == null ? null : usd30(d) };
  });
}

// one reader per GMX v1 style venue: vaults grouped per chain, chains read in parallel
function v1Reader(vaults, toItem) {
  const byChain = Object.entries(Object.groupBy(vaults, (v) => v.chain));
  return async (address, io) => {
    const per = await Promise.all(byChain.map(([chain, vs]) => v1Positions(io, chain, vs, address)));
    return per.flat().filter((p) => p.net > 0.01).map(toItem);
  };
}

const posDetail = (venue, p) =>
  `${venue} ${p.isLong ? "long" : "short"} ${p.index} (${p.collateralSym} collateral), size $${Math.round(p.size)}; collateral $${round2(p.collateral)}` +
  (p.pnl == null ? ", PnL unknown" : ` ${p.pnl < 0 ? "-" : "+"} PnL $${round2(Math.abs(p.pnl))}, fees not taken off`);

// withdraw-only GMX v1 forks: the position's collateral + PnL is what closing it returns (our estimate: fees not counted)
// amount is USD (collateral + PnL), so the asset is the market (BTC.b-PERP, as Adrena and Jupiter rows), not the index token
const closedV1 = (protocol, how) => (p) => ({
  protocol, chain: p.chain, asset: `${p.index}-PERP`, amount: p.net, usd: p.net, kind: "position", status: "closed",
  confidence: "medium", action: `close the ${protocol} position (decreasePosition) to get the collateral back`,
  how_to_claim: how, deadline: null, detail: posDetail(protocol, p),
});

// ---- Perpetual Protocol v2 (Curie), Optimism: Vault from npm @perp/curie-deployments 2024.12.26 optimism/core;
// values in settlement-token decimals (6), read 2026-10-20
const PERP_VAULT = "0xAD7b4C162707E0B2b5f6fdDbD3f8538A5fbA0d60";
const perpAbi = parseAbi([
  "function getFreeCollateral(address trader) view returns (uint256)",
  "function getAccountValue(address trader) view returns (int256)",
]);

// ---- Vela: VUSD (free margin, 30 decimals = USD) at the same address on Arbitrum and Base; Vault withdraws it.
// docs.vela.exchange contracts page, read 2026-10-20
const VELA_VUSD = "0xAA0B397B0896A864714dE56AA33E3df471229268";
const VELA_VAULT = "0xC4ABADE3a15064F9E3596943c699032748b13352";
const VELA_SCAN = { arbitrum: "https://arbiscan.io", base: "https://basescan.org" };
const balAbi = parseAbi(["function balanceOf(address) view returns (uint256)"]);

// ---- KiloEx: PerpTradeReader per chain (KiloExPerp/kiloex-python-sdk config_kiloex.ini, read 2026-10-20). Product ids
// run up to 457 on opBNB and the per-chain catalogue hosts are gone, so a fixed 1..500 range is asked; only open
// positions come back. margin, leverage and prices are 1e8
const KILOEX = { bsc: "0x078E31821C94e5a99a64Fdc60cCae97E807ffCda", opbnb: "0x2f179F55a780C44e319241031cD596eB6f1266bC", manta: "0xE47262628F70981177AF961c75d1aA0d29aAd4d0" };
const KILO_IDS = Array.from({ length: 500 }, (_, i) => BigInt(i + 1));
const kiloAbi = parseAbi([
  "struct Position { uint256 productId; uint256 leverage; uint256 price; uint256 oraclePrice; uint256 margin; address owner; uint256 timestamp; bool isLong; int256 funding; uint256 borrowing; }",
  "function getPositions(address account, uint256[] ids) view returns (Position[])",
]);

// ---- JOJO, Base: Dealer + SubaccountFactory (docs.jojo.exchange/address, read 2026-10-20). Dealer USDC was drained
// in April 2025 and Funding.executeWithdraw pays from the Dealer's own balance, so credits cannot be withdrawn now
const JOJO_DEALER = "0x2f7c3cf9d9280b165981311b822becc4e05fe635";
const JOJO_FACTORY = "0x8a2898d6849Aa183073455140F096221c3CF060E";
const jojoAbi = parseAbi([
  "function getTraderRisk(address trader) view returns (int256 netValue, uint256 exposure, uint256 initialMargin, uint256 maintenanceMargin)",
  "function getCreditOf(address trader) view returns (int256 primaryCredit, uint256 secondaryCredit, uint256 pendingPrimaryWithdraw, uint256 pendingSecondaryWithdraw, uint256 executionTimestamp)",
  "function getSubaccounts(address master) view returns (address[])",
]);
const e6 = (v) => Number(v) / 1e6;

export const EVM = {
  // GMX v1 went withdraw-only after the July 2025 exploit: no new positions, closing stays enabled through the v1
  // portal (docs.gmx.io/docs/archived/trading-v1, read 2026-10-20)
  "gmx-v1": v1Reader(GMX_V1, closedV1("GMX v1", "https://v1.app.gmx.io/#/v1")),

  // Fulcrom still trades on all three chains: an open position is money at work
  fulcrom: v1Reader(FULCROM, (p) => ({
    protocol: "Fulcrom", chain: p.chain, asset: `${p.index}-PERP`, amount: p.net, usd: p.net, kind: "position", status: "live",
    detail: posDetail("Fulcrom", p),
  })),

  // Mummy and Morphex: GMX v1 forks with no new positions since 2024 (Mummy's Arbitrum vault was upgraded away 2026-06-25)
  mummy: v1Reader(MUMMY, closedV1("Mummy Finance", "https://mummy.finance")),
  morphex: v1Reader(MORPHEX, closedV1("Morphex", "https://morphex.trade")),

  // free collateral = withdrawable now (Vault.withdraw); account value adds open-position PnL and non-USDC collateral
  async "perpetual-protocol"(address, io) {
    const [free, value] = await io.multicall("optimism", ["getFreeCollateral", "getAccountValue"].map((functionName) => ({ to: PERP_VAULT, abi: perpAbi, functionName, args: [address] })));
    if (free == null || value == null) throw { error: "Perpetual Protocol Vault read reverted" };
    const f = e6(free), v = e6(value);
    if (!(f > 0.01) && !(v > 0.01)) return [];
    const base = {
      protocol: "Perpetual Protocol", chain: "optimism", asset: "USDC", kind: "deposit", status: "closed", deadline: null,
      how_to_claim: `https://optimistic.etherscan.io/address/${PERP_VAULT}#writeProxyContract`,
    };
    if (f > 0.01) return [{
      ...base, amount: f, usd: f, confidence: "high",
      action: "withdraw your collateral from the Perpetual Protocol v2 Vault (withdrawAll)",
      detail: `Perpetual Protocol v2 Vault free collateral $${round2(f)} (withdrawable now); account value $${round2(v)}`,
    }];
    // all of it backs an open position: closing it frees the account value
    return [{
      ...base, kind: "position", amount: v, usd: v, confidence: "medium",
      action: "close the Perpetual Protocol v2 position, then withdraw from the Vault",
      detail: `Perpetual Protocol v2 account value $${round2(v)} tied up in an open position; free collateral $0`,
    }];
  },

  // VUSD is Vela's free margin; the venue is dormant since 2025 and the withdraw path is unverified
  async vela(address, io) {
    const out = [];
    await Promise.all(Object.keys(VELA_SCAN).map(async (chain) => {
      const [bal] = await io.multicall(chain, [{ to: VELA_VUSD, abi: balAbi, functionName: "balanceOf", args: [address] }]);
      if (bal == null) throw { error: `Vela VUSD read reverted on ${chain}` };
      const usd = usd30(bal);
      if (usd > 0.01) out.push({
        protocol: "Vela Exchange", chain, asset: "VUSD", amount: usd, usd, kind: "deposit", status: "closed",
        confidence: "medium", action: "withdraw your VUSD margin from the Vela Vault (withdraw)",
        how_to_claim: `${VELA_SCAN[chain]}/address/${VELA_VAULT}#writeContract`, deadline: null,
        detail: `Vela free margin (VUSD, 1 VUSD = $1) on ${chain}; open positions not counted`,
      });
    }));
    return out;
  },

  // KiloEx trades live; value = margin + price PnL (funding and borrowing fees not taken off)
  async kiloex(address, io) {
    const out = [];
    await Promise.all(Object.entries(KILOEX).map(async ([chain, to]) => {
      const [rows] = await io.multicall(chain, [{ to, abi: kiloAbi, functionName: "getPositions", args: [address, KILO_IDS] }]);
      if (rows == null) throw { error: `KiloEx PerpTradeReader reverted on ${chain}` };
      for (const r of rows) {
        const margin = Number(r.margin) / 1e8, lev = Number(r.leverage) / 1e8;
        if (!(margin > 0) || !(r.price > 0n)) continue;
        const move = Number(r.oraclePrice) / Number(r.price) - 1;
        const pnl = margin * lev * (r.isLong ? move : -move), net = round2(margin + pnl);
        if (!(net > 0.01)) continue;
        out.push({
          protocol: "KiloEx", chain, asset: `product ${r.productId}`, amount: net, usd: net, kind: "position", status: "live",
          detail: `KiloEx ${r.isLong ? "long" : "short"} product ${r.productId}, ${round2(lev)}x, margin $${round2(margin)} ${round2(pnl) < 0 ? "-" : "+"} PnL $${round2(Math.abs(pnl))}, fees not taken off`,
        });
      }
    }));
    return out;
  },

  // JOJO: the wallet and its subaccounts; net value = USDC + JUSD credit + open-position value
  async jojo(address, io) {
    const [subs] = await io.multicall("base", [{ to: JOJO_FACTORY, abi: jojoAbi, functionName: "getSubaccounts", args: [address] }]);
    const accounts = [address, ...(subs || [])];
    const res = await io.multicall("base", accounts.flatMap((a) => [
      { to: JOJO_DEALER, abi: jojoAbi, functionName: "getTraderRisk", args: [a] },
      { to: JOJO_DEALER, abi: jojoAbi, functionName: "getCreditOf", args: [a] },
    ]));
    return accounts.flatMap((a, i) => {
      const risk = res[2 * i], credit = res[2 * i + 1];
      if (!risk || !credit) return [];
      const net = e6(risk[0]);
      if (!(net > 0.01)) return [];
      const sub = i ? `subaccount ${a}` : "main account";
      return [{
        protocol: "JOJO", chain: "base", asset: "USDC", amount: net, usd: net, kind: risk[1] > 0n ? "position" : "deposit",
        status: "closed", confidence: "low", action: "contact JOJO support: the Dealer no longer holds the USDC to pay this credit out",
        how_to_claim: "https://jojo.exchange/", deadline: null,
        detail: `JOJO ${sub} net value $${round2(net)} (USDC credit $${round2(e6(credit[0]))}, JUSD credit $${round2(e6(credit[1]))}${risk[1] > 0n ? ", open position" : ""}); the Dealer holds almost no USDC`,
      }];
    });
  },
};
