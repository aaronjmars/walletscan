// compose.mjs - multi-step routes (entry.compose): one call that runs several other routes and returns the joined
// answer. The scan routes live here: they run every source for one wallet in parallel, turn
// each answer into findings (findings.mjs) and return one list.
//
// Each COMPOSE function is async (params, ctx) -> data, where
//   ctx.call(id, params, over?) runs another registry route through the normal path (pacing, timeouts, cache);
//                               resolves { status, ok, data }, throws { status, error, detail } on validation errors.
//                               over.body sends its own body to that route's url (another JSON-RPC method)
//   ctx.live(id)                is that route callable now (keyless, or its key is set)
//   ctx.local(name, params)     a LOCAL dataset lookup (data/*.json)
// Throw { status, error, detail } for a caller error (400) or a failed step (502 + the step's id).
import { readFileSync } from "node:fs";
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";
import { isEvmAddr, isSolAddr, pumpVaults, TOKEN_2022, findPda, seed } from "./solana.mjs";
import * as F from "./findings.mjs";
import { makeIo, readVenues, EVM_VENUES, SOL_VENUES } from "./perps/index.mjs";
import { UNCLAIMED } from "./unclaimed/index.mjs";
import { FORGOTTEN } from "./forgotten/index.mjs";
import { CHAINS as NONEVM_CHAINS, COMPOSE as NONEVM } from "./nonevm/index.mjs";
import { addressKind, unknownAddress, KINDS } from "./nonevm/address.mjs";
import { SKIPPED_ROUTES, SKIPPED_GOPLUS } from "./forgotten/skipped.mjs";
import { COMPOSE as KEYLESS, KEY_NOTES, noteKey } from "./keyless.mjs";
import { byId, missingKeys } from "./registry.mjs";
import { marketQuote, fillMarketGaps, rugcheckRows } from "./market.mjs";
import { walletPositions, walletAssets, mintInformation } from "./pagination.mjs";
import { approvals } from "./approvals.mjs";

const need = (p, ...names) => {
  const miss = names.filter((n) => p[n] == null || p[n] === "");
  if (miss.length) throw { status: 400, error: "missing required param(s)", detail: miss };
};
const step = async (ctx, id, params, over) => {
  const r = await ctx.call(id, params, over);
  if (!r.ok) throw { status: 502, error: `step ${id} failed (upstream ${r.status})`, detail: r.data };
  return r.data;
};
const minUsdOf = (p) => (p.min_usd == null || p.min_usd === "" ? 1 : Math.max(0, Number(p.min_usd) || 0));
const rpc = (method, params = []) => ({ jsonrpc: "2.0", id: 1, method, params });
const timeout = (ms, what) => new Promise((_, no) => setTimeout(() => no({ status: 504, error: `${what} took over ${ms / 1000}s` }), ms).unref());

// One scan run: sources run in parallel, each with its own time limit; a failed or unconfigured source is named in
// `sources` and the rest still answer. A source = { id, run: async (...after) => ({ findings?, holdings? }), ms?, after? }
// after = ids of sources listed before it: run gets their answers (null when skipped or failed) and its clock starts then;
// a run that had nothing to do returns { status } (e.g. a fallback whose main source answered).
// live = optional check that replaces ctx.live(id); notes = parts skipped for a missing key (keyless.mjs noteKey)
async function runSources(ctx, list, skip) {
  const sources = {}, findings = [], holdings = [], runs = new Map(), notes = [], coverage = {};
  for (const s of list) runs.set(s.id, (async () => {
    if (skip.has(s.id)) { sources[s.id] = "skipped"; return null; }
    if (!(s.live ? s.live() : ctx.live(s.id))) { sources[s.id] = "not configured"; return null; }
    const before = await Promise.all((s.after || []).map((id) => runs.get(id) ?? null));
    try {
      const out = await Promise.race([KEY_NOTES.run({ id: s.id, list: notes }, () => s.run(...before)), timeout(s.ms || 45000, s.id)]);
      findings.push(...(out?.findings || []));
      holdings.push(...(out?.holdings || []));
      sources[s.id] = out?.status || "ok";
      if (out?.coverage) coverage[s.id] = { ...out.coverage, ...(String(sources[s.id]).startsWith("error:") && { status: "failed" }) };
      return out;
    } catch (e) {
      sources[s.id] = `error: ${String((e && (e.error || e.message)) || e).slice(0, 160)}`;
      return null;
    }
  })());
  await Promise.all(runs.values());
  return { sources, findings, holdings, notes, coverage };
}

// sources not run for a missing key, and parts of the others skipped for one: [{ id, key, why }] (what a key adds)
function skippedForKeys(run) {
  const out = Object.entries(run.sources).filter(([, v]) => v === "not configured").flatMap(([id]) => {
    const e = byId(id);
    return missingKeys(e).map((key) => ({ id, key, why: e?.keyWhy || `${id} runs only with ${key}` }));
  });
  for (const n of run.notes || []) if (!out.some((x) => x.id === n.id && x.key === n.key && x.why === n.why)) out.push(n);
  return out;
}

// GoPlus on the tokens a scan is least sure of (unverified holdings, Zerion rewards, and findings in any token a
// contract holds for the wallet: locks, vesting plans, pool shares, LP fees, zkEVM exits), biggest first: the free tier
// answers one token per call at ~1/s, so only the top few are asked; each verdict lands on its row as it arrives, so a
// time-out keeps the ones already in
const GOPLUS_MAX = 8;
const GOPLUS_FINDINGS = new Set(["rewards.token_locks", "rewards.hedgey", "rewards.superfluid", "rewards.uniswap_fees", "bridge.polygon_zkevm", "rewards.pons"]);
for (const id of SKIPPED_GOPLUS) GOPLUS_FINDINGS.add(id); // PinkLock / HoodLock locked tokens (forgotten/skipped.mjs)
const ZERION_CHAIN_IDS = JSON.parse(readFileSync(new URL("./chains/zerion-chains.json", import.meta.url), "utf8"));
// static guide on every scan: per-app embedded wallets no API can find, with where the user lists them
export const MORE_WALLETS = JSON.parse(readFileSync(new URL("./data/more-wallets.json", import.meta.url), "utf8"));
const CHAIN_IDS = Object.fromEntries(Object.entries(F.EVM_CHAINS).map(([id, name]) => [name, id])); // our chain names (bsc, worldchain...)
async function goplusCheck(ctx, outs, { solana = false, minUsd = 1, marketOnly = false } = {}) {
  const rows = outs.flatMap((o) => [...(o?.holdings || []), ...(o?.findings || [])]).filter((r) => (!marketOnly || ["dexscreener", "geckoterminal"].includes(r.price_from)) && (r.category ? (marketOnly ? r.confidence !== "low" : r.source === "rewards.zerion" ? r.confidence === "medium" : GOPLUS_FINDINGS.has(r.source) && r.confidence !== "low") : !r.verified) && (r.usd ?? 0) >= minUsd);
  const keyOf = (r) => (solana ? r.mint : r.token && `${r.chain_id ?? ZERION_CHAIN_IDS[r.chain] ?? CHAIN_IDS[r.chain] ?? ""}:${r.token}`);
  const byKey = new Map();
  for (const r of rows.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))) {
    const k = keyOf(r);
    if (!k || (!solana && k.startsWith(":"))) continue;
    if (!byKey.has(k) && byKey.size >= GOPLUS_MAX) continue;
    byKey.set(k, [...(byKey.get(k) || []), r]);
  }
  let checked = 0;
  await Promise.all([...byKey].map(async ([k, list]) => {
    const [chainId, addr] = solana ? [null, k] : k.split(":");
    const r = await ctx.call(solana ? "token.goplus_sol" : "token.goplus_evm", solana ? { addresses: addr } : { chain_id: chainId, addresses: addr }).catch(() => null);
    const res = r?.ok ? r.data?.result : null;
    const row = res && (res[addr] ?? res[addr.toLowerCase()] ?? Object.values(res)[0]);
    if (!row) return;
    checked++;
    for (const x of list) F.applyGoplus(x, F.goplusVerdict(row, { solana }));
  }));
  return { checked, asked: byKey.size, candidates: new Set(rows.map(keyOf).filter(Boolean)).size, unchecked: Math.max(0, new Set(rows.map(keyOf).filter(Boolean)).size - checked) };
}

// prices and gas for the claim-cost estimate; missing values only blank net_after_fees_usd
async function feeEnv(ctx, withGas) {
  const env = {};
  const [px, gas] = await Promise.all([
    ctx.call("token.prices", { coins: "coingecko:ethereum,coingecko:solana" }).catch(() => null),
    withGas ? ctx.call("evm.rpc", {}, { body: rpc("eth_gasPrice") }).catch(() => null) : null,
  ]);
  env.ethUsd = px?.data?.coins?.["coingecko:ethereum"]?.price ?? null;
  env.solUsd = px?.data?.coins?.["coingecko:solana"]?.price ?? null;
  env.gasPriceWei = gas?.data?.result ? Number(BigInt(gas.data.result)) : null;
  return env;
}

const ok = (r) => r.ok || (r.status === 404 && r.data?.code === 4040); // LayerZero: 404 code 4040 = no messages
async function get(ctx, id, params) {
  const r = await ctx.call(id, params);
  if (!ok(r)) throw { error: `upstream ${r.status}: ${JSON.stringify(r.data).slice(0, 120)}` };
  return r.data;
}

// sol.assets' answer (DAS shape, the parts solHoldings reads) from public RPC reads: token accounts + SOL balance;
// prices come from Jupiter (all of them: no Helius price), symbols too
async function keylessAssets(ctx, owner, env) {
  noteKey("HELIUS_API_KEY", byId("sol.assets").keyWhy);
  const [a, b, acc] = await Promise.all([
    get(ctx, "sol.token_accounts", { owner }),
    get(ctx, "sol.token_accounts", { owner, program_id: TOKEN_2022 }),
    get(ctx, "sol.accounts", { pubkeys: owner }),
  ]);
  const byMint = new Map();
  for (const t of [...(a?.result?.value || []), ...(b?.result?.value || [])]) {
    const info = t.account?.data?.parsed?.info, amt = info?.tokenAmount;
    if (!info?.mint || !(BigInt(amt?.amount || 0) > 0n)) continue;
    const prev = byMint.get(info.mint);
    byMint.set(info.mint, { id: info.mint, interface: "FungibleToken", token_info: { balance: String(BigInt(prev?.token_info.balance || 0) + BigInt(amt.amount)), decimals: amt.decimals } });
  }
  const lamports = acc?.result?.value?.[0]?.lamports ?? 0;
  return { result: { items: [...byMint.values()], nativeBalance: { lamports, total_price: env.solUsd != null ? (lamports / 1e9) * env.solUsd : null } } };
}

// burn addresses: tokens sent there are gone, a scan would list millions no one can claim
const BURN = new Set(["0x0000000000000000000000000000000000000000", "0x000000000000000000000000000000000000dead", "0xdead000000000000000042069420694206942069"]);

function finish({ address, kind, env, minUsd, run, extra = {} }) {
  const findings = F.dropReaderTwins(run.findings).map((f) => F.withNet(f, env));
  // GoPlus spam is dropped from holdings (counted in spam_hidden); duplicate rows of the same money are merged
  const holdings = F.dedupeHoldings(run.holdings.filter((h) => !h.spam)).map(F.saneHolding);
  const out = F.summarize(findings, holdings, { minUsd });
  // a failed source = money not checked, so the totals may be low: said next to them (GoPlus only checks tokens)
  const failed = Object.entries(run.sources).filter(([, v]) => String(v).startsWith("error:")).map(([id, v]) => ({ id, reason: String(v).slice(7) }));
  const coverage = Object.fromEntries(Object.entries(run.sources).map(([id, status]) => [id, run.coverage?.[id] || { status: String(status).startsWith("error:") ? "failed" : status === "not configured" ? "not_configured" : String(status).startsWith("skipped") ? "skipped" : "complete" }]));
  for (const n of run.notes || []) if (coverage[n.id]?.status === "complete") coverage[n.id] = { status: "not_configured", reason: "parts of this source require a missing key" };
  const truncated = Object.entries(coverage).filter(([id, c]) => c.status === "truncated" && !id.startsWith("token.") && !id.startsWith("security.")).map(([id, c]) => ({ id, ...c }));
  const partial = failed.some((f) => !f.id.startsWith("token.") && !f.id.startsWith("security.")) || truncated.length > 0;
  out.totals.partial = partial;
  return {
    address, kind, partial, coverage, truncated_sources: truncated, failed_sources: failed, skipped_for_keys: skippedForKeys(run), ...(partial && { warning: [failed.length && `${failed.length} source${failed.length > 1 ? "s" : ""} failed (${failed.map((f) => f.id).join(", ")})`, truncated.length && `${truncated.length} source${truncated.length > 1 ? "s" : ""} stopped early (${truncated.map((f) => f.id).join(", ")})`, "the totals may be missing money there; retry later"].filter(Boolean).join(": ") }), ...out, spam_hidden: run.holdings.filter((h) => h.spam).length, holdings: holdings.sort((a, b) => Number(b.verified) - Number(a.verified) || (b.usd ?? 0) - (a.usd ?? 0)), sources: run.sources, ...extra,
    more_wallets: MORE_WALLETS,
    prices: { eth_usd: env.ethUsd, sol_usd: env.solUsd, gas_gwei: env.gasPriceWei ? Math.round(env.gasPriceWei / 1e7) / 100 : null },
    note: "read-only: nothing here signs or sends anything. usd = upstream or DefiLlama prices; net_after_fees_usd = usd minus an estimated claim cost; low confidence findings are hints and stay out of the totals",
  };
}

// ---- non-EVM chains (nonevm/): one scan per chain, its source routes run like scan.evm's, same answer shape -----
// address kinds a scan takes now: EVM, Solana and every nonevm/ chain with sources
export const SCANNED_KINDS = ["evm", "solana", ...Object.keys(NONEVM_CHAINS)];
const KIND_NAMES = { evm: "EVM", solana: "Solana", bitcoin: "Bitcoin", tron: "TRON", near: "NEAR", sui: "Sui", polkadot: "Polkadot / Kusama", ton: "TON" };
const scannedNames = () => SCANNED_KINDS.map((k) => KIND_NAMES[k] || k);
function notScanned(raw, k) {
  if (k) return { status: 400, error: `${k.kind} addresses are not scanned yet`, detail: { address: String(raw).trim().slice(0, 64), supported: SCANNED_KINDS.map((x) => KINDS[x]) } };
  const e = unknownAddress(raw);
  return e.detail?.supported ? { ...e, detail: { ...e.detail, supported: SCANNED_KINDS.map((x) => KINDS[x]) } } : e;
}
async function scanChain(spec, p, ctx) {
  need(p, "address");
  const k = addressKind(p.address);
  if (!k || k.kind !== spec.kind) throw { status: 400, error: `address must be a ${spec.label || spec.kind} address (scan.all takes any kind)`, detail: String(p.address).slice(0, 64) };
  const address = k.address, minUsd = minUsdOf(p), skip = new Set(String(p.skip || "").split(",").map((s) => s.trim()).filter(Boolean));
  const run = await runSources(ctx, spec.sources.map((id) => ({
    id, ms: spec.ms?.[id], run: async () => {
      const d = await get(ctx, id, { address });
      // priced token dust under min_usd is dropped; staked and locked positions always show
      const holdings = (d?.holdings || []).filter((h) => h.usd == null || h.usd >= minUsd || h.kind !== "token").map((h) => ({ ...h, source: id }));
      const errors = (d?.errors || []).map((e) => (typeof e === "string" ? e : e?.error || JSON.stringify(e)));
      // a source with nothing to do for this address says so in its status (e.g. "skipped: ...")
      return { findings: F.hfClaims(d, { source: id, minUsd }), holdings, ...(typeof d?.status === "string" && { status: d.status }), ...(errors.length && { status: `error: ${errors.join("; ")}` }) };
    },
  })), skip);
  return finish({ address, kind: spec.kind, env: {}, minUsd, run, extra: { chains: spec.chains, ...(k.friendly && { friendly: k.friendly }), ...(k.account && { account: k.account }) } });
}

// ---- Lido withdrawal queue ------------------------------------------------------------------------------------
const LIDO_WQ = "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1";
const lidoAbi = parseAbi([
  "function getWithdrawalRequests(address _owner) view returns (uint256[] requestsIds)",
  "function getWithdrawalStatus(uint256[] _requestIds) view returns ((uint256 amountOfStETH, uint256 amountOfShares, address owner, uint256 timestamp, bool isFinalized, bool isClaimed)[] statuses)",
]);
async function ethCall(ctx, to, data, chain) {
  const r = await step(ctx, "evm.rpc", chain ? { chain } : {}, { body: rpc("eth_call", [{ to, data }, "latest"]) });
  if (r.error) throw { status: 502, error: "eth_call failed", detail: r.error };
  return r.result;
}

// ---- EigenLayer queued withdrawals on Ethereum -----------------------------------------------------------------
// each strategy holds one token: beacon chain ETH (native restaking) or an ERC-20 (stETH, EIGEN...); its shares turn
// into that token with sharesToUnderlyingView. The EIGEN strategy holds bEIGEN, which unwraps 1:1 to EIGEN
const EIGEN_DM = "0x39053D51B77DC0d36036Fc1fCc8Cb819df8Ef37A";
const EIGEN_BEACON = "0xbeac0eeeeeeeeeeeeeeeeeeeeeeeeeeeeeebeac0";
const EIGEN_PRICE_AS = { "0x83e9115d334d248ce39a6f36144aeab5b3456e75": "ethereum:0xec53bf9167f50cdeb3ae105f56099aaab9061f83" }; // bEIGEN -> EIGEN
const eigenAbi = parseAbi([
  "struct Withdrawal { address staker; address delegatedTo; address withdrawer; uint256 nonce; uint32 startBlock; address[] strategies; uint256[] scaledShares; }",
  "function getQueuedWithdrawals(address staker) view returns (Withdrawal[], uint256[][])",
  "function minWithdrawalDelayBlocks() view returns (uint256)",
  "function underlyingToken() view returns (address)",
  "function sharesToUnderlyingView(uint256 amountShares) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);
const eigenRead = async (ctx, to, fn, args = []) => decodeFunctionResult({ abi: eigenAbi, functionName: fn, data: await ethCall(ctx, to, encodeFunctionData({ abi: eigenAbi, functionName: fn, args })) });

// ---- Kwenta Smart Margin on Optimism --------------------------------------------------------------------------
const KWENTA_FACTORY = "0x8234F990b149Ae59416dc260305E565e5DAfEb54";
const OP_SUSD = "0x8c6f28f2F1A3C87F0f938b96d27520d9751ec8d9";
const kwentaAbi = parseAbi([
  "function getAccountsOwnedBy(address owner) view returns (address[])",
  "function balanceOf(address account) view returns (uint256)",
]);

// ---- GMX v2: gmxapi.io hosts (one per chain, same paths)
const GMX_CHAINS = ["arbitrum", "avalanche", "megaeth"];

// ---- old claims that never expire: one view call each on Ethereum (contracts from rotki's decoders, read 2026-10-15)
const ZERO = "0x0000000000000000000000000000000000000000";
const legacyAbi = parseAbi([
  "function isClaimed(uint256 index) view returns (bool)",
  "function getCollateral(address account) view returns (uint256)",
  "function claim(address addr) returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function weiPerNanoDGD() view returns (uint256)",
  "function getETHBalance(address account) view returns (uint256)",
  "function proxies(address) view returns (address)",
]);
const LEGACY = {
  zksyncLite: "0x0a14B696350546110a0D8acDb86226983af9D2a0", // ZKsync Lite exit claims (isClaimed per claimIndex)
  liquitySurplus: "0x3D32e8b97Ed5881324241Cf03b2DA5E2EBcE5521", // Liquity v1 CollSurplusPool: ETH left after a redemption or liquidation
  liquityOps: "0x24179CD81c9e782A4096035f7eC97fB8B783e007", // BorrowerOperations.claimCollateral()
  curveFees: [["3CRV", "0xA464e6DCda8AC41e03616F95f4BC98a13b8922Dc", "ethereum:0x6c3f90f043a72fa612cbac8115ee7e52bde6e490"], ["crvUSD", "0xD16d5eC345Dd86Fb63C6a9C43c517210F1027914", "ethereum:0xf939e0a03fb07f59a73314e73794be0e57ac1b4e"]],
  gnt: "0xa74476443119A942dE498590Fe1f2454d7D4aC0d", // GNT.migrate(value) -> GLM 1:1
  dgd: "0xE0B7927c4aF23765Cb51314A0E0521A9645F0E2A", dgdRefund: "0x23Ea10CC1e6EBdB499D24E45369A35f43627062f", // DGD -> ETH, approve + burn()
  dao: "0xBB9bc244D798123fDe783fCc1C72d3Bb8C189413", daoRefund: "0xbf4ed7b27f1d666546e30d74d50d173d20bca754", // The DAO -> ETH (100:1 via WithdrawDAO)
  splits: "0x2ed6c4B5dA6378c7897AC67Ba9e43102Feb694EE", // 0xSplits SplitMain on Ethereum + Base
  zoraRewards: "0x7777777F279eba3d3Ad8F4E708545291A6fDBA8B", // Zora ProtocolRewards on Base
  kncl: "0xdd974D5C2e2928deA5F71b9825b8b646686BD200", kncSwap: "0xdeFA4e8a7bcBA345F687a2f1456F5Edd9CE97202", // KNCL -> KNC (mintWithOldKnc)
  rplV1: "0xb4efd85c19999d84251304bda99e90b92300bd93", rplSwap: "0xD33526068D116cE69F19A9ee46F0bd304F21A51f", // RPL v1 -> RPL (swapTokens)
  dsproxyRegistry: "0x4678f0a6958e4D2Bc4F1BAF7Bc52E8F3564f3fE4", // DSProxy registry on Ethereum
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
};
const call = async (ctx, to, fn, args = [], chain) => decodeFunctionResult({ abi: legacyAbi, functionName: fn, data: await ethCall(ctx, to, encodeFunctionData({ abi: legacyAbi, functionName: fn, args }), chain) });
const etherscanWrite = (a) => `https://etherscan.io/address/${a}#writeContract`;

// ---- Venice staking on Base (sVVV): rewards, unstake cooldown, DIEM minted against locked sVVV (read 2026-10-16)
const VENICE = { staking: "0x321b7ff75154472b18edb199033ff4d116f340ff", vvv: "base:0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf", diem: "base:0xf4d97f2da56e8c3098f3a8d538db630a2606a024" };
const veniceAbi = parseAbi([
  "function lockedStakes(address) view returns (uint256 sVVVLockedAmount, uint256 outstandingDiemAmount)",
  "function pendingRewards(address _user) view returns (uint256)",
  "function stakes(address) view returns (uint256 rewardDebt, uint256 cooldownEnd, uint256 cooldownAmount)",
]);

// ---- Blast apps while the chain closes (data/sunset-chains.json "blast"): Thruster v3 LP NFTs, Orbit Lending
// (Compound v2 fork) and Pac Finance (Aave v3 fork) deposits. Their market lists are fixed (the apps stopped), read
// onchain 2026-10-20
const BLAST = {
  sunset: JSON.parse(readFileSync(new URL("./data/sunset-chains.json", import.meta.url), "utf8")).find((c) => c.id === "blast"),
  thrusterNpm: "0x434575EaEa081b735C985FA9bf63CD7b87e227F9", thrusterFactory: "0x71b08f13B3c3aF35aAdEb3949AFEb1ded1016127",
  // Orbit: [market, asset, underlying (null = ETH), decimals]
  orbit: [
    ["0xF92996dDC677a8Dcb032Ac5Fe62bBf00f92aE2Ec", "ETH", null, 18], ["0xF9B3B455f5d900f62bC1792A6Ca6e1d47B989389", "ETH", null, 18],
    ["0x0872b71EFC37CB8DdE22B2118De3d800427fdba0", "ETH", null, 18], ["0x9aECEdCD6A82d26F2f86D331B17a1C1676442A87", "USDB", "0x4300000000000000000000000000000000000003", 18],
    ["0x8C415331761063E5D6b1c8E700f996b13603Fc2E", "WBTC", "0xf7bc58b8d8f97adc129cfc4c9f45ce3c0e1d2692", 8],
  ],
  pacPool: "0xd2499b3c8611E36ca89A70Fda2A72C49eE19eAa8",
  // Pac: [asset, underlying, decimals, aToken, variable debt token]
  pac: [
    ["WETH", "0x4300000000000000000000000000000000000004", 18, "0x63749b03bdb4e86e5aaf7e5a723bf993dbf0c1c5", "0x7cb8a894b163848bccee03fd71b098693ee7a77d"],
    ["USDB", "0x4300000000000000000000000000000000000003", 18, "0xc7206216f28c23b2da6537d296e789cfb81b31ef", "0x325261d7bd4bda7baf38d08217793e94b19c8fc7"],
    ["fwWETH", "0x66714db8f3397c767d0a602458b5b4e3c0fe7dd1", 18, "0x2b8476064d5a6ee4821c6dbbc4f0221b1dc9cbed", "0xbcdeae2cf126d474e7362f2b8953787ba5dc0c46"],
    ["fwUSDB", "0x866f2c06b83df2ed7ca9c2d044940e7cd55a06d6", 18, "0xeebde4c9249e290dd463e22df1d3f2aba711a576", "0x0919d45b90b9342a7ea2599e1f3b6e2439848cf9"],
    ["RING-V2", "0x9be8a40c9cf00fe33fd84eaedaa5c4fe3f04cbc3", 18, "0xc57b31204b1dfd80ad4d58f2d571aa05fd98dfd9", "0x05bc646e0a77f2dc00cd0bbe3e99638d46c7f0b0"],
    ["oETH", "0x0872b71efc37cb8dde22b2118de3d800427fdba0", 18, "0x68915399201380f392019555947491e5b3edfa0e", "0xa42d362e5b40acd0acf622185b658828bc58c34e"],
    ["oUSDB", "0x9aecedcd6a82d26f2f86d331b17a1c1676442a87", 18, "0xce7c5a6a86206b68a746615c1f6b473edb6470b3", "0xd6bc56e862dad1b07db267884a8f2974789d1538"],
    ["ezETH", "0x2416092f143378750bb29b79ed961ab195cceea5", 18, "0x01bfae5e4fdfcfb514b65b8ed4f515327bbe994d", "0x60faaa431db080aa16e7699fea6ebbc563714e06"],
    ["SLP-USDB", "0x56e0f6df03883611c9762e78d4091e39ad9c420e", 18, "0xfaf2effa654aca37f45d1dbe1b88f3fb0dd1e41f", "0x75afbb2f98bc962cebb3991f035c800b69a723be"],
    ["SLP-WETH", "0x3d4621fa5ff784dfb2fcdfd5b293224167f239db", 18, "0x5cc3094909fa8edf7a18351c8b5a2b9d1467df01", "0xd4b4f875b1b5a71eafcbe17109bb01ec5c283834"],
    ["T-LP", "0x12c69bfa3fb3cba75a1defa6e976b87e233fc7df", 18, "0xf60eb659169a49d4cb21381bdbbeb13abb6df527", "0xb131623530d1e262c45504089be63b6644ae9374"],
    ["WBTC", "0xf7bc58b8d8f97adc129cfc4c9f45ce3c0e1d2692", 8, "0x427d0e5493a1ec15d8f9777b7e2c33b9e4c50e57", "0xcc316e6ad7a65bb882b37104ba2f002230454654"],
    ["wrsETH", "0xe7903b1f75c534dd8159b313d92cdcfbc62cb3cd", 18, "0xf5f8be345234487f6f574e821547342656aab417", "0xf5764deabc3eccbe25afe2ca83c034949a8a2912"],
    ["DETH", "0x1da40c742f32bbee81694051c0ee07485fc630f6", 18, "0x97257a7c033773d54dfe83bfcdce056af8321ae2", "0x109195c9a8dd285b549f8963bcf80eaae370927f"],
    ["DUSD", "0x1a3d9b2fa5c6522c8c071dc07125ce55df90b253", 18, "0x3b51c9b48bdf91c7267b63ec663e64e9580e7bdf", "0xf967757e4a0bc2bbe798f95fdb9049dab12b6913"],
  ],
};
const blastAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function getAccountSnapshot(address account) view returns (uint256 err, uint256 cTokenBalance, uint256 borrowBalance, uint256 exchangeRateMantissa)",
  "function getCash() view returns (uint256)",
]);
const blastWrite = (a) => `https://blastscan.io/address/${a}#writeContract`;
// view calls on Blast as JSON-RPC batches (one request per 50 calls): [to, fn, args] -> decoded result, null on a revert
async function blastReads(ctx, calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += 50) {
    const part = calls.slice(i, i + 50);
    const r = await step(ctx, "evm.rpc", { chain: "blast" }, { body: part.map(([to, fn, args = []], id) => ({ ...rpc("eth_call", [{ to, data: encodeFunctionData({ abi: blastAbi, functionName: fn, args }) }, "latest"]), id })) });
    if (!Array.isArray(r)) throw { status: 502, error: "Blast RPC batch failed", detail: r };
    const byId = new Map(r.map((x) => [x.id, x.result]));
    for (const [id, [, fn]] of part.entries()) {
      const hex = byId.get(id);
      try { out.push(hex && hex !== "0x" ? decodeFunctionResult({ abi: blastAbi, functionName: fn, data: hex }) : null); } catch { out.push(null); }
    }
  }
  return out;
}

// ---- Parcl PRCL airdrops on Solana: 7 MerkleDistributor accounts of one program (Jupiter's merkle distributor),
// read 2026-10-20. Parcl's claim APIs give the allocation; the ClaimStatus PDA says what was claimed and withdrawn
const PARCL = {
  program: "5tu3xkmLfud5BAwSuQke4WSjoHcQ52SbrPwX9es8j6Ve", mint: "4LLbsb5ReP3yEtYzmXewyGjcir5uXtKFURtaEUVC2AHs", claim: "https://claims.parcllimited.com",
  // [key, name, airdrop.parcl_gnome season (null = airdrop.parcl_s3), distributor, token vault]
  seasons: [
    ["initial", "Parcl PRCL airdrop", "", "6FpAQJiPNssfLMuVYurBvbv9pvzKmnrffetHkvwysVvK", "7KQKjuFb2jVBnoX73UdBq515DVHD4ZJVuSLWFV84npK"],
    ["s1_1", "Parcl Points S1 (schedule 1)", "-ppp-s1-schedule-1", "3pXjo8MnhYkDWGbxUCMWUHHfR5RaTHBGkB7A9YaLcPoE", "48g9SAGy9wkdk2ooXhpm4TfzfNjdYRMHeUKBX4H5wQyN"],
    ["s1_2", "Parcl Points S1 (schedule 2)", "-ppp-s1-schedule-2", "GDndgDm5HYeWJiHXGMdMBwfKsnTfkpGBKf9F3Z61tJeD", "D22GPQZAFd7B6S6cq6r1U42XJ43VL7SLFzbdD6xJrsEw"],
    ["s1_3", "Parcl Points S1 (schedule 3)", "-ppp-s1-schedule-3", "BdCPydazxftHgdr9Re8r8BHtycdqgk4UeTHojJFpvxMd", "6hHwiYM66yhkrzPAmwVHDvhcdhE99pt2ygYVPPhyXfYs"],
    ["s2", "Parcl Points S2", "-ppp-s2", "FydiLKeKwCFh4oJ7Fvgcn6oSDmr84H6e6vZ5KMYR2V8C", "43VCtdwkNVVj7CJLUuqS2B4E7f58HRREiSHbZNQCbMTm"],
    ["hoa", "Parcl HOA", "-hoa", "uUMmZhPVp5DzcKuEHN9vfjUfLU72csAbBtvfXqQTfwi", "HQQfGJCyUtwgAJKFGDuBHsYGpp5wQREVGkvQPJeNTxP9"],
    ["s3", "Parcl Points S3", null, "AkMAwycdPh3xe1okbkwqAFmpFvuHFXnuM5Ptx2186pwF", "6z321QDL5qY5JNnQoruUSBh493p2QqYyAXm9Btg9EvYr"],
  ],
};

// ---- Pendle: DefiLlama chain keys for Pendle's chains, to price merkle reward tokens
const LLAMA_KEY = { 1: "ethereum", 10: "optimism", 56: "bsc", 146: "sonic", 999: "hyperliquid", 5000: "mantle", 8453: "base", 9745: "plasma", 42161: "arbitrum", 80094: "berachain" };

// ---- the routes ----------------------------------------------------------------------------------------------
export const COMPOSE = {
  marketQuote, approvals,
  ...KEYLESS, // keyless stand-ins (keyless.mjs): evm.keyless_rpc, evm.keyless_nfts, evm.keyless_tokens
  ...FORGOTTEN, // forgotten-money sources (forgotten/): LRT queues, dead farms, old token swaps, locks, Solana leftovers...
  ...NONEVM, // non-EVM chain sources (nonevm/): Omni USDT, Babylon, TRON staking, NEAR pools, Polkadot unbonding...
  ...Object.fromEntries(Object.values(NONEVM_CHAINS).map((spec) => [spec.compose, (p, ctx) => scanChain(spec, p, ctx)])),
  async lidoWithdrawals(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const idsHex = await ethCall(ctx, LIDO_WQ, encodeFunctionData({ abi: lidoAbi, functionName: "getWithdrawalRequests", args: [p.address] }));
    const ids = decodeFunctionResult({ abi: lidoAbi, functionName: "getWithdrawalRequests", data: idsHex });
    if (!ids.length) return { requests: [], claimable_eth: 0 };
    const stHex = await ethCall(ctx, LIDO_WQ, encodeFunctionData({ abi: lidoAbi, functionName: "getWithdrawalStatus", args: [ids] }));
    const st = decodeFunctionResult({ abi: lidoAbi, functionName: "getWithdrawalStatus", data: stHex });
    const requests = st.map((s, i) => ({ id: ids[i].toString(), amount_steth: Number(s.amountOfStETH) / 1e18, finalized: s.isFinalized, claimed: s.isClaimed, created: new Date(Number(s.timestamp) * 1000).toISOString() }));
    return { requests, claimable_eth: requests.filter((r) => r.finalized && !r.claimed).reduce((t, r) => t + r.amount_steth, 0) };
  },
  ...UNCLAIMED, // unclaimed/: Polygon zkEVM exits, Hedgey, Flaunch, Uniswap fees, Superfluid, token locks

  async eigenlayerWithdrawals(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const [wRaw, delayRaw, blkRes] = await Promise.all([
      ethCall(ctx, EIGEN_DM, encodeFunctionData({ abi: eigenAbi, functionName: "getQueuedWithdrawals", args: [p.address] })),
      ethCall(ctx, EIGEN_DM, encodeFunctionData({ abi: eigenAbi, functionName: "minWithdrawalDelayBlocks", args: [] })).catch(() => null),
      step(ctx, "evm.rpc", {}, { body: rpc("eth_blockNumber", []) }).catch(() => null),
    ]);
    // second return value = the shares each withdrawal still pays after slashing (the struct holds the scaled ones)
    const [wList, wShares] = decodeFunctionResult({ abi: eigenAbi, functionName: "getQueuedWithdrawals", data: wRaw }) || [[], []];
    if (!wList?.length) return { withdrawals: [], delay_blocks: null };
    const delay = delayRaw ? Number(decodeFunctionResult({ abi: eigenAbi, functionName: "minWithdrawalDelayBlocks", data: delayRaw })) : 100800;
    const curBlock = blkRes?.result ? parseInt(blkRes.result, 16) : 0;
    // strategy -> { token, symbol, decimals }; a strategy that cannot be read keeps token null (amount unknown)
    const strategies = [...new Set(wList.flatMap((w) => w.strategies.map((s) => s.toLowerCase())))];
    const meta = new Map(await Promise.all(strategies.map(async (s) => {
      if (s === EIGEN_BEACON) return [s, { token: null, symbol: "ETH", decimals: 18 }];
      try {
        const token = (await eigenRead(ctx, s, "underlyingToken")).toLowerCase();
        const [symbol, decimals] = await Promise.all([eigenRead(ctx, token, "symbol").catch(() => null), eigenRead(ctx, token, "decimals")]);
        return [s, { token, symbol: EIGEN_PRICE_AS[token] ? "EIGEN" : symbol || token, decimals: Number(decimals) }];
      } catch { return [s, null]; }
    })));
    const withdrawals = await Promise.all(wList.map(async (w, i) => {
      const target = Number(w.startBlock) + delay;
      const ready = curBlock > 0 && curBlock > target; // completable once block.number > startBlock + delay
      const left = ready ? 0 : Math.max(0, target - curBlock + 1);
      const assets = await Promise.all(w.strategies.map(async (s, j) => {
        const sl = s.toLowerCase(), m = meta.get(sl), shares = wShares?.[i]?.[j] ?? w.scaledShares[j];
        if (!m) return { strategy: sl, token: null, symbol: null, amount: null, usd: null };
        const raw = sl === EIGEN_BEACON ? shares : await eigenRead(ctx, sl, "sharesToUnderlyingView", [shares]).catch(() => null);
        return { strategy: sl, token: m.token, symbol: m.symbol, amount: raw == null ? null : Number(raw) / 10 ** m.decimals, usd: null };
      }));
      return { nonce: w.nonce.toString(), start_block: Number(w.startBlock), ready, blocks_remaining: left, approx_hours_remaining: left > 0 ? Math.round((left * 12) / 3600) : 0, assets };
    }));
    // DefiLlama prices; a thin market (confidence under 0.9) is no price
    const keyOf = (t) => (t ? EIGEN_PRICE_AS[t] || `ethereum:${t}` : "coingecko:ethereum");
    const all = withdrawals.flatMap((w) => w.assets).filter((a) => a.amount != null);
    const keys = [...new Set(all.map((a) => keyOf(a.token)))];
    const px = keys.length ? await ctx.call("token.prices", { coins: keys.join(",") }).catch(() => null) : null;
    for (const a of all) {
      const c = px?.data?.coins?.[keyOf(a.token)];
      a.usd = c?.price != null && (c.confidence ?? 1) >= 0.9 ? a.amount * c.price : null;
    }
    return { withdrawals, delay_blocks: delay };
  },

  async kwentaPositions(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const accHex = await ethCall(ctx, KWENTA_FACTORY, encodeFunctionData({ abi: kwentaAbi, functionName: "getAccountsOwnedBy", args: [p.address] }), "optimism").catch(() => null);
    if (!accHex) return { accounts: [], total_usd: 0 };
    const accounts = decodeFunctionResult({ abi: kwentaAbi, functionName: "getAccountsOwnedBy", data: accHex });
    if (!accounts?.length) return { accounts: [], total_usd: 0 };
    const items = [];
    let total = 0;
    await Promise.all(accounts.map(async (acc) => {
      const balHex = await ethCall(ctx, OP_SUSD, encodeFunctionData({ abi: kwentaAbi, functionName: "balanceOf", args: [acc] }), "optimism").catch(() => null);
      if (!balHex) return;
      const bal = decodeFunctionResult({ abi: kwentaAbi, functionName: "balanceOf", data: balHex });
      const susd = Number(bal) / 1e18;
      if (susd >= 0.1) {
        total += susd;
        items.push({ account: acc, susd, usd: susd });
      }
    }));
    return { accounts: items, total_usd: total };
  },

  async perpsPositions(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const a = p.address;
    const venues = readVenues(a, makeIo(ctx), EVM_VENUES); // perps/: every other EVM venue, in parallel with the reads below
    const gmx = (chain) => Promise.all([
      ctx.call("holdings.gmx_positions", { chain, address: a }).then((r) => (r.ok && Array.isArray(r.data) ? r.data : [])),
      ctx.call("holdings.gmx_markets", { chain }).then((r) => (r.ok && Array.isArray(r.data) ? r.data : [])).catch(() => []),
    ]).then(([pos, markets]) => ({ chain, pos, markets })).catch(() => ({ chain, pos: [], markets: [] }));
    const [lighter, kwenta, ...gmxChains] = await Promise.all([
      ctx.call("holdings.lighter", { address: a }).then((r) => r.ok ? r.data : null).catch(() => null),
      step(ctx, "holdings.kwenta", { address: a }).catch(() => null),
      ...GMX_CHAINS.map(gmx),
    ]);
    const items = [];
    // gmxapi.io sends USD amounts as integer strings scaled by 1e30; marketSymbol is null, the market list names it
    const usd30 = (v) => { try { return Number(BigInt(v || 0) / 10n ** 24n) / 1e6; } catch { return 0; } };
    for (const { chain, pos, markets } of gmxChains) {
      const names = new Map(markets.map((m) => [String(m.marketTokenAddress).toLowerCase(), m.symbol]));
      for (const x of pos) {
        const size = usd30(x.sizeInUsd), net = usd30(x.netValue), name = names.get(String(x.marketAddress).toLowerCase()) || "GMX market";
        if (!(net > 0)) continue;
        items.push({
          protocol: "GMX", chain, asset: name, amount: net, usd: net, kind: "position",
          detail: `${x.isLong ? "long" : "short"} ${name}, size $${Math.round(size)}; net value = collateral + PnL - fees, what closing it returns`,
        });
      }
    }
    for (const sub of lighter?.sub_accounts || []) {
      const col = Number(sub.collateral || 0);
      if (col > 0) items.push({
        protocol: "Lighter", chain: "zklighter", asset: "USDC", amount: col, usd: col, kind: "deposit",
        detail: `zkLighter subaccount ${sub.index}`,
      });
    }
    for (const acc of kwenta?.accounts || []) {
      if (acc.usd > 0) items.push({
        protocol: "Kwenta", chain: "optimism", asset: "sUSD", amount: acc.susd, usd: acc.usd, kind: "deposit",
        detail: `Kwenta Smart Margin account ${acc.account}`,
      });
    }
    const more = await venues;
    items.push(...more.items);
    return { items: items.sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0)), errors: more.errors, venues_checked: more.venues_checked };
  },

  // Solana perp venues (perps/): Drift recovery claims, wound-down Flash Trade and Adrena, live Jupiter, Pacifica, Phoenix
  async perpsSolana(p, ctx) {
    need(p, "address");
    if (!isSolAddr(p.address)) throw { status: 400, error: "address must be a Solana address" };
    return readVenues(p.address, makeIo(ctx), SOL_VENUES);
  },

  async legacyClaims(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const a = p.address, items = [], errors = [], px = [];
    const fail = (what) => (e) => errors.push(`${what}: ${String(e?.error || e?.message || e).slice(0, 100)}`);
    const add = (row, priceKey, scale = 1) => { items.push(row); px.push([row, priceKey, scale]); };
    await Promise.all([
      (async () => {
        const r = await ctx.call("bridge.zksync_lite", { address: a });
        if (!r.ok) throw { error: `upstream ${r.status}` };
        await Promise.all((r.data?.tokens || []).filter((t) => BigInt(t.rawBalance || 0) > 0n).map(async (t) => {
          if (await call(ctx, LEGACY.zksyncLite, "isClaimed", [BigInt(t.claimIndex)])) return;
          const eth = t.tokenAddress.toLowerCase() === ZERO;
          add({ kind: "bridge_stuck", protocol: "ZKsync Lite", asset: t.symbol, amount: Number(t.rawBalance) / 10 ** Number(t.decimals), usd: null,
            action: `claim ${t.symbol} left on ZKsync Lite`, how_to_claim: "https://lite.zksync.io", detail: "ZKsync Lite stopped making blocks on 2026-05-04; balances left there are claimable on Ethereum" },
          eth ? "coingecko:ethereum" : `ethereum:${t.tokenAddress.toLowerCase()}`);
        }));
      })().catch(fail("zksync_lite")),
      call(ctx, LEGACY.liquitySurplus, "getCollateral", [a]).then((w) => {
        if (w > 0n) add({ kind: "reward", protocol: "Liquity", asset: "ETH", amount: Number(w) / 1e18, usd: null, action: "claim leftover Liquity collateral (claimCollateral)",
          how_to_claim: etherscanWrite(LEGACY.liquityOps), detail: "ETH left over after a trove was redeemed or liquidated in recovery mode, held in Liquity's CollSurplusPool" }, "coingecko:ethereum");
      }, fail("liquity")),
      ...LEGACY.curveFees.map(([sym, to, key]) => call(ctx, to, "claim", [a]).then((w) => {
        if (w > 0n) add({ kind: "reward", protocol: "Curve", asset: sym, amount: Number(w) / 1e18, usd: null, action: `claim veCRV fees in ${sym}`,
          how_to_claim: "https://www.curve.finance/dao/ethereum/vecrv/", detail: "admin fees paid to veCRV holders, never claimed" }, key);
      }, fail(`curve_${sym}`))),
      call(ctx, LEGACY.gnt, "balanceOf", [a]).then((w) => {
        if (w > 0n) add({ kind: "token_migration", protocol: "Golem", asset: "GNT", amount: Number(w) / 1e18, usd: null, action: "migrate GNT to GLM (1:1, GNT.migrate)",
          how_to_claim: etherscanWrite(LEGACY.gnt), detail: "old Golem token: it has no market price, its value is the GLM it migrates to" }, "coingecko:golem");
      }, fail("gnt")),
      Promise.all([call(ctx, LEGACY.dgd, "balanceOf", [a]), call(ctx, LEGACY.dgdRefund, "weiPerNanoDGD")]).then(([w, rate]) => {
        if (w > 0n) add({ kind: "token_migration", protocol: "DigixDAO", asset: "DGD", amount: Number(w) / 1e9, usd: null, action: "redeem DGD for ETH (approve, then burn() on the refund contract)",
          how_to_claim: etherscanWrite(LEGACY.dgdRefund), detail: `DigixDAO dissolved; its refund contract still pays ${Number(rate) / 1e9} ETH per DGD` }, "coingecko:ethereum", Number(rate) / 1e9);
      }, fail("dgd")),
      call(ctx, LEGACY.dao, "balanceOf", [a]).then((w) => {
        if (w > 0n) add({ kind: "token_migration", protocol: "The DAO", asset: "DAO", amount: Number(w) / 1e16, usd: null, action: "redeem The DAO tokens for ETH (100:1, approve, then WithdrawDAO.withdraw())",
          how_to_claim: etherscanWrite(LEGACY.daoRefund), detail: "The DAO refund contract still redeems 100 DAO tokens for 1 ETH" }, "coingecko:ethereum", 0.01);
      }, fail("dao")),
      call(ctx, LEGACY.splits, "getETHBalance", [a]).then((w) => {
        if (w >= 100000000000000n) add({ kind: "reward", protocol: "0xSplits", chain: "ethereum", asset: "ETH", amount: Number(w) / 1e18, usd: null, action: "withdraw 0xSplits ETH balance (SplitMain.withdraw(account, 1, []))",
          how_to_claim: "https://app.splits.org", detail: "unwithdrawn ETH earnings in 0xSplits SplitMain on Ethereum" }, "coingecko:ethereum");
      }, fail("splits_eth")),
      call(ctx, LEGACY.splits, "getETHBalance", [a], "base").then((w) => {
        if (w >= 100000000000000n) add({ kind: "reward", protocol: "0xSplits", chain: "base", asset: "ETH", amount: Number(w) / 1e18, usd: null, action: "withdraw 0xSplits ETH balance (SplitMain.withdraw(account, 1, []))",
          how_to_claim: "https://app.splits.org", detail: "unwithdrawn ETH earnings in 0xSplits SplitMain on Base" }, "coingecko:ethereum");
      }, fail("splits_base")),
      call(ctx, LEGACY.zoraRewards, "balanceOf", [a], "base").then((w) => {
        if (w >= 100000000000000n) add({ kind: "reward", protocol: "Zora", chain: "base", asset: "ETH", amount: Number(w) / 1e18, usd: null, action: "withdraw Zora creator rewards (ProtocolRewards.withdraw(to, amount))",
          how_to_claim: "https://zora.co", detail: "unwithdrawn creator and referral rewards in Zora ProtocolRewards on Base" }, "coingecko:ethereum");
      }, fail("zora_rewards")),
      call(ctx, LEGACY.kncl, "balanceOf", [a]).then((w) => {
        if (w > 0n) add({ kind: "token_migration", protocol: "Kyber", asset: "KNCL", amount: Number(w) / 1e18, usd: null, action: "migrate KNCL to KNC (1:1, approve, then KNC.mintWithOldKnc(amount))",
          how_to_claim: etherscanWrite(LEGACY.kncSwap), detail: "old Kyber (KNCL) tokens are redeemable 1:1 for new KNC on Ethereum" }, "coingecko:kyber-network-crystal");
      }, fail("kncl")),
      call(ctx, LEGACY.rplV1, "balanceOf", [a]).then((w) => {
        if (w > 0n) add({ kind: "token_migration", protocol: "Rocket Pool", asset: "RPLv1", amount: Number(w) / 1e18, usd: null, action: "migrate RPL v1 to RPL (1:1, approve, then RocketTokenRPL.swapTokens(amount))",
          how_to_claim: etherscanWrite(LEGACY.rplSwap), detail: "old Rocket Pool v1 tokens are swappable 1:1 for new RPL on Ethereum" }, "coingecko:rocket-pool");
      }, fail("rpl_v1")),
      call(ctx, LEGACY.dsproxyRegistry, "proxies", [a]).then(async (proxy) => {
        if (!proxy || proxy.toLowerCase() === ZERO) return;
        const pLower = proxy.toLowerCase();
        const [ethR, daiW, usdcW] = await Promise.all([
          step(ctx, "evm.rpc", {}, { body: rpc("eth_getBalance", [pLower, "latest"]) }).catch(() => null),
          call(ctx, LEGACY.dai, "balanceOf", [pLower]).catch(() => 0n),
          call(ctx, LEGACY.usdc, "balanceOf", [pLower]).catch(() => 0n),
        ]);
        const ethWei = ethR?.result ? BigInt(ethR.result) : 0n;
        if (ethWei >= 100000000000000n) {
          add({ kind: "reward", protocol: "DSProxy", asset: "ETH", amount: Number(ethWei) / 1e18, usd: null, action: `withdraw ETH left in your DSProxy smart wallet (${pLower.slice(0, 8)}...)`,
            how_to_claim: "https://tokensaver.fyi", detail: `DSProxy contract ${proxy} owned by this wallet holds ETH: withdraw via proxy.execute()` }, "coingecko:ethereum");
        }
        if (daiW >= 100000000000000000n) {
          add({ kind: "reward", protocol: "DSProxy", asset: "DAI", amount: Number(daiW) / 1e18, usd: null, action: `withdraw DAI left in your DSProxy smart wallet (${pLower.slice(0, 8)}...)`,
            how_to_claim: "https://tokensaver.fyi", detail: `DSProxy contract ${proxy} owned by this wallet holds DAI: withdraw via proxy.execute()` }, "coingecko:dai");
        }
        if (usdcW >= 100000n) {
          add({ kind: "reward", protocol: "DSProxy", asset: "USDC", amount: Number(usdcW) / 1e6, usd: null, action: `withdraw USDC left in your DSProxy smart wallet (${pLower.slice(0, 8)}...)`,
            how_to_claim: "https://tokensaver.fyi", detail: `DSProxy contract ${proxy} owned by this wallet holds USDC: withdraw via proxy.execute()` }, "coingecko:usd-coin");
        }
      }, fail("dsproxy")),
    ]);
    if (px.length) {
      const r = await ctx.call("token.prices", { coins: [...new Set(px.map((x) => x[1]))].join(",") }).catch(() => null);
      const coins = Object.fromEntries(Object.entries(r?.data?.coins || {}).map(([k, v]) => [k.toLowerCase(), v]));
      for (const [row, key, scale] of px) { const c = coins[key.toLowerCase()]; if (c?.price) row.usd = row.amount * scale * c.price; }
    }
    return { items: items.sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0)), errors };
  },

  // money left in old Ethereum contracts (oldeth/): Forgotten ETH index + EtherDelta/IDEX + ENS deeds, SAI vaults,
  // Argent smart wallets, validators with 0x00 credentials; ETH priced on DefiLlama
  async oldContracts(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const O = await import("./oldeth/index.mjs"), io = O.ioFrom(ctx);
    return O.priceEth(io, await O.oldContracts(p.address, io));
  },
  async makerScd(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const O = await import("./oldeth/index.mjs"), io = O.ioFrom(ctx);
    return O.priceEth(io, await O.makerScd(p.address, io));
  },
  async argentWallets(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const O = await import("./oldeth/index.mjs"), io = O.ioFrom(ctx);
    return O.priceEth(io, await O.argentWallets(p.address, io));
  },
  async validators0x00(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const O = await import("./oldeth/index.mjs"), io = O.ioFrom(ctx);
    return O.priceEth(io, await O.validators0x00(p.address, io));
  },

  async venice(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const read = async (fn) => decodeFunctionResult({ abi: veniceAbi, functionName: fn, data: await ethCall(ctx, VENICE.staking, encodeFunctionData({ abi: veniceAbi, functionName: fn, args: [p.address] }), "base") });
    const [[locked, debt], pending, [, cdEnd, cdAmount], px] = await Promise.all([read("lockedStakes"), read("pendingRewards"), read("stakes"),
      ctx.call("token.prices", { coins: `${VENICE.vvv},${VENICE.diem}` }).catch(() => null)]);
    const price = (k) => px?.data?.coins?.[k]?.price ?? null;
    return {
      locked_svvv: Number(locked) / 1e18, diem_debt: Number(debt) / 1e18, pending_vvv: Number(pending) / 1e18, vvv_usd: price(VENICE.vvv), diem_usd: price(VENICE.diem),
      cooldown: cdAmount > 0n ? { vvv: Number(cdAmount) / 1e18, ends: new Date(Number(cdEnd) * 1000).toISOString() } : null,
    };
  },

  // Blast apps (Thruster v3 LP NFTs, Orbit Lending, Pac Finance): what the wallet can still take out before Blast's
  // app withdrawals end. A deposit comes back only up to the cash its market still holds (Orbit was exploited)
  async blastApps(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const a = p.address, B = BLAST, items = [];
    const first = await blastReads(ctx, [
      [B.thrusterNpm, "balanceOf", [a]],
      ...B.orbit.flatMap(([m]) => [[m, "getAccountSnapshot", [a]], [m, "getCash"]]),
      ...B.pac.flatMap(([, u, , at, vd]) => [[at, "balanceOf", [a]], [vd, "balanceOf", [a]], [u, "balanceOf", [at]]]),
    ]);
    const units = (v, dec) => (v == null ? null : Number(v) / 10 ** dec);
    // Orbit (Compound v2): underlying = oToken balance x exchangeRate / 1e18; a borrow anywhere locks the collateral
    const orbit = [], orbitDebts = [];
    B.orbit.forEach(([market, asset, token, dec], i) => {
      const snap = first[1 + 2 * i];
      if (!snap) return;
      const [, bal, borrow, rate] = snap;
      if (borrow > 0n) orbitDebts.push({ asset, token, amount: units(borrow, dec) });
      if (bal > 0n) orbit.push({ protocol: "Orbit Lending", kind: "deposit", asset, token, amount: units((bal * rate) / 10n ** 18n, dec), cash: units(first[2 + 2 * i], dec), market,
        how_to_claim: blastWrite(market), detail: `Orbit ${asset} market ${market}: redeem(your oToken balance) or redeemUnderlying(amount)` });
    });
    // Pac Finance (Aave v3): aToken balance = underlying; cash = underlying held by the aToken contract
    const pac = [], pacDebts = [], o = 1 + 2 * B.orbit.length;
    B.pac.forEach(([asset, token, dec, aToken], i) => {
      const [bal, debt, cash] = first.slice(o + 3 * i, o + 3 * i + 3);
      if (debt > 0n) pacDebts.push({ asset, token, amount: units(debt, dec) });
      if (bal > 0n) pac.push({ protocol: "Pac Finance", kind: "deposit", asset, token, amount: units(bal, dec), cash: units(cash, dec), market: aToken,
        how_to_claim: blastWrite(B.pacPool), detail: `Pac Finance pool ${B.pacPool}: withdraw(${token}, amount, your address); receipt token ${aToken}` });
    });
    items.push(...orbit.map((x) => ({ ...x, debts: orbitDebts })), ...pac.map((x) => ({ ...x, debts: pacDebts })));
    // Thruster v3 (Uniswap v3 fork): LP NFTs held by the wallet; token amounts from liquidity, ticks and the pool price
    // plus fees already booked (tokensOwed); fees not yet booked come on top
    const nfts = Number(first[0] ?? 0n);
    if (nfts > 0) {
      const ids = (await blastReads(ctx, Array.from({ length: Math.min(nfts, 50) }, (_, i) => [B.thrusterNpm, "tokenOfOwnerByIndex", [a, BigInt(i)]]))).filter((x) => x != null);
      const pos = (await blastReads(ctx, ids.map((id) => [B.thrusterNpm, "positions", [id]])))
        .map((x, i) => x && { id: ids[i], token0: x[2], token1: x[3], fee: x[4], lo: x[5], hi: x[6], liq: x[7], owed0: x[10], owed1: x[11] })
        .filter((x) => x && (x.liq > 0n || x.owed0 > 0n || x.owed1 > 0n));
      const pools = [...new Set(pos.map((x) => `${x.token0}:${x.token1}:${x.fee}`))], toks = [...new Set(pos.flatMap((x) => [x.token0, x.token1]))];
      const meta = pos.length ? await blastReads(ctx, [...pools.map((k) => { const [t0, t1, fee] = k.split(":"); return [B.thrusterFactory, "getPool", [t0, t1, Number(fee)]]; }), ...toks.flatMap((t) => [[t, "symbol"], [t, "decimals"]])]) : [];
      const poolOf = new Map(pools.map((k, i) => [k, meta[i]]));
      const tok = new Map(toks.map((t, i) => [t, { symbol: meta[pools.length + 2 * i] || t.slice(0, 10), decimals: Number(meta[pools.length + 2 * i + 1] ?? 18) }]));
      const live = [...new Set([...poolOf.values()].filter(Boolean))];
      const slots = live.length ? await blastReads(ctx, live.map((x) => [x, "slot0"])) : [];
      const sqrtOf = new Map(live.map((x, i) => [x, slots[i]]));
      for (const x of pos) {
        const pool = poolOf.get(`${x.token0}:${x.token1}:${x.fee}`), sp = pool ? sqrtOf.get(pool) : null;
        const s = (t) => Math.pow(1.0001, t / 2), L = Number(x.liq), lo = s(x.lo), hi = s(x.hi);
        let r0 = 0, r1 = 0;
        if (sp != null) {
          const c = Number(sp) / 2 ** 96;
          if (c <= lo) r0 = (L * (hi - lo)) / (lo * hi);
          else if (c >= hi) r1 = L * (hi - lo);
          else { r0 = (L * (hi - c)) / (c * hi); r1 = L * (c - lo); }
        }
        const t0 = tok.get(x.token0), t1 = tok.get(x.token1);
        const tokens = [{ symbol: t0.symbol, token: x.token0, amount: (r0 + Number(x.owed0)) / 10 ** t0.decimals }, { symbol: t1.symbol, token: x.token1, amount: (r1 + Number(x.owed1)) / 10 ** t1.decimals }];
        items.push({
          protocol: "Thruster", kind: "lp", asset: `${t0.symbol}/${t1.symbol}`, amount: null, tokens, token_id: String(x.id), how_to_claim: blastWrite(B.thrusterNpm),
          detail: `Thruster v3 position #${x.id} (fee ${x.fee / 10000}%): decreaseLiquidity(tokenId, liquidity, 0, 0, deadline), then collect(tokenId, you, max, max)${sp == null && x.liq > 0n ? "; pool price not readable, only booked fees counted" : ""}`,
        });
      }
    }
    // prices: DefiLlama blast:<token>, native ETH as coingecko:ethereum; loans priced too, to net them per protocol
    const key = (t) => (t ? `blast:${t.toLowerCase()}` : "coingecko:ethereum");
    const keys = [...new Set([...items.flatMap((x) => (x.tokens ? x.tokens.map((t) => key(t.token)) : [key(x.token)])), ...[...orbitDebts, ...pacDebts].map((d) => key(d.token))])];
    const px = keys.length ? await ctx.call("token.prices", { coins: keys.join(",") }).catch(() => null) : null;
    const price = (t) => { const c = px?.data?.coins?.[key(t)]; return c?.price != null && (c.confidence ?? 1) >= 0.9 ? c.price : null; }; // a thin market (DefiLlama confidence under 0.9) is no price
    for (const x of items) {
      if (x.tokens) {
        const priced = x.tokens.filter((t) => price(t.token) != null);
        x.usd = priced.length ? priced.reduce((s, t) => s + t.amount * price(t.token), 0) : null;
      } else x.usd = price(x.token) == null ? null : x.amount * price(x.token);
    }
    // a loan locks the deposits of that protocol: supply_usd and debt_usd are the protocol totals (unpriced debt = null)
    for (const debts of [orbitDebts, pacDebts]) for (const d of debts) d.usd = price(d.token) == null ? null : d.amount * price(d.token);
    for (const x of items) {
      if (!x.debts) continue;
      x.supply_usd = items.filter((y) => y.protocol === x.protocol).reduce((s, y) => s + (y.usd ?? 0), 0);
      x.debt_usd = x.debts.some((d) => d.usd == null) ? null : x.debts.reduce((s, d) => s + d.usd, 0);
    }
    const sun = B.sunset || {};
    return { closes: sun.closes ?? null, exit: sun.exit ?? null, link: sun.link ?? null, l1_bridges: sun.l1_bridges || [], items: items.sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0)) };
  },

  // Pendle: positions left in a market past its expiry (matured PT, YT interest, LP) and merkle rewards not claimed
  async pendle(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    // the expired-market list (1.8 MB, cached 1 h) only matters when the wallet still holds a position
    const [pos, merkle] = await Promise.all([step(ctx, "rewards.pendle_positions", { address: p.address }), step(ctx, "rewards.pendle_merkle", { address: p.address })]);
    const markets = (pos?.positions || []).some((c) => c.openPositions?.length) ? await step(ctx, "rewards.pendle_expired_markets", {}) : [];
    const now = new Date().toISOString();
    const expired = new Map((Array.isArray(markets) ? markets : markets?.markets || []).filter((m) => m.expiry && m.expiry <= now).map((m) => [`${m.chainId}-${String(m.address).toLowerCase()}`, m]));
    const matured = [];
    for (const c of pos?.positions || []) {
      for (const o of c.openPositions || []) {
        const m = expired.get(String(o.marketId).toLowerCase());
        if (!m) continue;
        for (const part of ["pt", "yt", "lp"]) {
          if (Number(o[part]?.valuation) > 0) matured.push({ chain_id: c.chainId, market: m.address, name: m.name, expiry: m.expiry.slice(0, 10), part, usd: Number(o[part].valuation) });
        }
      }
    }
    const due = (merkle?.rewards || []).filter((r) => BigInt(r.total?.claimable || 0) > 0n);
    const keys = due.map((r) => `${LLAMA_KEY[r.chainId] || "ethereum"}:${String(r.token).toLowerCase()}`);
    const px = keys.length ? await ctx.call("token.prices", { coins: [...new Set(keys)].join(",") }).catch(() => null) : null;
    const rewards = due.map((r, i) => {
      const c = px?.data?.coins?.[keys[i]], amount = c?.decimals != null ? Number(BigInt(r.total.claimable)) / 10 ** c.decimals : null;
      return { chain_id: r.chainId, token: String(r.token).toLowerCase(), symbol: c?.symbol || null, amount, usd: amount != null && c?.price ? amount * c.price : null, title: r.claimable?.[0]?.displayTitle || null };
    });
    return { matured: matured.sort((a, b) => b.usd - a.usd), rewards };
  },

  async hyperliquid(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const q = (type) => step(ctx, "holdings.hyperliquid_info", { type, address: p.address });
    const [spot, perps, stake, vaults, market] = await Promise.all(["spotClearinghouseState", "clearinghouseState", "delegatorSummary", "userVaultEquities"].map(q).concat(
      step(ctx, "holdings.hyperliquid_info", { type: "spotMetaAndAssetCtxs", address: ZERO })));
    // a token's price = its USDC pair (quote token 0); verified when that market traded $100k+ in the last day
    const [meta, ctxs] = Array.isArray(market) ? market : [{}, []];
    const byCoin = new Map((ctxs || []).map((c) => [c.coin, c]));
    const price = (token) => {
      if (token === 0) return { px: 1, verified: true };
      const pair = (meta.universe || []).find((u) => u.tokens?.[0] === token && u.tokens?.[1] === 0), c = pair && byCoin.get(pair.name);
      const px = Number(c?.midPx ?? c?.markPx);
      return px > 0 ? { px, verified: Number(c.dayNtlVlm) >= 100000, vol: Number(c.dayNtlVlm) } : null;
    };
    const items = [];
    for (const b of spot?.balances || []) {
      const amount = Number(b.total);
      if (!(amount > 0)) continue;
      const pr = price(b.token), usd = pr ? amount * pr.px : null;
      items.push({ kind: "token", asset: b.coin, amount, usd, verified: !!pr?.verified, ...(pr && !pr.verified && { detail: `thin market: $${Math.round(pr.vol)} traded on Hyperliquid in the last day` }) });
    }
    const acct = Number(perps?.marginSummary?.accountValue);
    if (acct > 0) items.push({ kind: "position", asset: "USDC", amount: acct, usd: acct, verified: true, protocol: "Hyperliquid perps", detail: `withdrawable now ${Number(perps.withdrawable || 0)} USDC` });
    const hype = price(150)?.px ?? null, staked = Number(stake?.delegated || 0) + Number(stake?.undelegated || 0), pending = Number(stake?.totalPendingWithdrawal || 0);
    if (staked + pending > 0) items.push({ kind: "staked", asset: "HYPE", amount: staked + pending, usd: hype ? (staked + pending) * hype : null, verified: true, protocol: "Hyperliquid staking", ...(pending > 0 && { detail: `${pending} HYPE unstaking (${stake.nPendingWithdrawals} withdrawal${stake.nPendingWithdrawals > 1 ? "s" : ""})` }) });
    for (const v of Array.isArray(vaults) ? vaults : []) {
      const eq = Number(v.equity);
      if (eq > 0) items.push({ kind: "deposit", asset: "USDC", amount: eq, usd: eq, verified: true, protocol: "Hyperliquid vault", detail: `vault ${v.vaultAddress}` });
    }
    return { items: items.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0)) };
  },

  async pumpCreatorFees(p, ctx) {
    need(p, "address");
    if (!isSolAddr(p.address)) throw { status: 400, error: "address must be a Solana address" };
    const v = pumpVaults(p.address);
    const [acc, rent0] = await Promise.all([
      step(ctx, "sol.accounts", { pubkeys: [v.curve, v.ammWsol].join(",") }),
      ctx.call("sol.rent_minimum", { bytes: "0" }).then((r) => (r.ok ? Number(r.data.result) : 890880)).catch(() => 890880),
    ]);
    const [curve, wsol] = acc?.result?.value || [];
    const curveSol = curve ? Math.max(0, Number(curve.lamports) - rent0) / 1e9 : 0;
    const wsolSol = Number(wsol?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
    return {
      bonding_curve: { vault: v.curve, lamports: curve?.lamports ?? 0, claimable_sol: curveSol },
      pumpswap: { vault: v.ammAuthority, wsol_account: v.ammWsol, claimable_sol: wsolSol },
      claimable_sol: curveSol + wsolSol,
    };
  },

  // Parcl PRCL airdrops (7 distributors): allocation from Parcl's claim APIs, then one getMultipleAccounts for each
  // distributor (vesting and clawback dates), the wallet's ClaimStatus PDA (claimed? vested part withdrawn?) and the
  // distributor's token vault (still funded?)
  async parcl(p, ctx) {
    need(p, "address");
    if (!isSolAddr(p.address)) throw { status: 400, error: "address must be a Solana address" };
    const a = p.address, S = PARCL.seasons, n = S.length, errors = [];
    const alloc = async ([key, , season]) => {
      try {
        const r = await (season == null ? ctx.call("airdrop.parcl_s3", { address: a }) : ctx.call("airdrop.parcl_gnome", { address: a, season }));
        if (r.status === 404) return null; // not in this season
        if (!r.ok) throw { error: `upstream ${r.status}` };
        return r.data;
      } catch (e) {
        errors.push(`${key}: ${String(e?.error || e?.message || e).slice(0, 100)}`);
        return null;
      }
    };
    const status = S.map(([, , , dist]) => findPda([seed("ClaimStatus"), a, dist], PARCL.program).address);
    const [allocs, acc, px] = await Promise.all([
      Promise.all(S.map(alloc)),
      step(ctx, "sol.accounts", { pubkeys: [...S.map((s) => s[3]), ...status, ...S.map((s) => s[4])].join(",") }),
      ctx.call("token.prices", { coins: `solana:${PARCL.mint}` }).catch(() => null),
    ]);
    if (errors.length === n) throw { status: 502, error: "every Parcl claim API failed", detail: errors };
    const c = px?.data?.coins?.[`solana:${PARCL.mint}`], price = c?.price != null && (c.confidence ?? 1) >= 0.9 ? c.price : null; // a thin market is no price
    const v = acc?.result?.value || [], now = Date.now() / 1000;
    const bytes = (x) => (Array.isArray(x?.data) && x.data[0] ? Buffer.from(x.data[0], "base64") : null);
    const day = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
    const items = [];
    S.forEach(([key, name, season, dist], i) => {
      const al = allocs[i];
      if (!al) return;
      if ((al.merkle_tree || al.distributor) !== dist) { errors.push(`${key}: the API names distributor ${al.merkle_tree || al.distributor}`); return; }
      const d = bytes(v[i]);
      if (!d || d.length < 234) { errors.push(`${key}: distributor account not readable`); return; }
      // MerkleDistributor: startTs @145, endTs @153, clawbackStartTs @161 (i64), clawedBack @233 (bool); locked tokens vest from start to end
      const start = Number(d.readBigInt64LE(145)), end = Number(d.readBigInt64LE(153)), clawback = Number(d.readBigInt64LE(161));
      const vested = end <= start || now >= end ? 1 : now <= start ? 0 : (now - start) / (end - start);
      // ClaimStatus (exists once claimed): locked_amount @40, locked_amount_withdrawn @48 (u64, raw 6 decimals); the unlocked part was paid at claim
      const cs = bytes(v[n + i]), s3 = season == null;
      const locked = cs ? Number(cs.readBigUInt64LE(40)) : Number((s3 ? al.amountRaw : al.locked_amount) || 0);
      const unlocked = cs || s3 ? 0 : Number(al.amount || 0), withdrawn = cs ? Number(cs.readBigUInt64LE(48)) : 0;
      const amount = Math.max(0, unlocked + Math.floor(locked * vested) - withdrawn) / 1e6, left = Math.max(0, locked - Math.floor(locked * vested)) / 1e6;
      if (!(amount > 0) && !(left > 0)) return;
      const vault = v[2 * n + i]?.data?.parsed?.info?.tokenAmount?.amount;
      items.push({
        season: key, name, distributor: dist, claimed: !!cs, amount, vesting_left: left, usd: price == null ? null : Math.round(amount * price * 100) / 100,
        vesting_end: day(end), clawback_start: day(clawback), clawed_back: d[233] === 1, vault_balance: vault == null ? null : Number(vault) / 1e6, claim_url: PARCL.claim,
      });
    });
    return { items: items.sort((x, y) => y.amount - x.amount), price, errors };
  },

  async stuck(p) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const [{ checkWallet }, { BRIDGES }] = await Promise.all([import("./stuck/index.mjs"), import("./stuck/core.mjs")]);
    const bridges = p.bridges ? String(p.bridges).split(",").map((s) => s.trim()).filter(Boolean) : undefined;
    const out = await checkWallet(p.address, { bridges, includeAll: ["1", "true", "yes"].includes(String(p.all || "").toLowerCase()) });
    // items carry the bridge's display name; add its key (base, arbitrum, cctp...) for links and follow-up calls
    const keyOf = new Map(Object.values(BRIDGES).map((b) => [b.name, b.key]));
    return { ...out, items: out.items.map((i) => ({ key: keyOf.get(i.bridge) ?? null, ...i })) };
  },

  // Streamflow merkle airdrops: most distributors a wallet is in are memecoin spam, so only a mint Jupiter
  // verifies (or a distributor Streamflow verifies) with a price is kept. claimable = unlocked + the vested part
  // of locked - claimed.
  async streamflow(p, ctx) {
    need(p, "address");
    if (!isSolAddr(p.address)) throw { status: 400, error: "address must be a Solana address" };
    const now = Date.now() / 1000, big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
    const rows = (await step(ctx, "airdrop.streamflow_eligibility", { address: p.address }) || [])
      .filter((r) => !r.isClosed && big(r.amountUnlocked) + big(r.amountLocked) > big(r.amountClaimed));
    if (!rows.length) return { items: [], spam: 0 };
    const dist = new Map();
    for (let i = 0; i < rows.length; i += 100) {
      for (const d of await step(ctx, "airdrop.streamflow_distributors", { addresses: rows.slice(i, i + 100).map((r) => r.distributorAddress).join(",") }) || []) dist.set(d.address, d);
    }
    const mints = [...new Set([...dist.values()].map((d) => d.mint))];
    const jup = new Map();
    for (let i = 0; i < mints.length; i += 100) {
      const r = await ctx.call("token.jup_info", { query: mints.slice(i, i + 100).join(",") }).catch(() => null);
      for (const t of (r?.ok && Array.isArray(r.data) ? r.data : [])) jup.set(t.id, t);
    }
    const items = [];
    let spam = 0;
    for (const r of rows) {
      const d = dist.get(r.distributorAddress), t = d && jup.get(d.mint);
      const verified = !!(t && (t.isVerified || (t.tags || []).some((x) => x === "verified" || x === "strict")));
      if (!d || !d.isActive || d.clawbackDt || !t || t.usdPrice == null || !(verified || d.isVerified)) { spam++; continue; }
      const dec = 10 ** Number(t.decimals ?? 0), s = Number(d.startVestingTs || 0), e = Number(d.endVestingTs || 0);
      const vested = e <= s || now >= e ? 1 : now <= s ? 0 : (now - s) / (e - s);
      const unlocked = Number(big(r.amountUnlocked)) / dec, locked = Number(big(r.amountLocked)) / dec, claimed = Number(big(r.amountClaimed)) / dec;
      const claimable = Math.max(0, unlocked + locked * vested - claimed);
      const left = Number(big(d.maxTotalClaim) - big(d.totalAmountClaimed)) / dec; // the distributor must still hold it
      if (claimable <= 0 || left < claimable) continue;
      items.push({
        distributor: d.address, name: (d.name || "").trim() || null, mint: d.mint, symbol: t.symbol, decimals: t.decimals, verified, distributor_verified: !!d.isVerified,
        claimable, locked: Math.max(0, locked * (1 - vested)), claimed, price: t.usdPrice, usd: Math.round(claimable * t.usdPrice * 100) / 100,
        liquidity: t.liquidity ?? null, vesting_end: e > s ? new Date(e * 1000).toISOString().slice(0, 10) : null,
        claim_url: `https://app.streamflow.finance/airdrop/solana/mainnet/${d.address}`,
      });
    }
    return { items: items.sort((a, b) => b.usd - a.usd), spam };
  },

  async airdropIndex(p) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    return (await import("./airdrops/index.mjs")).checkWallet(p.address);
  },

  async chains(p) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
    const { checkWallet } = await import("./chains/index.mjs");
    return checkWallet(p.address, { chains: p.chains ? String(p.chains).split(",").map((s) => s.trim()).filter(Boolean) : undefined });
  },

  async scanEvm(p, ctx) {
    need(p, "address");
    if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address (use scan.sol or scan.all for Solana)" };
    if (BURN.has(p.address.toLowerCase())) throw { status: 400, error: "a burn address: no one holds its key, so nothing on it can be claimed", detail: p.address };
    const address = p.address, minUsd = minUsdOf(p), skip = new Set(String(p.skip || "").split(",").map((s) => s.trim()).filter(Boolean));
    const [env, deadlines] = await Promise.all([feeEnv(ctx, true), ctx.local("deadlines", { open: "1" })]);
    let zSeen = null; // what Zerion answered for: the every-chain sweep only adds what Zerion missed
    let goplus = null;
    const failed = {}, zkevm = { known: false }; // unclaimed/ chains whose read failed (Zerion rows there stay); the zkEVM claimer lists the wallet
    const noted = (id, d) => { failed[id] = F.failedChains(d?.errors); return d; };
    const run = await runSources(ctx, [
      { id: "rewards.merkl", run: async () => ({ findings: F.merkl(await get(ctx, "rewards.merkl", { address }), { address }) }) },
      { id: "rewards.blast", run: async () => ({ findings: F.blastApps(await get(ctx, "rewards.blast", { address })) }) },
      { id: "rewards.zerion", run: async () => { const d = await walletPositions(ctx, "rewards.zerion", { address, types: "reward,locked,deposit,staked,loan" }); return { ...F.zerionPositions(d, { deadlines }), coverage: d.coverage }; } },
      {
        id: "holdings.zerion", run: async () => {
          const a = await walletPositions(ctx, "holdings.zerion", { address });
          zSeen = a.coverage.status === "complete" ? F.zerionSeen(a) : null;
          return { ...F.zerionHoldings(a, { deadlines: [...deadlines, ...(await import("./chains/index.mjs")).sunsetDeadlines(deadlines)], minUsd }), coverage: a.coverage };
        },
      },
      { id: "holdings.chains", ms: 30000, run: async () => F.chainSweep(await get(ctx, "holdings.chains", { address }), { minUsd }) },
      {
        id: "rewards.polymarket_redeemable", run: async () => {
          const prof = await ctx.call("rewards.polymarket_profile", { address }).catch(() => null);
          const users = [...new Set([prof?.ok && prof.data?.proxyWallet, address].filter(Boolean).map((a) => a.toLowerCase()))];
          const [rows, open] = await Promise.all(["rewards.polymarket_redeemable", "holdings.polymarket"].map(async (id) => (await Promise.all(users.map((u) => get(ctx, id, { user: u })))).flat()));
          return { findings: F.polymarket(rows, { users }), holdings: F.polymarketOpen(open) };
        },
      },
      { id: "holdings.hyperliquid", run: async () => ({ holdings: F.hyperliquid(await get(ctx, "holdings.hyperliquid", { address }), { minUsd }) }) },
      { id: "holdings.perps", run: async () => { const d = await get(ctx, "holdings.perps", { address }); return { holdings: F.perpsHoldings(d, { minUsd }), findings: F.perpsFindings(d) }; } },
      { id: "rewards.hyperliquid_referral", run: async () => ({ findings: F.hyperliquidReferral(await get(ctx, "rewards.hyperliquid_referral", { address })) }) },
      { id: "rewards.lido_withdrawals", run: async () => ({ findings: F.lido(await get(ctx, "rewards.lido_withdrawals", { address }), env) }) },
      { id: "bridge.polygon_zkevm", run: async () => { const d = await get(ctx, "bridge.polygon_zkevm", { address }); zkevm.known = !!d?.known; return { findings: F.zkevmExits(d, { deadline: deadlines.find((x) => x.id === "polygon-zkevm")?.closes }) }; } },
      { id: "rewards.hedgey", run: async () => ({ findings: F.hedgey(noted("rewards.hedgey", await get(ctx, "rewards.hedgey", { address }))) }) },
      { id: "rewards.flaunch", run: async () => ({ findings: F.flaunch(await get(ctx, "rewards.flaunch", { address })) }) },
      { id: "rewards.uniswap_fees", run: async () => ({ findings: F.uniswapFees(noted("rewards.uniswap_fees", await get(ctx, "rewards.uniswap_fees", { address }))) }) },
      { id: "rewards.superfluid", run: async () => ({ findings: F.superfluid(noted("rewards.superfluid", await get(ctx, "rewards.superfluid", { address }))) }) },
      { id: "rewards.token_locks", run: async () => ({ findings: F.tokenLocks(noted("rewards.token_locks", await get(ctx, "rewards.token_locks", { address }))) }) },
      { id: "rewards.eigenlayer_withdrawals", run: async () => ({ findings: F.eigenlayer(await get(ctx, "rewards.eigenlayer_withdrawals", { address }), env) }) },
      { id: "rewards.pendle", run: async () => ({ findings: F.pendle(await get(ctx, "rewards.pendle", { address })) }) },
      { id: "rewards.venice", run: async () => F.venice(await get(ctx, "rewards.venice", { address })) },
      { id: "rewards.legacy", run: async () => ({ findings: F.legacy(await get(ctx, "rewards.legacy", { address })) }) },
      { id: "rewards.old_contracts", run: async () => ({ findings: F.oldEthereum(await get(ctx, "rewards.old_contracts", { address }), { source: "rewards.old_contracts" }) }) },
      { id: "rewards.maker_scd", run: async () => ({ findings: F.oldEthereum(await get(ctx, "rewards.maker_scd", { address }), { source: "rewards.maker_scd" }) }) },
      { id: "rewards.argent_wallets", run: async () => ({ findings: F.oldEthereum(await get(ctx, "rewards.argent_wallets", { address }), { source: "rewards.argent_wallets" }) }) },
      { id: "rewards.validators_0x00", run: async () => F.validators0x00(await get(ctx, "rewards.validators_0x00", { address })) },
      // Zerion's reward positions already include vested Sablier streams; the indexer is the fallback when Zerion has no answer
      {
        id: "rewards.sablier_streams", after: ["rewards.zerion"],
        run: async (z) => (z && z.coverage?.status !== "truncated" ? { status: "skipped: rewards.zerion covers Sablier" } : { findings: F.sablier(await get(ctx, "rewards.sablier_streams", { recipient: address.toLowerCase() })) }),
      },
      // skipped[]: the bridges (or parts of one) it could not check without a key
      { id: "bridge.stuck", ms: 80000, run: async () => { const d = await get(ctx, "bridge.stuck", { address }); for (const s of d?.skipped || []) noteKey(s.key, `${s.bridge}: ${s.why}`); return { findings: F.stuck(d), scroll: !!d?.bridges_checked?.includes("scroll") && !(d?.errors || []).some((e) => e.bridge === "scroll") }; } },
      { id: "bridge.layerzero", run: async () => ({ findings: F.layerzero(await get(ctx, "bridge.layerzero", { address })) }) },
      { id: "bridge.ccip", run: async () => ({ findings: F.ccip(await get(ctx, "bridge.ccip", { address })) }) },
      { id: "bridge.lifi", run: async () => ({ findings: F.lifi(await get(ctx, "bridge.lifi", { address })) }) },
      { id: "bridge.across", run: async () => ({ findings: F.across(await get(ctx, "bridge.across", { address })) }) },
      // bridge.stuck reads the same Scroll API (claimable check, token decimals): this one only stands in when it has no answer
      { id: "bridge.scroll", after: ["bridge.stuck"], run: async (st) => (st?.scroll ? { status: "skipped: bridge.stuck covers Scroll" } : { findings: F.scrollBridge(await get(ctx, "bridge.scroll", { address }), env) }) },
      { id: "bridge.mayan", run: async () => ({ findings: F.mayan(await get(ctx, "bridge.mayan", { address })) }) },
      { id: "bridge.axelar", run: async () => ({ findings: F.axelar(await get(ctx, "bridge.axelar", { address })) }) },
      { id: "rewards.lrt_withdrawals", run: async () => ({ findings: F.lrtWithdrawals(await get(ctx, "rewards.lrt_withdrawals", { address }), env) }) },
      { id: "rewards.old_tokens", run: async () => ({ findings: F.oldTokens(await get(ctx, "rewards.old_tokens", { address })) }) },
      { id: "rewards.expired_locks", run: async () => ({ findings: F.expiredLocks(await get(ctx, "rewards.expired_locks", { address })) }) },
      { id: "rewards.stargate_fees", run: async () => ({ findings: F.stargateFees(await get(ctx, "rewards.stargate_fees", { address })) }) },
      { id: "rewards.balancer", run: async () => ({ findings: F.balancer(await get(ctx, "rewards.balancer", { address }), { minUsd }) }) },
      { id: "rewards.ve_nfts", run: async () => ({ findings: F.veNfts(await get(ctx, "rewards.ve_nfts", { address })) }) },
      { id: "rewards.dead_defi", run: async () => ({ findings: F.deadDefi(await get(ctx, "rewards.dead_defi", { address })) }) },
      { id: "rewards.bnb_farms", run: async () => ({ findings: F.bnbFarms(await get(ctx, "rewards.bnb_farms", { address })) }) },
      { id: "rewards.dead_apps", run: async () => ({ findings: F.deadApps(await get(ctx, "rewards.dead_apps", { address })) }) },
      { id: "rewards.pons", run: async () => { const d = await get(ctx, "rewards.pons", { address }); return { findings: F.hfClaims(d, { source: "rewards.pons", minUsd }), coverage: d.coverage, ...(d.errors?.length && { status: `error: ${d.errors.join("; ")}` }) }; } },
      { id: "rewards.blur_pool", run: async () => ({ findings: F.hfClaims(await get(ctx, "rewards.blur_pool", { address }), { source: "rewards.blur_pool", minUsd }) }) },
      { id: "bridge.blast_usdb", run: async () => ({ findings: F.hfClaims(await get(ctx, "bridge.blast_usdb", { address }), { source: "bridge.blast_usdb", minUsd }) }) },
      { id: "rewards.balancer_rescue", run: async () => ({ findings: F.hfClaims(await get(ctx, "rewards.balancer_rescue", { address }), { source: "rewards.balancer_rescue", minUsd }) }) },
      { id: "bridge.agglayer", run: async () => ({ findings: F.hfClaims(await get(ctx, "bridge.agglayer", { address }), { source: "bridge.agglayer", minUsd }) }) },
      { id: "rewards.plasma_vault", run: async () => ({ findings: F.hfClaims(await get(ctx, "rewards.plasma_vault", { address }), { source: "rewards.plasma_vault", minUsd }) }) },
      { id: "rewards.nucleus_vaults", run: async () => ({ findings: F.hfClaims(await get(ctx, "rewards.nucleus_vaults", { address }), { source: "rewards.nucleus_vaults", minUsd }) }) },
      { id: "rewards.creator_rewards", run: async () => ({ findings: F.hfClaims(await get(ctx, "rewards.creator_rewards", { address }), { source: "rewards.creator_rewards", minUsd }) }) },
      { id: "rewards.dead_dexes", run: async () => ({ findings: F.hfClaims(await get(ctx, "rewards.dead_dexes", { address }), { source: "rewards.dead_dexes", minUsd }) }) },
      { id: "rewards.mooniswap", run: async () => ({ findings: F.hfClaims(await get(ctx, "rewards.mooniswap", { address }), { source: "rewards.mooniswap", minUsd }) }) },
      { id: "rewards.karak_queue", run: async () => ({ findings: F.hfClaims(await get(ctx, "rewards.karak_queue", { address }), { source: "rewards.karak_queue", minUsd }) }) },
      { id: "bridge.k2_claims", run: async () => ({ findings: F.hfClaims(await get(ctx, "bridge.k2_claims", { address }), { source: "bridge.k2_claims", minUsd }) }) },
      { id: "rewards.dot_sale", run: async () => ({ findings: F.hfClaims(await get(ctx, "rewards.dot_sale", { address }), { source: "rewards.dot_sale", minUsd }) }) },
      // sources earlier rounds skipped (forgotten/skipped.mjs): Aave / Compound incentives, Sablier Flow, LlamaPay, Authereum, PinkLock, HoodLock, Klik, Bankr, Alpaca 2.0, MM Finance
      ...Object.keys(SKIPPED_ROUTES).map((id) => ({ id, run: async () => ({ findings: F.hfClaims(await get(ctx, id, { address }), { source: id, minUsd }) }) })),
      { id: "holdings.smart_wallets", run: async () => { const d = await get(ctx, "holdings.smart_wallets", { address }); return { holdings: F.smartWallets(d, { minUsd }), findings: F.smartWalletHints(d, { minUsd }) }; } },
      { id: "airdrop.index", ms: 60000, run: async () => ({ findings: F.airdropIndex(await get(ctx, "airdrop.index", { address })) }) },
      { id: "token.goplus_evm", ms: 15000, after: ["holdings.zerion", "rewards.zerion", ...GOPLUS_FINDINGS], run: async (...outs) => { goplus = await goplusCheck(ctx, outs, { minUsd }); } },
    ], skip);
    // Zerion lists some open Polymarket bets as deposits; the Polymarket source has every one of them
    if (run.sources["rewards.polymarket_redeemable"] === "ok") run.holdings = run.holdings.filter((h) => !(h.protocol === "Polymarket" && h.kind !== "position"));
    // Pendle and Venice read their own contracts and APIs: Zerion's reward rows for them would count twice
    const own = ["rewards.pendle", "rewards.venice"].filter((id) => run.sources[id] === "ok").map((id) => id.split(".")[1]);
    run.findings = run.findings.filter((f) => !(f.source === "rewards.zerion" && own.some((o) => String(f.protocol || "").toLowerCase().includes(o))));
    Object.assign(run, F.dropDirectTwins(run, { failed, zkevmKnown: zkevm.known })); // our contract reads replace Zerion's rows
    if (run.holdings.some((h) => h.kind === "loan" && h.asset === "DIEM" && h.source !== "rewards.venice")) run.holdings = run.holdings.filter((h) => h.source !== "rewards.venice");
    if (zSeen) for (const k of ["holdings", "findings"]) run[k] = run[k].filter((x) => !F.zerionDrops(zSeen, x));
    Object.assign(run, F.dropZerionTwins(run)); // our queue and lock reads replace Zerion's row for the same position
    Object.assign(run, F.dropBalancerTwins(run)); // our Balancer read replaces Zerion's Balancer LP rows
    Object.assign(run, F.dropHfTwins(run)); // hiddenfunds-gap reads (Blur Pool, Zora, dead DEX LPs...) replace Zerion's rows of the same money
    // K2 balances are paid on Ethereum now: bridge.k2_claims knows what was claimed there, the sweep only sees the frozen K2 state
    if (run.sources["bridge.k2_claims"] === "ok") run.findings = run.findings.filter((f) => !(f.source === "holdings.chains" && Number(f.chain_id) === 2410));
    const security = ctx.live("security.approvals") && !skip.has("security.approvals") ? await get(ctx, "security.approvals", { address }) : null;
    const market_quotes = ctx.live("token.market_quote") && !skip.has("token.market_quote") ? await fillMarketGaps(ctx, run) : null;
    if (market_quotes?.priced && ctx.live("token.goplus_evm") && !skip.has("token.goplus_evm")) {
      // These rows had no USD value during the first risk pass. Check them before their estimates enter totals.
      const extra = await Promise.race([goplusCheck(ctx, [run], { minUsd, marketOnly: true }), timeout(15000, "market token risk checks")]).catch(() => ({ reason: "risk check time budget reached" }));
      goplus = { ...goplus, market_fallback: extra };
    }
    return finish({ address, kind: "evm", env, minUsd, run, extra: { deadlines_open: deadlines, ...(goplus && { goplus }), ...(market_quotes && { market_quotes }), ...(security && { security }) } });
  },

  async scanSol(p, ctx) {
    need(p, "address");
    if (!isSolAddr(p.address)) throw { status: 400, error: "address must be a Solana address (use scan.evm or scan.all for 0x)" };
    const address = p.address, minUsd = minUsdOf(p), skip = new Set(String(p.skip || "").split(",").map((s) => s.trim()).filter(Boolean));
    const [env, deadlines] = await Promise.all([feeEnv(ctx, false), ctx.local("deadlines", { open: "1" })]);
    let goplus = null;
    const run = await runSources(ctx, [
      {
        id: "sol.token_accounts", run: async () => {
          const [a, b, min] = await Promise.all([
            get(ctx, "sol.token_accounts", { owner: address }),
            get(ctx, "sol.token_accounts", { owner: address, program_id: TOKEN_2022 }),
            ctx.call("sol.rent_minimum", { bytes: "165" }).then((r) => (r.ok ? Number(r.data.result) : null)).catch(() => null),
          ]);
          return { findings: F.solRent([a, b], { solUsd: env.solUsd, rentMin165: min }) };
        },
      },
      {
        id: "sol.stake_accounts", run: async () => {
          const [st, ep] = await Promise.all([
            get(ctx, "sol.stake_accounts", { owner: address }),
            ctx.call("sol.rent_minimum", {}, { body: rpc("getEpochInfo") }).then((r) => r.data?.result?.epoch ?? null).catch(() => null),
          ]);
          return { findings: F.solStakes(st, { solUsd: env.solUsd, epoch: ep }) };
        },
      },
      { id: "sol.pump_creator_fees", run: async () => ({ findings: F.pumpFees(await get(ctx, "sol.pump_creator_fees", { address }), { solUsd: env.solUsd, address }) }) },
      { id: "holdings.perps_sol", run: async () => { const d = await get(ctx, "holdings.perps_sol", { address }); return { holdings: F.perpsHoldings(d, { minUsd, source: "holdings.perps_sol" }), findings: F.perpsFindings(d, { source: "holdings.perps_sol" }) }; } },
      {
        // no HELIUS_API_KEY: the same rows from the token accounts (Token + Token-2022) and the SOL balance
        id: "sol.assets", live: () => ctx.live("sol.assets") || ctx.live("sol.token_accounts"), run: async () => {
          const keyed = ctx.live("sol.assets");
          const das = keyed ? await walletAssets(ctx, address) : await keylessAssets(ctx, address, env);
          if (!env.solUsd && das?.result?.nativeBalance?.price_per_sol) env.solUsd = das.result.nativeBalance.price_per_sol;
          // Jupiter checks the priced tokens and prices the ones Helius has no price for (Helius only prices the big ones)
          const fungible = (das?.result?.items || []).filter((i) => ["FungibleToken", "FungibleAsset"].includes(i.interface) && Number(i.token_info?.balance) > 0);
          const priced = fungible.filter((i) => (i.token_info?.price_info?.total_price ?? 0) >= minUsd), bare = fungible.filter((i) => i.token_info?.price_info?.total_price == null);
          const mints = [...priced, ...bare].map((i) => i.id);
          const jup = await mintInformation(ctx, mints);
          const { holdings, unpriced } = F.solHoldings(das, jup.items, { minUsd });
          const parts = { assets: das.coverage || { status: "complete", checked: fungible.length }, prices: jup.coverage };
          const incomplete = Object.values(parts).find((c) => c.status === "truncated");
          return { holdings, unpriced, coverage: { status: incomplete ? "truncated" : "complete", ...(incomplete && { reason: incomplete.reason }), parts } };
        },
      },
      { id: "bridge.wormholescan", run: async () => ({ findings: F.wormhole(await get(ctx, "bridge.wormholescan", { address })) }) },
      { id: "sol.leftovers", run: async () => ({ findings: F.solLeftovers(await get(ctx, "sol.leftovers", { address }), { solUsd: env.solUsd }) }) },
      { id: "sol.vesting_streams", run: async () => F.solStreams(await get(ctx, "sol.vesting_streams", { address })) },
      // positions left in dead Solana apps (forgotten/soldead.mjs): Sunny vaults, Friktion volts, Francium lending
      { id: "rewards.sol_dead_apps", run: async () => ({ findings: F.hfClaims(await get(ctx, "rewards.sol_dead_apps", { address }), { source: "rewards.sol_dead_apps", minUsd }) }) },
      // live DeFi positions (holdings) and their unclaimed fees, rewards and wound-down deposits (forgotten/soldefi.mjs):
      // Kamino, MarginFi, Orca, Raydium CLMM, Meteora; a part that failed marks the source failed, the rest still counts
      { id: "sol.defi", run: async () => { const d = await get(ctx, "sol.defi", { address }); return { holdings: F.solDefiHoldings(d, { minUsd }), findings: F.solDefiFindings(d), ...(d.coverage && { coverage: d.coverage }), ...(d?.errors?.length && { status: `error: ${d.errors.join("; ")}` }) }; } },
      { id: "bridge.mayan", run: async () => ({ findings: F.mayan(await get(ctx, "bridge.mayan", { address })) }) },
      { id: "bridge.debridge", run: async () => ({ findings: F.debridge(await get(ctx, "bridge.debridge", { address })) }) },
      { id: "bridge.lifi", run: async () => ({ findings: F.lifi(await get(ctx, "bridge.lifi", { address })) }) },
      { id: "airdrop.jupiter", run: async () => ({ findings: F.jupiterAirdrops(await get(ctx, "airdrop.jupiter", { address })) }) },
      { id: "airdrop.parcl", run: async () => ({ findings: F.parcl(await get(ctx, "airdrop.parcl", { address })) }) },
      { id: "airdrop.streamflow", run: async () => ({ findings: F.streamflow(await get(ctx, "airdrop.streamflow", { address })) }) },
      { id: "token.goplus_sol", ms: 15000, after: ["sol.assets"], run: async (...outs) => { goplus = await goplusCheck(ctx, outs, { solana: true, minUsd }); } },
    ], skip);
    // Jupiter's checker reads some Streamflow airdrops too: keep its row for that token
    const jupMints = new Set(run.findings.filter((f) => f.source === "airdrop.jupiter").map((f) => f.mint));
    run.findings = run.findings.filter((f) => !(f.source === "airdrop.streamflow" && jupMints.has(f.mint)));
    // Jupiter's checker calls the initial Parcl airdrop expired, but that distributor still pays: airdrop.parcl reads all 7
    if (run.sources["airdrop.parcl"] === "ok") run.findings = run.findings.filter((f) => !(f.source === "airdrop.jupiter" && f.mint === PARCL.mint));
    Object.assign(run, F.dropSolDefiTwins(run)); // a Kamino vault share token in the wallet is its sol.defi position
    const market_quotes = ctx.live("token.market_quote") && !skip.has("token.market_quote") ? await fillMarketGaps(ctx, run) : null;
    const rugcheck = ctx.live("token.rugcheck") && !skip.has("token.rugcheck") ? await rugcheckRows(ctx, run) : null;
    return finish({ address, kind: "solana", env, minUsd, run, extra: { deadlines_open: deadlines, ...(goplus && { goplus }), ...(market_quotes && { market_quotes }), ...(rugcheck && { rugcheck }) } });
  },

  async scanAll(p, ctx) {
    need(p, "address");
    // the address kind picks the scan: EVM and Solana here, every other chain in nonevm/ (a Harmony one1 is its 0x twin)
    const k = addressKind(p.address);
    const id = k && (k.kind === "evm" ? "scan.evm" : k.kind === "solana" ? "scan.sol" : NONEVM_CHAINS[k.kind]?.id);
    if (!id) throw notScanned(p.address, k);
    const out = await step(ctx, id, { ...p, address: k.address });
    return k.from ? { ...out, pasted_address: k.from, address_note: k.note } : out;
  },

  // many wallets of one owner in one call: each runs through scan.all (same sources, same shared cache, so the
  // price and market lists are fetched once), WALLETS_CONCURRENCY at a time, inside one time budget
  async scanWallets(p, ctx) {
    const list = walletList(p.addresses ?? p.address);
    const budgetMs = Math.min(WALLETS.budgetS, Number(p.budget_s) > 0 ? Number(p.budget_s) : Infinity) * 1000;
    const end = Date.now() + budgetMs;
    // set when a budget timer fires: a timer can fire a millisecond before Date.now() reaches `end`, so the next
    // wallet must not trust `left` alone
    let over = false;
    const pass = { ...(p.min_usd != null && p.min_usd !== "" && { min_usd: p.min_usd }), ...(p.skip && { skip: p.skip }) };
    const one = async (address) => {
      const left = end - Date.now();
      if (left <= 0 || over) return { address, status: "not_scanned", reason: "the time budget ran out before this wallet started" };
      let timer;
      const late = new Promise((ok) => { timer = setTimeout(() => { over = true; ok(null); }, left); timer.unref?.(); });
      // a scan still running when the budget ends keeps going in the background (it warms the cache), unawaited
      const run = ctx.call("scan.all", { address, ...pass }).catch((e) => ({ ok: false, data: { error: (e && (e.error || e.message)) || String(e) } }));
      const r = await Promise.race([run, late]);
      clearTimeout(timer);
      if (!r) return { address, status: "not_scanned", reason: `not finished within the ${budgetMs / 1000}s time budget: scan it alone with scan.all` };
      if (!r.ok) return { address, status: "failed", reason: String(r.data?.error || `upstream ${r.status}`).slice(0, 200) };
      return { address, status: "scanned", data: r.data };
    };
    const outs = new Array(list.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(WALLETS.concurrency, list.length) }, async () => {
      while (next < list.length) { const k = next++; outs[k] = await one(list[k]); }
    }));
    return mergeWallets(outs, budgetMs);
  },
};

// ---- scan.wallets: address list + merge -------------------------------------------------------------------
const envNum = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);
// max: addresses per call; concurrency: scans at a time (kept low so upstream pacing holds); budgetS: total time
export const WALLETS = { max: envNum("WALLETS_MAX", 10), concurrency: Math.min(3, envNum("WALLETS_CONCURRENCY", 3)), budgetS: envNum("WALLETS_BUDGET_S", 240) };

// "a,b c\nd" or ["a","b"] -> the unique valid addresses in order (any kind scan.all takes; EVM, bech32 and hex compared
// without case, one SS58 account pasted with two network prefixes counted once); a bad or missing list = 400
export function walletList(raw) {
  const items = (Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,;]+/)).map((s) => String(s ?? "").trim()).filter(Boolean);
  if (!items.length) throw { status: 400, error: "missing required param(s)", detail: ["addresses"] };
  const seen = new Set(), out = [], bad = [];
  for (const a of items) {
    const kind = addressKind(a);
    if (!kind || !SCANNED_KINDS.includes(kind.kind)) { bad.push(a.slice(0, 64)); continue; }
    const k = `${kind.kind}:${kind.account || (kind.kind === "evm" ? kind.address.toLowerCase() : kind.address)}`;
    if (!seen.has(k)) { seen.add(k); out.push(a); }
  }
  if (bad.length) throw { status: 400, error: `${bad.length} address${bad.length > 1 ? "es are not valid" : " is not a valid"} ${scannedNames().slice(0, -1).join(", ")} or ${scannedNames().at(-1)} address${bad.length > 1 ? "es" : ""}`, detail: bad };
  if (out.length > WALLETS.max) throw { status: 400, error: `max ${WALLETS.max} addresses per scan.wallets call (got ${out.length})`, detail: `split the list into calls of ${WALLETS.max} or fewer` };
  return out;
}

// per-wallet answers -> one: every finding and holding tagged with its address, totals added up across wallets
const TAIL = (f) => (f.confidence === "low" || f.expired ? 1 : 0), CONF = { high: 0, medium: 1, low: 2 };
function addTotals(into, t) {
  for (const [k, v] of Object.entries(t || {})) {
    if (typeof v === "number") into[k] = Math.round(((into[k] ?? 0) + v) * 100) / 100;
    else if (typeof v === "boolean") into[k] = !!into[k] || v;
    else if (v && typeof v === "object") addTotals((into[k] ||= {}), v);
  }
  return into;
}
export function mergeWallets(outs, budgetMs) {
  const done = outs.filter((o) => o.status === "scanned");
  const totals = F.summarize([], []).totals; // every total at 0, then each scanned wallet's added in
  for (const o of done) addTotals(totals, o.data.totals);
  const findings = done.flatMap((o) => (o.data.findings || []).map((f) => ({ address: o.address, ...f })));
  findings.sort((a, b) => TAIL(a) - TAIL(b) || (b.usd ?? -1) - (a.usd ?? -1) || CONF[a.confidence] - CONF[b.confidence]);
  const holdings = done.flatMap((o) => (o.data.holdings || []).map((h) => ({ address: o.address, ...h })));
  holdings.sort((a, b) => Number(b.verified) - Number(a.verified) || (b.usd ?? 0) - (a.usd ?? 0));
  const failed_sources = done.flatMap((o) => (o.data.failed_sources || []).map((f) => ({ address: o.address, ...f })));
  const truncated_sources = done.flatMap((o) => (o.data.truncated_sources || []).map((f) => ({ address: o.address, ...f })));
  const security = { note: done.find((o) => o.data.security)?.data.security.note, approvals: done.flatMap((o) => (o.data.security?.approvals || []).map((a) => ({ address: o.address, ...a }))), wallets: done.filter((o) => o.data.security).map((o) => ({ address: o.address, coverage: o.data.security.coverage, errors: o.data.security.errors })) };
  const not_scanned = outs.filter((o) => o.status !== "scanned").map(({ address, status, reason }) => ({ address, status, reason }));
  const skipped_for_keys = [];
  for (const n of done.flatMap((o) => o.data.skipped_for_keys || [])) if (!skipped_for_keys.some((x) => x.id === n.id && x.key === n.key && x.why === n.why)) skipped_for_keys.push(n);
  const sourcesFailed = done.some((o) => o.data.partial);
  const partial = sourcesFailed || not_scanned.length > 0;
  totals.partial = partial;
  const why = [
    failed_sources.length && `${failed_sources.length} source${failed_sources.length > 1 ? "s" : ""} failed on ${done.filter((o) => o.data.failed_sources?.length).length} wallet(s) (see failed_sources)`,
    truncated_sources.length && `${truncated_sources.length} source${truncated_sources.length > 1 ? "s" : ""} stopped early (see truncated_sources)`,
    sourcesFailed && !failed_sources.length && !truncated_sources.length && "some sources were incomplete",
    not_scanned.length && `${not_scanned.length} wallet${not_scanned.length > 1 ? "s were" : " was"} not scanned (see not_scanned)`,
  ].filter(Boolean);
  const first = done[0]?.data;
  return {
    addresses: outs.length, scanned: done.length, partial, ...(partial && { warning: `${why.join("; ")}: the totals may be missing money there; retry those later` }),
    totals,
    wallets: outs.map((o) => (o.status === "scanned"
      ? { address: o.address, kind: o.data.kind, status: o.status, partial: !!o.data.partial, totals: o.data.totals, findings: (o.data.findings || []).length, holdings: (o.data.holdings || []).length, sources: o.data.sources, coverage: o.data.coverage, truncated_sources: o.data.truncated_sources || [], failed_sources: o.data.failed_sources || [], market_quotes: o.data.market_quotes, rugcheck: o.data.rugcheck }
      : { address: o.address, status: o.status, reason: o.reason })),
    not_scanned, failed_sources, truncated_sources, skipped_for_keys, findings, ...(security.wallets.length && { security }),
    hidden_below_min_usd: done.reduce((t, o) => t + (o.data.hidden_below_min_usd || 0), 0), spam_hidden: done.reduce((t, o) => t + (o.data.spam_hidden || 0), 0),
    holdings,
    ...(first && { deadlines_open: first.deadlines_open, prices: first.prices }),
    time_budget_s: budgetMs / 1000,
    note: "read-only: nothing here signs or sends anything. Each wallet was scanned like scan.all; totals add up all scanned wallets, every finding and holding names its address. bucket / totals.by_bucket say who must act: you_can_claim, team_must_release, may_not_work",
  };
}
