// perps/evm-onchain.mjs - EVM perp venues read from several contracts or an API plus contracts: SynFutures V3 Gate
// deposits, MUX v1 subaccounts, gTrade trades, Aevo L2 collateral, Orderly L2 ledger balances, Variational pools.
import { parseAbi, formatUnits, encodePacked, padHex, pad, hexToString, keccak256, toHex } from "viem";

const units = (raw, dec) => Number(formatUnits(raw, dec));
const round2 = (x) => Math.round(x * 100) / 100;
const fmt = (x) => (Math.abs(x) >= 1 ? round2(x).toLocaleString("en-US") : String(Number(x.toPrecision(4))));
const DUST_USD = 0.01; // priced rows under a cent are dropped
const keep = (usd) => usd == null || Math.abs(usd) >= DUST_USD;
const erc20Abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

// ---- SynFutures V3: idle per-quote deposits in the Gate (Gate.withdraw is a direct user call). Gates and quote
// lists from SynFutures/oyster-sdk src/config/<chain>.json (contractAddress.gate, quotesParam + tokenInfo); Base USDC/WETH,
// the Blast quotes missing from tokenInfo and Arbitrum USDC = USDC.e from the tokens each Gate holds; read 2026-10-20.
// Base and Monad still take deposits; Arbitrum was left in Feb 2024 and Blast is withdraw-only since May 2025.
const SYN = {
  base: { gate: "0x208B443983D8BcC8578e9D86Db23FbA547071270", live: true, quotes: [
    ["USDC", "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", 6], ["WETH", "0x4200000000000000000000000000000000000006", 18],
    ["CHOMP", "0xebfF2db643Cf955247339c8c6bCD8406308ca437", 18], ["DEGEN", "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed", 18],
    ["ISK", "0xd85EFF20288ca72eA9eEcFFb428F89EE5066CA5C", 18], ["wrsETH", "0xEDfa23602D0EC14714057867A78d01e94176BEA0", 18],
    ["weETH", "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", 18], ["wstETH", "0xc1CBa3fCea344f92D9239c08C0568f6F2F0ee452", 18],
    ["BOOMER", "0xcdE172dc5ffC46D228838446c57C1227e0B82049", 18], ["wcgUSD", "0x5AE84075F0E34946821A8015dAB5299A00992721", 6],
    ["BtcUSD", "0xe4b20925D9E9a62F1E492e15a81dC0de62804dd4", 18], ["KLIMA", "0xDCEFd8C8fCc492630B943ABcaB3429F12Ea9Fea2", 9],
    ["TAD", "0x55027a5b06f4340cC4C82DCC74C90cA93dcb173E", 18], ["SolvBTC", "0x3B86Ad95859b6AB773f55f8d94B4b9d443EE931f", 18],
    ["pumpBTC", "0xF469fBD2abcd6B9de8E169d128226C0Fc90a012e", 8], ["cbBTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8],
    ["BRETT", "0x532f27101965dd16442E59d40670FaF5eBB142E4", 18], ["ION", "0x3eE5e23eEE121094f1cFc0Ccc79d6C809Ebd22e5", 18],
    ["LRDS", "0xB676f87A6E701f0DE8De5Ab91B56b66109766DB1", 18], ["LUNA", "0x55cD6469F597452B5A7536e2CD98fDE4c1247ee4", 18],
    ["VIRTUAL", "0x0b3e328455c4059EEb9e3f84b5543F74E24e7E1b", 18], ["BONSAICOIN", "0xA0aeBd4Ae5F256B72B7D43f67eD934237Adb1AeE", 18],
    ["ALB", "0x1dd2d631c92b1aCdFCDd51A0F7145A50130050C4", 18], ["USR", "0x35E5dB674D8e93a03d814FA0ADa70731efe8a4b9", 18],
    ["GENOME", "0x1db0c569ebb4a8b57AC01833B9792F526305e062", 18], ["TRVL", "0x74aa9bB52B36a378a6E641B86d7acb76Dc9b3940", 18],
    ["AIRENE", "0x2eac9B08A4D86F347B9E856fB3EC082e61c76545", 18],
  ] },
  monad: { gate: "0x2E32345Bf0592bFf19313831B99900C530D37d90", live: true, quotes: [["USDC", "0x754704Bc059F8C67012fEd69BC8A327a5aafb603", 6]] },
  arbitrum: { gate: "0x6A372dBc1968f4a07cf2ce352f410962A972c257", scan: "https://arbiscan.io", quotes: [
    ["USDC.e", "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", 6], ["WETH", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", 18],
  ] },
  blast: { gate: "0x6A372dBc1968f4a07cf2ce352f410962A972c257", scan: "https://blastscan.io", quotes: [
    ["USDB", "0x4300000000000000000000000000000000000003", 18], ["WETH", "0x4300000000000000000000000000000000000004", 18],
    ["fwWETH", "0x66714DB8F3397c767d0A602458B5b4E3C0FE7dd1", 18], ["PAC", "0x5ffd9EbD27f2fcAB044c0f0a26A45Cb62fa29c06", 18],
    ["ezETH", "0x2416092f143378750bb29b79eD961ab195CcEea5", 18], ["weETH", "0x04C0599Ae5A44757c0af6F9eC3b93da8976c150A", 18],
    ["ESE", "0x491e6DE43b55c8EAE702EDC263E32339da42f58c", 18], ["wrsETH", "0xe7903B1F75C534Dd8159b313d92cDCfbC62cB3Cd", 18],
    ["BLAST", "0xb1a5700fA2358173Fe465e6eA4Ff52E36e88E2ad", 18],
  ] },
};
const gateAbi = parseAbi(["function reserveOf(address quote, address user) view returns (uint256)"]);

async function synfutures(address, io) {
  const per = await Promise.all(Object.entries(SYN).map(async ([chain, s]) => {
    const r = await io.multicall(chain, s.quotes.map(([, q]) => ({ to: s.gate, abi: gateAbi, functionName: "reserveOf", args: [q, address] })));
    return s.quotes.map(([sym, q, dec], i) => ({ chain, s, sym, q, amount: r[i] ? units(r[i], dec) : 0 })).filter((x) => x.amount > 0);
  }));
  const rows = per.flat();
  if (!rows.length) return [];
  const px = await io.prices(rows.map((x) => `${x.chain}:${x.q}`));
  return rows.map((x) => {
    const p = px.get(`${x.chain}:${x.q}`.toLowerCase());
    return { ...x, usd: p == null ? null : x.amount * p };
  }).filter((x) => keep(x.usd)).map(({ chain, s, sym, amount, usd }) => {
    const base = { protocol: "SynFutures", chain, asset: sym, amount, usd, kind: "deposit" };
    const what = `SynFutures V3 Gate on ${chain}: ${fmt(amount)} ${sym} idle deposit (open positions, orders and LP not included)`;
    if (s.live) return { ...base, status: "live", detail: what };
    return {
      ...base, status: "closed", confidence: "high", deadline: null,
      action: `call withdraw on the SynFutures Gate for ${sym} to take the deposit back`,
      how_to_claim: `${s.scan}/address/${s.gate}#writeContract`,
      detail: `${what}; the ${chain} deployment is ${chain === "blast" ? "withdraw-only" : "abandoned"}, Gate.withdraw still pays out`,
    };
  });
}

// ---- MUX v1 LiquidityPool (mux-world/mux.js src/constants.ts, read 2026-10-20). Subaccount id =
// abi.encodePacked(trader, collateralId, assetId, isLong) right-padded to 32 bytes, so every subaccount is found
// without an indexer. collateral and size are 1e18 units of the collateral / traded asset; collateral excludes PnL.
// Arbitrum, BSC, Optimism and Avalanche pools still take deposits (Avalanche: 59 OpenPosition events in Sept 2026);
// Fantom is withdraw-only in practice: its last OpenPosition was 2023-07-08, last WithdrawCollateral 2025-04-07.
const MUX = {
  arbitrum: { pool: "0x3e0199792Ce69DC29A0a36146bFa68bd7C8D6633", live: true },
  bsc: { pool: "0x855E99F768FaD76DD0d3EB7c446C0b759C96D520", live: true },
  optimism: { pool: "0xc6BD76FA1E9e789345e003B361e4A0037DFb7260", live: true },
  avalanche: { pool: "0x0bA2e492e8427fAd51692EE8958eBf936bEE1d84", live: true },
  fantom: { pool: "0x2e81F443A11a943196c88afcB5A0D807721A88E6" },
};
// MUX asset symbol (".e" and Fantom "f" prefixes stripped) -> DefiLlama coingecko key; the same on every chain, and
// DefiLlama no longer prices Fantom token addresses
const MUX_CG = { USDC: "usd-coin", USDT: "tether", DAI: "dai", BUSD: "binance-usd", ETH: "ethereum", BTC: "bitcoin", AVAX: "avalanche-2", BNB: "binancecoin", FTM: "fantom", OP: "optimism", ARB: "arbitrum" };
const muxAbi = parseAbi([
  "struct Asset { bytes32 symbol; address tokenAddress; uint8 id; uint8 decimals; uint56 flags; uint24 _flagsPadding; uint32 initialMarginRate; uint32 maintenanceMarginRate; uint32 minProfitRate; uint32 minProfitTime; uint32 positionFeeRate; address referenceOracle; uint32 referenceDeviation; uint8 referenceOracleType; uint32 halfSpread; uint96 credit; uint128 _reserved2; uint96 collectedFee; uint32 liquidationFeeRate; uint96 spotLiquidity; uint96 maxLongPositionSize; uint96 totalLongPosition; uint96 averageLongPrice; uint96 maxShortPositionSize; uint96 totalShortPosition; uint96 averageShortPrice; address muxTokenAddress; uint32 spotWeight; uint32 longFundingBaseRate8H; uint32 longFundingLimitRate8H; uint128 longCumulativeFundingRate; uint128 shortCumulativeFunding; }",
  "function getAllAssetInfo() view returns (Asset[])",
  "function getSubAccount(bytes32 subAccountId) view returns (uint96 collateral, uint96 size, uint32 lastIncreasedTime, uint96 entryPrice, uint128 entryFunding)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";
const muxSym = (a) => hexToString(a.symbol, { size: 32 }).replace(/\0/g, "");
const muxKey = (sym) => MUX_CG[sym.replace(/\.e$/, "").replace(/^f(?=USDT$)/, "")];

async function muxChain(chain, m, address, io) {
  const [assets] = await io.multicall(chain, [{ to: m.pool, abi: muxAbi, functionName: "getAllAssetInfo" }]);
  if (!assets) throw { error: `MUX ${chain} getAllAssetInfo failed` };
  // collateral must be a real token; only non-stable assets (flag bit 0 = stable) can be traded
  const subs = assets.filter((c) => c.tokenAddress !== ZERO).flatMap((col) => assets.filter((a) => !(a.flags & 1n)).flatMap((as) => [true, false].map((isLong) => ({
    col, as, isLong, id: padHex(encodePacked(["address", "uint8", "uint8", "bool"], [address, col.id, as.id, isLong]), { dir: "right", size: 32 }),
  }))));
  const r = await io.multicall(chain, subs.map((s) => ({ to: m.pool, abi: muxAbi, functionName: "getSubAccount", args: [s.id] })));
  return subs.map((s, i) => ({ ...s, chain, m, collateral: r[i] ? units(r[i][0], 18) : 0, size: r[i] ? units(r[i][1], 18) : 0 })).filter((s) => s.collateral > 0);
}

async function mux(address, io) {
  const rows = (await Promise.all(Object.entries(MUX).map(([chain, m]) => muxChain(chain, m, address, io)))).flat();
  if (!rows.length) return [];
  const key = (s) => (muxKey(muxSym(s.col)) ? `coingecko:${muxKey(muxSym(s.col))}` : null);
  const px = await io.prices(rows.map(key));
  return rows.map((s) => {
    const p = key(s) && px.get(key(s));
    const sym = muxSym(s.col), usd = p == null ? null : s.collateral * p;
    const detail = `MUX v1 ${s.chain}: ${s.isLong ? "long" : "short"} ${muxSym(s.as)} subaccount, ${fmt(s.collateral)} ${sym} collateral` +
      (s.size > 0 ? `, size ${fmt(s.size)} ${muxSym(s.as)}; PnL and funding not included` : ", no open position");
    const base = { protocol: "MUX", chain: s.chain, asset: sym, amount: s.collateral, usd, kind: s.size > 0 ? "position" : "deposit", detail };
    if (s.m.live) return { ...base, status: "live" };
    return {
      ...base, status: "closed", confidence: "medium", deadline: null,
      action: `${s.size > 0 ? "close the position and " : ""}withdraw the ${sym} collateral in the MUX app on ${s.chain}`,
      how_to_claim: "https://app.mux.network/",
    };
  }).filter((x) => keep(x.usd));
}

// ---- gTrade (Gains Network) GNSMultiCollatDiamond per chain (GainsNetwork-org/sdk src/contracts/addresses.json,
// read 2026-10-20). getTrades returns open trades plus limit/stop orders (tradeType 0/1/2) with raw collateral in the
// collateral's own decimals (precision = 10^decimals); getPendingOrders adds unfilled market orders. All chains live.
const GAINS = {
  arbitrum: "0xFF162c694eAA571f685030649814282eA457f169",
  polygon: "0x209A9A01980377916851af2cA075C2b170452018",
  base: "0x6cD5aC19a07518A8092eEFfDA4f1174C72704eeb",
  apechain: "0x2BE5D7058AdBa14Bc38E4A83E94A81f7491b0163",
  megaeth: "0x2D5B1ba6E2093a5b927Fe5bF8C049B107de31eaF",
};
const GAINS_PRICE = { "apechain:0x00000000000f7e000644657dc9417b185962645a": "coingecko:apecoin" }; // WAPE: DefiLlama has no apechain key
const TRADE = "(address user,uint32 index,uint16 pairIndex,uint24 leverage,bool long,bool isOpen,uint8 collateralIndex,uint8 tradeType,uint120 collateralAmount,uint64 openPrice,uint64 tp,uint64 sl,bool isCounterTrade,uint160 positionSizeToken,uint24 __placeholder)";
const gainsAbi = parseAbi([
  "function getCollaterals() view returns ((address collateral,bool isActive,uint88 __placeholder,uint128 precision,uint128 precisionDelta)[])",
  `function getTrades(address _trader) view returns (${TRADE}[])`,
  `function getPendingOrders(address _user) view returns ((${TRADE} trade,address user,uint32 index,bool isOpen,uint8 orderType,uint32 createdBlock,uint16 maxSlippageP)[])`,
  "function pairJob(uint256 _pairIndex) view returns (string from, string to)",
]);
const ORDER = ["open trade", "limit order", "stop order"];

async function gainsChain(chain, diamond, address, io) {
  const [cols, trades, pend] = await io.multicall(chain, [
    { to: diamond, abi: gainsAbi, functionName: "getCollaterals" },
    { to: diamond, abi: gainsAbi, functionName: "getTrades", args: [address] },
    { to: diamond, abi: gainsAbi, functionName: "getPendingOrders", args: [address] },
  ]);
  if (!cols || !trades || !pend) throw { error: `gTrade ${chain} read failed` };
  const all = [...trades.filter((t) => t.isOpen), ...pend.filter((o) => o.isOpen).map((o) => ({ ...o.trade, pending: true }))].filter((t) => t.collateralAmount > 0n);
  if (!all.length) return [];
  // names of the three biggest trades' pairs (detail line) and the collateral symbols, one more multicall
  const top = [...all].sort((a, b) => (b.collateralAmount > a.collateralAmount) - (b.collateralAmount < a.collateralAmount)).slice(0, 3);
  const pairIdx = [...new Set(top.map((t) => t.pairIndex))];
  const colIdx = [...new Set(all.map((t) => t.collateralIndex))];
  const meta = await io.multicall(chain, [
    ...pairIdx.map((i) => ({ to: diamond, abi: gainsAbi, functionName: "pairJob", args: [BigInt(i)] })),
    ...colIdx.map((i) => ({ to: cols[i - 1].collateral, abi: erc20Abi, functionName: "symbol" })),
  ]);
  const pairName = new Map(pairIdx.map((i, k) => [i, meta[k] ? `${meta[k][0]}/${meta[k][1]}` : `pair ${i}`]));
  return colIdx.map((ci, k) => {
    const ts = all.filter((t) => t.collateralIndex === ci), c = cols[ci - 1];
    const dec = String(c.precision).length - 1;
    const kinds = Object.entries(Object.groupBy(ts, (t) => (t.pending ? "pending market order" : ORDER[t.tradeType] || "order"))).map(([n, v]) => `${v.length} ${n}${v.length > 1 ? "s" : ""}`);
    const named = top.filter((t) => t.collateralIndex === ci).map((t) => `${pairName.get(t.pairIndex)} ${t.long ? "long" : "short"} ${Number(t.leverage) / 1000}x`);
    const sym = meta[pairIdx.length + k] || `${c.collateral.slice(0, 8)}...`;
    return { chain, token: c.collateral, sym, amount: units(ts.reduce((s, t) => s + t.collateralAmount, 0n), dec), kinds, named };
  });
}

async function gains(address, io) {
  const rows = (await Promise.all(Object.entries(GAINS).map(([chain, d]) => gainsChain(chain, d, address, io)))).flat();
  if (!rows.length) return [];
  const key = (r) => { const k = `${r.chain}:${r.token}`.toLowerCase(); return GAINS_PRICE[k] || k; };
  const px = await io.prices(rows.map(key));
  return rows.map((r) => {
    const p = px.get(key(r)), sym = r.sym;
    return {
      protocol: "gTrade", chain: r.chain, asset: sym, amount: r.amount, usd: p == null ? null : r.amount * p, kind: "position", status: "live",
      detail: `gTrade ${r.chain}: ${r.kinds.join(", ")} (${r.named.join(", ")}), ${fmt(r.amount)} ${sym} collateral; PnL and fees not included`,
    };
  }).filter((x) => keep(x.usd));
}

// ---- Aevo L2 (chain 2999): Accounts registry 0x05c1...a382 (exchange 0x23B4...DcB4 slot 5), read 2026-10-20.
// getCollaterals lists USDC (the quote) first, then WETH, WBTC, USDTs, aeUSD, weETH and Ondo tokenized stocks
// (<TICKER>on). Balances are signed (negative = borrowed against other collateral), settled only: unrealized PnL of
// open options/perps is not in them.
const AEVO_ACCOUNTS = "0x05c1674269389be6760047c307c26a7beb8ba382";
// aeUSD is "Aevo Hybrid USDC" (USDC-backed): priced as USDC
const AEVO_CG = { USDC: "usd-coin", aeUSD: "usd-coin", USDT: "tether", WETH: "ethereum", WBTC: "bitcoin", weETH: "wrapped-eeth" };
const aevoAbi = parseAbi(["function getCollaterals() view returns (address[])", "function getCollateralBalance(address account, address collateral) view returns (int256)"]);

async function aevo(address, io) {
  const [cols] = await io.multicall("aevo", [{ to: AEVO_ACCOUNTS, abi: aevoAbi, functionName: "getCollaterals" }]);
  if (!cols) throw { error: "Aevo getCollaterals failed" };
  const r = await io.multicall("aevo", cols.flatMap((c) => [
    { to: AEVO_ACCOUNTS, abi: aevoAbi, functionName: "getCollateralBalance", args: [address, c] },
    { to: c, abi: erc20Abi, functionName: "symbol" },
    { to: c, abi: erc20Abi, functionName: "decimals" },
  ]));
  const rows = cols.map((c, i) => ({ sym: r[3 * i + 1] || c, raw: r[3 * i] ?? 0n, dec: r[3 * i + 2] })).filter((x) => x.raw !== 0n && x.dec != null)
    .map((x) => ({ ...x, amount: units(x.raw, x.dec) }));
  if (!rows.length) return [];
  const px = await io.prices(rows.map((x) => AEVO_CG[x.sym] && `coingecko:${AEVO_CG[x.sym]}`));
  // tokenized stocks: Aevo's own index price for the ticker (DefiLlama has no Aevo L2 keys)
  const stock = (s) => s.match(/^([A-Z]+)on$/)?.[1];
  for (const x of rows.filter((x) => stock(x.sym))) {
    const res = await io.call("holdings.aevo_index", { asset: stock(x.sym) });
    if (res.ok && Number(res.data?.price) > 0) x.price = Number(res.data.price);
  }
  return rows.map((x) => {
    const p = x.price ?? (AEVO_CG[x.sym] ? px.get(`coingecko:${AEVO_CG[x.sym]}`) : null);
    return {
      protocol: "Aevo", chain: "aevo", asset: x.sym, amount: x.amount, usd: p == null ? null : x.amount * p, kind: "deposit", status: "live",
      detail: x.amount < 0 ? `Aevo account: ${fmt(x.amount)} ${x.sym} balance, borrowed against other collateral` : `Aevo account: ${fmt(x.amount)} ${x.sym} settled collateral (unrealized PnL not included)`,
    };
  }).filter((x) => keep(x.usd));
}

// ---- Orderly: every broker account of a wallet from the public get_all_accounts, then the L2 Ledger (chain 291)
// getUserTokenBalance + getUserTotalFrozenBalance for USDC (6 decimals, signed). Ledger from
// orderly.network/docs/build-on-omnichain/addresses, read 2026-10-20. The Orderly RPC (Conduit) rate limits bursts,
// so only USDC is read: two calls per account in one batch.
const ORDERLY_LEDGER = "0x6F7a338F2aA472838dEFD3283eB360d4Dff5D203";
const USDC_HASH = keccak256(toHex("USDC"));
const ledgerAbi = parseAbi(["function getUserTokenBalance(bytes32 accountId, bytes32 tokenHash) view returns (int128)", "function getUserTotalFrozenBalance(bytes32 accountId, bytes32 tokenHash) view returns (uint128)"]);

async function orderly(address, io) {
  const accts = (await io.get("holdings.orderly_accounts", { address }))?.data?.rows || [];
  if (!accts.length) return [];
  const r = await io.multicall("orderly", accts.flatMap((a) => [
    { to: ORDERLY_LEDGER, abi: ledgerAbi, functionName: "getUserTokenBalance", args: [a.account_id, USDC_HASH] },
    { to: ORDERLY_LEDGER, abi: ledgerAbi, functionName: "getUserTotalFrozenBalance", args: [a.account_id, USDC_HASH] },
  ]));
  if (r.some((x) => x == null)) throw { error: "Orderly ledger read failed" };
  const rows = accts.map((a, i) => ({ a, bal: units(r[2 * i], 6), frozen: units(r[2 * i + 1], 6) })).filter((x) => x.bal + x.frozen !== 0);
  if (!rows.length) return [];
  const p = (await io.prices(["coingecko:usd-coin"])).get("coingecko:usd-coin") ?? null;
  return rows.map(({ a, bal, frozen }) => {
    const amount = bal + frozen;
    return {
      protocol: "Orderly", chain: "orderly", asset: "USDC", amount, usd: p == null ? null : amount * p, kind: "deposit", status: "live",
      detail: `Orderly account on broker ${a.broker_id}: ${fmt(amount)} USDC${frozen ? ` (${fmt(frozen)} held for withdrawals or orders)` : ""}; unsettled PnL of open positions not included`,
    };
  }).filter((x) => keep(x.usd));
}

// ---- Variational Omni, Arbitrum: one settlement pool per user (user <> OLP), found through the pool's Deposited
// event (payer indexed, topic 2) over the whole chain, kept when checkOtherAddress(user) and creatorAddress() is the
// OLP vault. Pool USDC also backs OLP margin and the portfolio API needs login, so this is existence only.
// docs.variational.io/technical-documentation/mainnet-contracts, read 2026-10-20.
const VAR_OLP = "0x74bBBb0E7F0bAd6938509Dd4B556a39A4Db1F2Cd";
const ARB_USDC = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const poolAbi = parseAbi(["function checkOtherAddress(address) view returns (bool)", "function creatorAddress() view returns (address)"]);

async function variational(address, io) {
  const logs = (await io.get("holdings.variational_logs", { payer: pad(address.toLowerCase()) }))?.result;
  if (!Array.isArray(logs)) throw { error: "Variational getLogs: no result" };
  const pools = [...new Set(logs.map((l) => l.address.toLowerCase()))].sort();
  if (!pools.length) return [];
  const r = await io.multicall("arbitrum", pools.flatMap((p) => [
    { to: p, abi: poolAbi, functionName: "checkOtherAddress", args: [address] },
    { to: p, abi: poolAbi, functionName: "creatorAddress" },
    { to: ARB_USDC, abi: erc20Abi, functionName: "balanceOf", args: [p] },
  ]));
  return pools.map((p, i) => ({ p, ok: r[3 * i] === true && r[3 * i + 1]?.toLowerCase() === VAR_OLP.toLowerCase(), held: r[3 * i + 2] })).filter((x) => x.ok).map(({ p, held }) => {
    return {
      protocol: "Variational", chain: "arbitrum", asset: "USDC", amount: null, usd: null, kind: "deposit", status: "hint", confidence: "low", deadline: null,
      action: "open Variational Omni with this wallet and check the account balance",
      how_to_claim: "https://omni.variational.io/",
      detail: `Variational Omni account registered (settlement pool ${p})` + (held != null ? `; the pool holds ${fmt(units(held, 6))} USDC incl. OLP margin, an upper bound` : ""),
    };
  });
}

export const EVM = { synfutures, mux, gains, aevo, orderly, variational };
