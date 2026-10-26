// forgotten/bnb.mjs - money left in dead BNB Chain farms: PancakeSwap MasterChef v1, AutoFarm V2, Ellipsis
// LpTokenStaker, Nerve MasterMind, BakeryMaster, Alpaca FairLaunch, plus Alpaca v1 ibTokens and Ellipsis / Nerve pool
// tokens still sitting in the wallet. Every stake is read from the farm contract itself (userInfo per pool id in
// Multicall3 batches) and valued from its own contracts: a Pancake-style LP as its share of getReserves, an Ellipsis /
// Nerve pool token as its share of the pool balances, an Alpaca ibToken as totalToken / totalSupply of the underlying
// (a migrated v1 vault: its share of the Alpaca 2.0 ibTokens it holds), a plain token at its DefiLlama price; usd null
// when nothing prices it.
// Input { address, farms? }: farms = comma list (pancake, autofarm, ellipsis, nerve, bakery, alpaca), default all.
// Each item: { category, chain: "bsc", protocol, asset, token, amount, usd, status, position, contract, pid, value_kind,
// action, how_to_claim, detail }
//   category "unstake_ready"   = a stake to take back (withdraw / emergencyWithdraw / leaveStaking)
//   category "reward"          = a pending reward the farm pays on withdraw (only rows with a price)
//   category "token_migration" = a receipt token in the wallet (ibToken, dead pool token) to redeem for what backs it
//   status "ready"     = the contract reports it and lets the owner take it back
//   status "uncertain" = it is there, but the payout may fail (Alpaca ibUSDC pool, CAKE pool without the SYRUP to
//                        burn, a reward larger than what the farm holds)
//   position "staked" | "wallet"
import { parseAbi } from "viem";
import { isEvmAddr } from "../solana.mjs";
import { multi, prices, trusted, llamaKey, units, big, writeLink, each, ZERO } from "./evm.mjs";

const CHAIN = "bsc";
const C = {
  pancake: "0x73feaa1eE314F8c655E354234017bE2193C9E24E",
  syrup: "0x009cF7bC57584b7998236eff51b98A168DceA9B0",
  cake: "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82",
  autofarm: "0x0895196562C7868C5Be92459FaE7f877ED450452",
  auto: "0xa184088a740c695E156F91f5cC086a06bb78b827",
  ellipsis: "0xcce949De564fE60e7f96C85e55177F8B9E4CF61b",
  nerve: "0x2EBe8CDbCB5fB8564bC45999DAb8DA264E31f24E",
  bakery: "0x20eC291bB8459b6145317E7126532CE7EcE5056f",
  bake: "0xE02dF9e3e622DeBdD69fb838bB799E3F168902c5",
  fairlaunch: "0xA625AB01B08ce023B2a342Dbb12a16f2C8489A8F",
  alpaca: "0x8F0528cE5eF7B51152A59745bEfDD91D97091d2F",
};
// pool counts when the contracts were read (2026-10-20); poolLength() is read first and wins
const KNOWN_LEN = { pancake: 527, autofarm: 714, ellipsis: 12, nerve: 11, bakery: 47, fairlaunch: 30 };
// Ellipsis (Curve fork: coins / balances) and Nerve (Saddle fork: getToken / getTokenBalance) pool token -> pool
const STABLE = {
  "0xaf4de8e872131ae328ce21d909c74705d3aaf452": ["eps", "0x160CAed03795365F3A589f10C379FfA7d75d4E76"], // 3EPS
  "0x373410a99b64b089dfe16f1088526d399252dace": ["eps", "0x556ea0b4c06D043806859c9490072FaadC104b63"], // fusdt3EPS
  "0x2a435ecb3fcc0e316492dc1cdd62d0f189be5640": ["eps", "0x2477fB288c5b4118315714ad3c7Fd7CC69b00bf9"], // btcEPS
  "0x0bc3a8239b0a63e945ea1bd6722ba747b9557e56": ["eps", "0xc6a752948627bECaB5474a10821Df73fF4771a49"], // dai3EPS
  "0x052e566a25ace8934dcc52c41a27b04a7c7eccbe": ["eps", "0x8D7408C2b3154F9f97fc6dd24cd36143908d1E52"], // tusd3EPS
  "0xa2520f3596449105bfe899f3d573c4353917eaf8": ["eps", "0x60E4ED61C6f17972559E86F2125BF8A30f249088"], // pbtcEPS
  "0x143d702bc7bfa46c17129bd751f7c6cf2f1ded79": ["eps", "0xf707Df3e4c70E40c2F26C660338dD0C81ad280f1"], // anybtcEPS
  "0x8339156534e2d7354eed097a6fb4a5820d8d0d27": ["eps", "0x2f8E25C21A17BD9D0C337e1b409e73bc959B41BE"], // usdn3EPS
  "0x151f1611b2e304ded36661f65506f9d7d172beba": ["eps", "0x780de1A0E4613da6b65ceF7F5FB63d14CbDcfB72"], // ust3EPS
  "0xcd5b31fc04d12b9c7e94c5dee2500b4955529aea": ["eps", "0xEdbb3f63C0901bA500E4525Da0c2cbD27Ac8fFdc"], // usdl3EPS
  "0x5781041f9cf18484533f433cb2ea9ad42e117b3a": ["eps", "0xc377e2648E5adD3F1CB51a8B77dBEb63Bd52c874"], // bnbEPS
  "0xf2511b5e4fb0e5e2d123004b672ba14850478c14": ["nrv", "0x1B3771a66ee31180906972580adE9b81AFc5fCDc"], // 3NRV-LP
  "0xd1d5af92c606c6f2ec59d453f57a6fcc188d7db5": ["nrv", "0x6C341938bB75dDe823FAAfe7f446925c66E6270c"], // nrvBTC
  "0x0d283bf16a9bde49cfc48d8dc050af28b71bdd90": ["nrv", "0x146CD24dCc9f4EB224DFd010c5Bf2b0D25aFA9C0"], // nrvETH
  "0x0ff9a504da520b56945ccc02f7d787811d7c9da0": ["nrv", "0x96b849a73db2cc769b4Abe770aAb141aAC9014d6"], // nrvFUSDT (old)
  "0x2e91a0cecf28c5e518bb2e7fdcd9f8e2cd511c10": ["nrv", "0xd0fBF0A224563D5fFc8A57e4fdA6Ae080EbCf3D3"], // nrvFUSDT
  "0x35ce243e0dc9ed77e3c348bb2742095f78e1cb70": ["nrv", "0x2dcCe1586b1664f41C72206900e404Ec3cA130e0"], // nrvUST
};
const ALPACA_STUCK_PIDS = new Set([24]); // ibUSDC: hiddenfunds and Alpaca's own notes say it may not pay out
const RESIDUE = 1000n; // AutoFarm and others leave a few wei of share rounding behind after a full withdraw
const BIG_BATCH = 400; // userInfo reads are cheap: 527 / 714 pools in 2 Multicall3 calls each (publicnode drops bursts)

const lenAbi = parseAbi(["function poolLength() view returns (uint256)"]);
const erc = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)", "function totalSupply() view returns (uint256)"]);
const pancakeAbi = parseAbi(["function userInfo(uint256,address) view returns (uint256 amount, uint256 rewardDebt)", "function poolInfo(uint256) view returns (address lpToken, uint256 allocPoint, uint256 lastRewardBlock, uint256 accCakePerShare)", "function pendingCake(uint256,address) view returns (uint256)"]);
const autoAbi = parseAbi(["function stakedWantTokens(uint256,address) view returns (uint256)", "function poolInfo(uint256) view returns (address want, uint256 allocPoint, uint256 lastRewardBlock, uint256 accAUTOPerShare, address strat)", "function pendingAUTO(uint256,address) view returns (uint256)"]);
const chefAbi = parseAbi(["function userInfo(uint256,address) view returns (uint256 amount, uint256 rewardDebt)", "function poolInfo(uint256) view returns (address lpToken, uint256 allocPoint, uint256 lastRewardTime, uint256 accRewardPerShare)"]);
const bakeryAbi = parseAbi(["function poolAddresses(uint256) view returns (address)", "function poolUserInfoMap(address,address) view returns (uint256 amount, uint256 rewardDebt)", "function pendingBake(address,address) view returns (uint256)"]);
const alpacaAbi = parseAbi(["function userInfo(uint256,address) view returns (uint256 amount, uint256 rewardDebt, uint256 bonusDebt, address fundedBy)", "function poolInfo(uint256) view returns (address stakeToken, uint256 allocPoint, uint256 lastRewardBlock, uint256 accAlpacaPerShare, uint256 accAlpacaPerShareTilBonusEnd)", "function pendingAlpaca(uint256,address) view returns (uint256)"]);
const lpAbi = parseAbi(["function token0() view returns (address)", "function token1() view returns (address)", "function getReserves() view returns (uint112, uint112, uint32)"]);
const ibAbi = parseAbi(["function totalToken() view returns (uint256)", "function token() view returns (address)", "function migrated() view returns (bool)", "function newIbToken() view returns (address)"]);
// Alpaca 2.0 ibToken (ERC-4626) a migrated v1 vault holds for its holders (claimFor moves a holder's share across)
const ib2Abi = parseAbi(["function convertToAssets(uint256) view returns (uint256)", "function asset() view returns (address)"]);
const epsAbi = parseAbi(["function coins(uint256) view returns (address)", "function balances(uint256) view returns (uint256)"]);
const nrvAbi = parseAbi(["function getToken(uint8) view returns (address)", "function getTokenBalance(uint8) view returns (uint256)"]);

const range = (n) => [...Array(n).keys()];
const lc = (a) => String(a).toLowerCase();

// ---- per farm readers: each returns raw positions { protocol, contract, pid, token, raw, status, position, action,
// detail, rewards: [{ token, raw, status }] }
async function pancake(ctx, a, n) {
  const ui = await multi(ctx, CHAIN, range(n).map((i) => ({ to: C.pancake, abi: pancakeAbi, fn: "userInfo", args: [BigInt(i), a] })), { batch: BIG_BATCH });
  const pids = range(n).filter((i) => big(ui[i]?.[0]) > RESIDUE);
  if (!pids.length) return [];
  const more = await multi(ctx, CHAIN, [
    { to: C.cake, abi: erc, fn: "balanceOf", args: [C.syrup] }, { to: C.syrup, abi: erc, fn: "balanceOf", args: [a] },
    ...pids.flatMap((i) => [{ to: C.pancake, abi: pancakeAbi, fn: "poolInfo", args: [BigInt(i)] }, { to: C.pancake, abi: pancakeAbi, fn: "pendingCake", args: [BigInt(i), a] }]),
  ]);
  const syrupCake = big(more[0]), syrupHeld = big(more[1]);
  const pending = pids.map((_, k) => big(more[3 + k * 2]));
  const rewardOk = pending.reduce((t, v) => t + v, 0n) <= syrupCake;
  return pids.map((i, k) => {
    const raw = big(ui[i][0]);
    const cakePool = i === 0;
    return {
      protocol: "PancakeSwap MasterChef v1", contract: C.pancake, pid: i, token: cakePool ? C.cake : more[2 + k * 2]?.[0], raw, position: "staked",
      status: cakePool && syrupHeld < raw ? "uncertain" : "ready",
      action: cakePool ? "unstake CAKE from the old MasterChef v1 pool 0 (leaveStaking(amount))" : `withdraw LP from the old MasterChef v1 pool ${i} (withdraw(${i}, amount) or emergencyWithdraw(${i}))`,
      detail: cakePool
        ? `CAKE staked in the first PancakeSwap farm, which no longer pays rewards${syrupHeld < raw ? "; leaveStaking burns the SYRUP minted on deposit and this wallet holds less than the stake" : ""}`
        : "LP staked in the first PancakeSwap farm (pool has no rewards now); remove the liquidity after withdrawing to get the two tokens",
      rewards: [{ token: C.cake, raw: pending[k], status: rewardOk ? "ready" : "uncertain" }],
    };
  });
}

async function autofarm(ctx, a, n) {
  const st = await multi(ctx, CHAIN, range(n).map((i) => ({ to: C.autofarm, abi: autoAbi, fn: "stakedWantTokens", args: [BigInt(i), a] })), { batch: BIG_BATCH });
  const pids = range(n).filter((i) => big(st[i]) > RESIDUE);
  if (!pids.length) return [];
  const more = await multi(ctx, CHAIN, pids.flatMap((i) => [{ to: C.autofarm, abi: autoAbi, fn: "poolInfo", args: [BigInt(i)] }, { to: C.autofarm, abi: autoAbi, fn: "pendingAUTO", args: [BigInt(i), a] }]));
  return pids.map((i, k) => ({
    protocol: "AutoFarm", contract: C.autofarm, pid: i, token: more[k * 2]?.[0], raw: big(st[i]), position: "staked", status: "ready",
    action: `withdraw from AutoFarm pool ${i} (withdrawAll(${i}) or emergencyWithdraw(${i}))`,
    detail: "deposit left in an AutoFarm V2 vault; the site is gone but the farm contract still pays the want token back",
    rewards: [{ token: C.auto, raw: big(more[k * 2 + 1]), status: "ready" }],
  }));
}

// Ellipsis and Nerve: normal withdraw tries to pay dead rewards, emergencyWithdraw returns the pool tokens; the
// reward is forfeited, so no reward rows. Pool tokens in the wallet are listed too.
async function stableChef(ctx, a, n, which) {
  const to = C[which];
  const name = which === "ellipsis" ? "Ellipsis" : "Nerve";
  const lps = Object.entries(STABLE).filter(([, [k]]) => k === (which === "ellipsis" ? "eps" : "nrv")).map(([lp]) => lp);
  const r = await multi(ctx, CHAIN, [
    ...range(n).flatMap((i) => [{ to, abi: chefAbi, fn: "userInfo", args: [BigInt(i), a] }, { to, abi: chefAbi, fn: "poolInfo", args: [BigInt(i)] }]),
    ...lps.map((lp) => ({ to: lp, abi: erc, fn: "balanceOf", args: [a] })),
  ]);
  const out = [];
  for (const i of range(n)) {
    const raw = big(r[i * 2]?.[0]);
    if (raw <= RESIDUE) continue;
    out.push({
      protocol: name, contract: to, pid: i, token: r[i * 2 + 1]?.[0], raw, position: "staked", status: "ready",
      action: `take the pool tokens out of ${name} pool ${i} (emergencyWithdraw(${i}); plain withdraw reverts on the dead reward)`,
      detail: `${name} farm on BNB Chain is dead but its staking contract still returns the pool tokens; then remove liquidity on the pool contract`, rewards: [],
    });
  }
  lps.forEach((lp, k) => {
    const raw = big(r[n * 2 + k]);
    if (raw <= RESIDUE) return;
    out.push({
      protocol: name, contract: STABLE[lp][1], pid: null, token: lp, raw, position: "wallet", status: "ready",
      action: `remove liquidity from the dead ${name} pool (remove_liquidity / removeLiquidity on the pool contract)`,
      detail: `${name} pool tokens held in the wallet; the pool still pays out its coins`, rewards: [],
    });
  });
  return out;
}

async function bakery(ctx, a, n) {
  const lps = (await multi(ctx, CHAIN, range(n).map((i) => ({ to: C.bakery, abi: bakeryAbi, fn: "poolAddresses", args: [BigInt(i)] })))).map((x) => x || null);
  const live = lps.filter(Boolean);
  const r = await multi(ctx, CHAIN, live.flatMap((lp) => [{ to: C.bakery, abi: bakeryAbi, fn: "poolUserInfoMap", args: [lp, a] }, { to: C.bakery, abi: bakeryAbi, fn: "pendingBake", args: [lp, a] }]));
  return live.flatMap((lp, k) => {
    const raw = big(r[k * 2]?.[0]);
    if (raw <= RESIDUE) return [];
    return [{
      protocol: "BakerySwap", contract: C.bakery, pid: null, token: lp, raw, position: "staked", status: "ready",
      action: `withdraw from BakeryMaster (withdraw(${lp}, amount) or emergencyWithdraw(${lp}))`,
      detail: "LP or BAKE staked in BakerySwap's farm; the site is dead but BakeryMaster still pays it back",
      rewards: [{ token: C.bake, raw: big(r[k * 2 + 1]), status: "ready" }],
    }];
  });
}

async function alpaca(ctx, a, n) {
  const r = await multi(ctx, CHAIN, range(n).flatMap((i) => [{ to: C.fairlaunch, abi: alpacaAbi, fn: "userInfo", args: [BigInt(i), a] }, { to: C.fairlaunch, abi: alpacaAbi, fn: "poolInfo", args: [BigInt(i)] }]));
  const stake = range(n).map((i) => r[i * 2 + 1]?.[0]);
  // a stake the owner can take back: funded by the wallet itself (a vault-funded debt-token stake is the vault's)
  const pids = range(n).filter((i) => big(r[i * 2]?.[0]) > RESIDUE && lc(r[i * 2][3]) === lc(a));
  // v1 ibTokens = stake tokens that answer totalToken(); the wallet's own balance of each
  const uniq = [...new Set(stake.filter(Boolean).map(lc))];
  const more = await multi(ctx, CHAIN, [
    ...uniq.flatMap((t) => [{ to: t, abi: ibAbi, fn: "totalToken" }, { to: t, abi: erc, fn: "balanceOf", args: [a] }]),
    ...pids.map((i) => ({ to: C.fairlaunch, abi: alpacaAbi, fn: "pendingAlpaca", args: [BigInt(i), a] })),
  ]);
  const out = pids.map((i, k) => ({
    protocol: "Alpaca Finance", contract: C.fairlaunch, pid: i, token: stake[i], raw: big(r[i * 2][0]), position: "staked",
    status: ALPACA_STUCK_PIDS.has(i) ? "uncertain" : "ready",
    action: `withdraw from Alpaca FairLaunch pool ${i} (withdrawAll(your address, ${i}) or emergencyWithdraw(${i})), then withdraw(shares) on the ibToken vault`,
    detail: `ibTokens staked in Alpaca's old FairLaunch farm; the app is gone but the contract lets the funder take them out${ALPACA_STUCK_PIDS.has(i) ? "; the ibUSDC pool may not pay out" : ""}`,
    rewards: [{ token: C.alpaca, raw: big(more[uniq.length * 2 + k]), status: "ready" }],
  }));
  uniq.forEach((t, k) => {
    const raw = big(more[k * 2 + 1]);
    if (more[k * 2] == null || raw <= RESIDUE) return;
    out.push({
      protocol: "Alpaca Finance", contract: t, pid: null, token: t, raw, position: "wallet", status: "ready",
      action: "redeem the Alpaca v1 ibToken for its underlying token (withdraw(shares) on the ibToken vault)",
      detail: "Alpaca v1 lending receipt held in the wallet; the vault still pays out the underlying token", rewards: [],
    });
  });
  return out;
}

// ---- valuation: usd per whole token for every staked / held token and reward token
async function valuer(ctx, tokens) {
  const list = [...new Set(tokens.filter(Boolean).map(lc))];
  const probe = await multi(ctx, CHAIN, list.flatMap((t) => [
    { to: t, abi: erc, fn: "decimals" }, { to: t, abi: erc, fn: "symbol" }, { to: t, abi: erc, fn: "totalSupply" },
    { to: t, abi: lpAbi, fn: "token0" }, { to: t, abi: lpAbi, fn: "token1" }, { to: t, abi: lpAbi, fn: "getReserves" },
    { to: t, abi: ibAbi, fn: "totalToken" }, { to: t, abi: ibAbi, fn: "token" }, { to: t, abi: ibAbi, fn: "migrated" }, { to: t, abi: ibAbi, fn: "newIbToken" },
  ]));
  const info = new Map(list.map((t, k) => {
    const [dec, sym, ts, t0, t1, res, tt, und, migrated, nib] = probe.slice(k * 10, k * 10 + 10);
    return [t, { decimals: dec == null ? 18 : Number(dec), symbol: sym || null, ts: big(ts), t0, t1, res, tt, und, nib: migrated === true && nib ? nib : null }];
  }));
  // migrated Alpaca v1 vaults (ibBUSD, ibETH, ibBTCB, ibUSDC): withdraw reverts "migrated"; a v1 share is worth its
  // part of the Alpaca 2.0 ibTokens the vault holds, each worth convertToAssets of the underlying
  const mig = [...info].filter(([, i]) => i.nib);
  const mr = mig.length ? await multi(ctx, CHAIN, mig.flatMap(([t, i]) => [
    { to: i.nib, abi: erc, fn: "balanceOf", args: [t] }, { to: i.nib, abi: ib2Abi, fn: "convertToAssets", args: [10n ** BigInt(i.decimals)] }, { to: i.nib, abi: ib2Abi, fn: "asset" },
  ])) : [];
  mig.forEach(([, i], k) => { i.m = { held: big(mr[k * 3]), perShare: big(mr[k * 3 + 1]), asset: mr[k * 3 + 2] }; });
  // stable pools: the ones held, then any base pool a metapool holds (3EPS, btcEPS, 3NRV), at most 3 rounds
  const pools = new Map();
  for (let todo = list.filter((t) => STABLE[t]), round = 0; todo.length && round < 3; round++) {
    const sp = await multi(ctx, CHAIN, todo.flatMap((lp) => {
      const [kind, pool] = STABLE[lp];
      return [{ to: lp, abi: erc, fn: "totalSupply" }, ...range(4).flatMap((i) => kind === "eps"
        ? [{ to: pool, abi: epsAbi, fn: "coins", args: [BigInt(i)] }, { to: pool, abi: epsAbi, fn: "balances", args: [BigInt(i)] }]
        : [{ to: pool, abi: nrvAbi, fn: "getToken", args: [i] }, { to: pool, abi: nrvAbi, fn: "getTokenBalance", args: [i] }])];
    }));
    todo.forEach((lp, k) => {
      const row = sp.slice(k * 9, k * 9 + 9);
      pools.set(lp, { ts: big(row[0]), coins: range(4).map((i) => row[1 + i * 2] && { token: lc(row[1 + i * 2]), bal: big(row[2 + i * 2]) }).filter(Boolean) });
    });
    todo = [...new Set([...pools.values()].flatMap((p) => p.coins.map((c) => c.token)).filter((t) => STABLE[t] && !pools.has(t)))];
  }
  const leaves = new Set();
  for (const [t, i] of info) {
    leaves.add(t);
    if (i.t0 && i.t1 && i.res) { leaves.add(lc(i.t0)); leaves.add(lc(i.t1)); }
    if (i.tt != null && i.und) leaves.add(lc(i.m?.asset || i.und));
  }
  for (const p of pools.values()) for (const c of p.coins) if (!STABLE[c.token]) leaves.add(c.token);
  const px = await prices(ctx, [...leaves].sort().map((t) => llamaKey(CHAIN, t)));
  const llama = (t) => trusted(px.get(lc(llamaKey(CHAIN, t))));
  const memo = new Map();
  const stableUsd = (lp, depth = 0) => {
    if (memo.has(lp)) return memo.get(lp);
    const p = pools.get(lp);
    let usd = null;
    if (p && p.ts > 0n && depth < 3) {
      let sum = 0, any = false;
      for (const c of p.coins) {
        const each = STABLE[c.token] ? stableUsd(c.token, depth + 1) : llama(c.token)?.price;
        const dec = STABLE[c.token] ? 18 : llama(c.token)?.decimals;
        if (each == null || dec == null) continue;
        sum += units(c.bal, dec) * each;
        any = true;
      }
      usd = any ? sum / units(p.ts, 18) : null;
    }
    memo.set(lp, usd);
    return usd;
  };
  const out = new Map();
  for (const [t, i] of info) {
    let usd = null, kind = "token", symbol = i.symbol;
    if (STABLE[t]) { usd = stableUsd(t); kind = "stable_lp"; }
    else if (i.t0 && i.t1 && i.res && i.ts > 0n) {
      kind = "lp";
      const s0 = llama(i.t0), s1 = llama(i.t1);
      const v0 = s0 ? units(i.res[0], s0.decimals) * s0.price : null, v1 = s1 ? units(i.res[1], s1.decimals) * s1.price : null;
      const tvl = v0 != null && v1 != null ? v0 + v1 : v0 != null ? 2 * v0 : v1 != null ? 2 * v1 : null;
      usd = tvl == null ? null : tvl / units(i.ts, i.decimals);
      if (s0?.symbol && s1?.symbol) symbol = `${s0.symbol}-${s1.symbol} ${symbol || "LP"}`;
    } else if (i.m && i.m.asset && i.ts > 0n) {
      kind = "ibtoken_migrated";
      const u = llama(i.m.asset);
      usd = u ? (Number(i.m.held) / Number(i.ts)) * units(i.m.perShare, i.decimals) * u.price : null;
    } else if (i.tt != null && i.und && i.ts > 0n) {
      kind = "ibtoken";
      const u = llama(i.und);
      usd = u ? (Number(i.tt) / Number(i.ts)) * u.price : null;
    } else usd = llama(t)?.price ?? null;
    out.set(t, { usd, decimals: i.decimals, symbol: symbol || llama(t)?.symbol || null, kind });
  }
  return out;
}

const r2 = (v) => (v == null ? null : Math.round(v * 100) / 100);

const FARMS = ["pancake", "autofarm", "ellipsis", "nerve", "bakery", "alpaca"];
const LEN_OF = { pancake: "pancake", autofarm: "autofarm", ellipsis: "ellipsis", nerve: "nerve", bakery: "bakery", alpaca: "fairlaunch" };

// p.farms (optional): comma list of farms to read, default all; MasterChef v1 + AutoFarm alone are ~1,240 userInfo reads
export async function bnbFarms(p, ctx) {
  if (p?.address == null || p.address === "") throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
  const a = p.address;
  const farms = p.farms ? String(p.farms).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean) : FARMS;
  const bad = farms.filter((f) => !FARMS.includes(f));
  if (bad.length) throw { status: 400, error: `unknown farm(s): ${bad.join(", ")}`, detail: FARMS };
  const names = farms.map((f) => LEN_OF[f]);
  const lens = await multi(ctx, CHAIN, names.map((k) => ({ to: C[k], abi: lenAbi, fn: "poolLength" }))).catch(() => []);
  const len = Object.fromEntries(names.map((k, i) => [k, lens[i] != null ? Number(lens[i]) : KNOWN_LEN[k]]));
  const readers = {
    pancake: () => pancake(ctx, a, len.pancake),
    autofarm: () => autofarm(ctx, a, len.autofarm),
    ellipsis: () => stableChef(ctx, a, len.ellipsis, "ellipsis"),
    nerve: () => stableChef(ctx, a, len.nerve, "nerve"),
    bakery: () => bakery(ctx, a, len.bakery),
    alpaca: () => alpaca(ctx, a, len.fairlaunch),
  };
  const read = await each(Object.fromEntries(farms.map((f) => [f, readers[f]])));
  const pos = read.items, errors = [...read.errors];
  if (!pos.length) return { items: [], errors };
  const val = await valuer(ctx, pos.flatMap((x) => [x.token, ...x.rewards.filter((w) => w.raw > 0n).map((w) => w.token)])).catch((e) => {
    errors.push(`prices: ${String(e?.error || e?.message || e).slice(0, 120)}`);
    return new Map();
  });
  const items = [];
  for (const x of pos) {
    const v = val.get(lc(x.token || ZERO)) || {};
    const amount = units(x.raw, v.decimals ?? 18);
    // a migrated Alpaca v1 vault pays through claimFor into Alpaca 2.0, not through withdraw(shares)
    const migrated = v.kind === "ibtoken_migrated";
    const claim = "claimFor(your address) on the v1 ibToken (the vault moved to Alpaca 2.0: your share arrives as new ibTokens staked for you, then unstakeAndWithdraw on app.alpacafinance.org)";
    items.push({
      category: x.position === "wallet" ? "token_migration" : "unstake_ready", chain: CHAIN, protocol: x.protocol, asset: v.symbol || "LP", token: x.token,
      amount, usd: v.usd == null ? null : r2(amount * v.usd), status: x.status, position: x.position, contract: x.contract, pid: x.pid, value_kind: v.kind || null,
      action: !migrated ? x.action : x.position === "wallet" ? `call ${claim}` : x.action.replace(/withdraw\(shares\) on the ibToken vault$/, claim),
      how_to_claim: writeLink(CHAIN, x.contract), detail: migrated ? `${x.detail}; this v1 vault was migrated to Alpaca 2.0, so its plain withdraw reverts and claimFor pays instead` : x.detail,
    });
    for (const w of x.rewards) {
      const rv = val.get(lc(w.token));
      if (!(w.raw > 0n) || rv?.usd == null) continue; // a reward row needs a price
      const amt = units(w.raw, rv.decimals);
      items.push({
        category: "reward", chain: CHAIN, protocol: x.protocol, asset: rv.symbol, token: w.token, amount: amt, usd: r2(amt * rv.usd),
        status: w.status, position: "staked", contract: x.contract, pid: x.pid, value_kind: rv.kind,
        action: `${x.protocol} pays the pending ${rv.symbol} reward with the withdraw (withdraw, not emergencyWithdraw)`,
        how_to_claim: writeLink(CHAIN, x.contract), detail: `reward accrued on ${x.pid == null ? "the stake" : `pool ${x.pid}`} and never harvested`,
      });
    }
  }
  return { items: items.sort((m, n) => (n.usd ?? 0) - (m.usd ?? 0)), errors };
}
