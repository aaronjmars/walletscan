// forgotten/lrt.mjs - liquid (re)staking withdrawal queues on Ethereum: requests a wallet made to turn an LST/LRT back
// into ETH that sit finished and unclaimed, or still wait in the queue. One reader per protocol (Kelp, Swell swETH +
// rswETH, Stader, Frax v1, Mantle mETH, Puffer, Renzo, Liquid Collective, ether.fi), each read straight from the
// protocol's own queue contract. Claimed requests are dropped here.
// Each item: { category: "unstake_ready", chain, protocol, asset, token, amount, usd, status, id, action, how_to_claim,
// detail, ready_at?, eta? }
//   status "ready"   = the contract would pay it out now
//   status "pending" = still in the queue; ready_at (ISO) = the only gate left is that time (Renzo cooldown, Frax
//                      maturity), so the normalizer turns it ready once the clock passes it; eta (ISO) = a rough
//                      earliest time from the protocol's own delay (Kelp, Mantle), not a gate
import { encodeAbiParameters, keccak256, parseAbi, decodeEventLog } from "viem";
import { isEvmAddr } from "../solana.mjs";
import { read, multi, logs, topicAddr, prices, priceOf, llamaKey, units, big, each, rpcCall, ZERO } from "./evm.mjs";

const CHAIN = "ethereum";
const EEE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const STETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";
const ETHX = "0xA35b1B31Ce002FBF2058D22F30f95D405200A15b";
const LSETH = "0x8c1BEd5b9a0928467c9B1341Da1D7BD5e10b6549";
const C = {
  kelp: "0x62De59c08eB5dAE4b7E6F7a8cAd3006d6965ec16",
  swexit: "0x48C11b86807627AF70a34662D4865cF854251663",
  rswexit: "0x58749C46Ffe97e4d79508a2C781C440f4756f064",
  stader: "0x9F0491B32DBce587c50c4C43AB303b06478193A7",
  frax: "0x82bA8da44Cd5261762e629dd5c605b17715727bd",
  mantle: "0x38fDF7b489316e03eD8754ad339cb5c4483FDcf9",
  puffer: "0xDdA0483184E75a5579ef9635ED14BacCf9d50283",
  renzo: "0x5efc9D10E42FB517456f4ac41EB5e2eBe42C8918",
  lc: "0x080b3a41390b357Ad7e8097644d1DEDf57AD3375",
  etherfi: "0x7d5706f6ef3F89B3951E23e557CDFBC3239D4E2c",
};
const UI = {
  Kelp: "https://kerneldao.com/kelp/withdraw", Swell: "https://app.swellnetwork.io", Stader: "https://www.staderlabs.com/eth/",
  Frax: "https://app.frax.finance/frxeth/redeem", Mantle: "https://meth.mantle.xyz", Puffer: "https://app.puffer.fi",
  Renzo: "https://app.renzoprotocol.com", "Liquid Collective": "https://liquidcollective.io", "ether.fi": "https://app.ether.fi",
};
// the contract call that pays a finished request out (what the protocol's withdraw page sends)
const CLAIM = {
  Kelp: "completeWithdrawal", Swell: "finalizeWithdrawal(tokenId)", Stader: "claim(requestId)", Frax: "burnRedemptionTicketNft(nftId)", Mantle: "claimUnstakeRequest(id)",
  Puffer: "completeQueuedWithdrawal(index)", Renzo: "claim(index)", "Liquid Collective": "claimRedeemRequests", "ether.fi": "claimWithdraw(tokenId)",
};

const nftAbi = parseAbi(["function balanceOf(address) view returns (uint256)", "function tokenOfOwnerByIndex(address,uint256) view returns (uint256)", "function ownerOf(uint256) view returns (address)"]);
const kelpAbi = parseAbi([
  "function userAssociatedNonces(address,address) view returns (uint128 _begin, uint128 _end)",
  "function getUserWithdrawalRequest(address,address,uint256) view returns (uint256 rsETHAmount, uint256 expectedAssetAmount, uint256 withdrawalStartBlock, uint256 userNonce)",
  "function nextLockedNonce(address) view returns (uint256)", "function withdrawalDelayBlocks() view returns (uint256)",
]);
const swAbi = parseAbi(["function withdrawalRequests(uint256) view returns (uint256 amount, uint256 lastTokenIdProcessed, uint256 rateWhenCreated)", "function getProcessedRateForTokenId(uint256) view returns (bool isProcessed, uint256 processedRate)"]);
const staderAbi = parseAbi(["function getRequestIdsByUser(address) view returns (uint256[])", "function nextRequestIdToFinalize() view returns (uint256)", "function userWithdrawRequests(uint256) view returns (address owner, uint256 ethXAmount, uint256 ethExpected, uint256 ethFinalized, uint256 requestBlock)"]);
const fraxAbi = parseAbi(["function nftInformation(uint256) view returns (bool hasBeenRedeemed, uint64 maturity, uint120 amount, uint64 earlyExitFee)"]);
const mantleAbi = parseAbi([
  "function requestByID(uint256) view returns ((uint64 blockNumber, address requester, uint128 id, uint128 mETHLocked, uint128 ethRequested, uint128 cumulativeETHRequested))",
  "function requestInfo(uint256) view returns (bool, uint256)", "function numberOfBlocksToFinalize() view returns (uint256)",
]);
const pufferAbi = parseAbi([
  "function getWithdrawal(uint256) view returns ((uint128 pufETHAmount, uint128 pufETHToETHExchangeRate, address recipient))",
  "function getBatch(uint256) view returns ((uint64 pufETHToETHExchangeRate, uint88 toBurn, uint96 toTransfer, uint128 withdrawalsClaimed, uint128 amountClaimed))",
  "function getFinalizedWithdrawalBatch() view returns (uint256)", "function BATCH_SIZE() view returns (uint256)",
]);
const renzoAbi = parseAbi([
  "function getOutstandingWithdrawRequests(address) view returns (uint256)",
  "function withdrawRequests(address,uint256) view returns (address collateralToken, uint256 withdrawRequestID, uint256 amountToRedeem, uint256 ezETHLocked, uint256 createdAt)",
  "function coolDownPeriod() view returns (uint256)", "function riskOracleMiddleware() view returns (address)", "function withdrawCooldownPeriod() view returns (uint256)",
  "function withdrawQueued(bytes32) view returns (bool queued, uint256 fillAt)", "function ethWithdrawQueue() view returns (uint256 queuedWithdrawToFill, uint256 queuedWithdrawFilled)",
  "function erc20WithdrawQueue(address) view returns (uint256 queuedWithdrawToFill, uint256 queuedWithdrawFilled)",
]);
const lcAbi = parseAbi([
  "event RequestedRedeem(address indexed recipient, uint256 height, uint256 amount, uint256 maxRedeemableEth, uint32 id)",
  "function resolveRedeemRequests(uint32[]) view returns (int64[])",
  "function getRedeemRequestDetails(uint32) view returns ((uint256 amount, uint256 maxRedeemableEth, address recipient, uint256 height, address initiator))",
  "function getWithdrawalEventDetails(uint32) view returns ((uint256 amount, uint256 withdrawnEth, uint256 height))", "function getWithdrawalEventCount() view returns (uint256)",
]);
const efAbi = parseAbi(["function getRequest(uint256) view returns ((uint96 amountOfEEth, uint96 shareOfEEth, bool isValid, uint32 feeGwei))", "function isFinalized(uint256) view returns (bool)", "function getClaimableAmount(uint256) view returns (uint256)"]);

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ev = (sig) => keccak256(new TextEncoder().encode(sig));
const iso = (sec) => new Date(Number(sec) * 1000).toISOString();
const lc = (a) => String(a).toLowerCase();
const row = (protocol, asset, token, raw, status, id, extra = {}, decimals = 18) => ({
  category: "unstake_ready", chain: CHAIN, protocol, asset, token, amount: units(raw, decimals), usd: null, status, id: String(id),
  action: status === "ready" ? `claim it: ${CLAIM[protocol]}` : extra.ready_at ? `claimable from ${extra.ready_at.slice(0, 10)}: ${CLAIM[protocol]}` : `wait for ${protocol} to finalize it, then ${CLAIM[protocol]}`,
  how_to_claim: UI[protocol], ...extra,
});

// NFT ids the wallet received (mints and transfers in, from Transfer logs) that it still owns
async function ownedFromLogs(ctx, contract, a) {
  const ids = [...new Set((await logs(ctx, { address: contract, topics: [TRANSFER, null, topicAddr(a)] })).map((l) => big(l.topics[3])))];
  const owners = await multi(ctx, CHAIN, ids.map((id) => ({ to: contract, abi: nftAbi, fn: "ownerOf", args: [id] })));
  return ids.filter((_, i) => owners[i] && lc(owners[i]) === lc(a));
}
// latest block number + time, for eta estimates from block delays (12 s slots)
const head = async (ctx) => {
  const b = await rpcCall(ctx, CHAIN, "eth_getBlockByNumber", ["latest", false]);
  return { number: Number(BigInt(b.number)), time: Number(BigInt(b.timestamp)) };
};
// { eta } while the protocol's own delay still runs, {} once it passed (then the wait is on the protocol, no estimate)
const etaOf = (h, block) => (block > h.number ? { eta: iso(h.time + (block - h.number) * 12) } : {});

const READERS = {
  // Kelp: per asset, the user's request nonces; unlocked (nonce < nextLockedNonce) = completeWithdrawal pays now
  async kelp(ctx, a) {
    const assets = [[EEE, "ETH", ZERO], [STETH, "stETH", STETH], [ETHX, "ETHx", ETHX]];
    const first = await multi(ctx, CHAIN, [
      ...assets.map(([t]) => ({ to: C.kelp, abi: kelpAbi, fn: "userAssociatedNonces", args: [t, a] })),
      ...assets.map(([t]) => ({ to: C.kelp, abi: kelpAbi, fn: "nextLockedNonce", args: [t] })),
      { to: C.kelp, abi: kelpAbi, fn: "withdrawalDelayBlocks" },
    ]);
    const nonces = first.slice(0, 3), locked = first.slice(3, 6), delay = first[6] ?? 0n;
    if (first[3] == null) throw { error: "Kelp queue reads failed" };
    const calls = [];
    assets.forEach(([t], i) => { const n = nonces[i] ? Number(nonces[i][1] - nonces[i][0]) : 0; for (let k = 0; k < n; k++) calls.push({ i, to: C.kelp, abi: kelpAbi, fn: "getUserWithdrawalRequest", args: [t, a, BigInt(k)] }); });
    if (!calls.length) return [];
    const reqs = await multi(ctx, CHAIN, calls);
    const h = reqs.some((r, j) => r && !(locked[calls[j].i] != null && r[3] < locked[calls[j].i])) ? await head(ctx) : null;
    return reqs.map((r, j) => {
      if (!r) return null;
      const [rsEth, expected, start, nonce] = r, [, asset, token] = assets[calls[j].i];
      const ready = locked[calls[j].i] != null && nonce < locked[calls[j].i];
      return row("Kelp", asset, token, expected, ready ? "ready" : "pending", nonce, {
        ...(!ready && etaOf(h, Number(start + delay))), detail: `rsETH withdrawal nonce ${nonce} (${units(rsEth).toFixed(4)} rsETH)${ready ? ", unlocked by Kelp" : ", waiting for Kelp to unlock it"}`,
      });
    });
  },

  // Swell swEXIT / rswEXIT NFTs: processed = finalizeWithdrawal pays amount x min(rate at request, processed rate)
  async swell(ctx, a) {
    const exits = [[C.swexit, "swETH"], [C.rswexit, "rswETH"]];
    const bal = await multi(ctx, CHAIN, exits.map(([to]) => ({ to, abi: nftAbi, fn: "balanceOf", args: [a] })));
    const idCalls = exits.flatMap(([to, lst], e) => Array.from({ length: Number(bal[e] || 0n) }, (_, i) => ({ to, lst, abi: nftAbi, fn: "tokenOfOwnerByIndex", args: [a, BigInt(i)] })));
    if (!idCalls.length) return [];
    const nfts = (await multi(ctx, CHAIN, idCalls)).map((id, k) => id != null && { id, to: idCalls[k].to, lst: idCalls[k].lst }).filter(Boolean);
    const res = await multi(ctx, CHAIN, nfts.flatMap(({ id, to }) => [{ to, abi: swAbi, fn: "withdrawalRequests", args: [id] }, { to, abi: swAbi, fn: "getProcessedRateForTokenId", args: [id] }]));
    return nfts.map(({ id, lst }, i) => {
      const req = res[2 * i], pr = res[2 * i + 1];
      if (!req || !pr) return null;
      const [amount, , rateWhenCreated] = req, [isProcessed, processedRate] = pr;
      const rate = isProcessed && processedRate < rateWhenCreated ? processedRate : rateWhenCreated;
      return row("Swell", "ETH", ZERO, (amount * rate) / 10n ** 18n, isProcessed ? "ready" : "pending", id, {
        detail: `${lst} withdrawal NFT ${id} (${units(amount).toFixed(4)} ${lst})${isProcessed ? ", processed by Swell: finalize it" : ", not processed yet"}`,
      });
    });
  },

  // Stader: open request ids of the owner; id < nextRequestIdToFinalize = claim pays ethFinalized
  async stader(ctx, a) {
    const [ids, next] = await multi(ctx, CHAIN, [{ to: C.stader, abi: staderAbi, fn: "getRequestIdsByUser", args: [a] }, { to: C.stader, abi: staderAbi, fn: "nextRequestIdToFinalize" }]);
    if (!ids || next == null) throw { error: "Stader queue reads failed" };
    if (!ids.length) return [];
    const reqs = await multi(ctx, CHAIN, ids.map((id) => ({ to: C.stader, abi: staderAbi, fn: "userWithdrawRequests", args: [id] })));
    return ids.map((id, i) => {
      const r = reqs[i];
      if (!r || r[2] === 0n || lc(r[0]) !== lc(a)) return null;
      const ready = id < next;
      return row("Stader", "ETH", ZERO, ready ? r[3] : r[2], ready ? "ready" : "pending", id, { detail: `ETHx withdrawal request ${id} (${units(r[1]).toFixed(4)} ETHx)${ready ? ", finalized by Stader" : ", not finalized yet"}` });
    });
  },

  // Frax v1 FraxEtherRedemptionQueue NFTs (found through Transfer logs): not redeemed; ready once maturity passes.
  // The queue may hold less ETH than it owes, so its ETH balance goes in the detail.
  async frax(ctx, a) {
    const ids = await ownedFromLogs(ctx, C.frax, a);
    if (!ids.length) return [];
    const [info, bal] = await Promise.all([multi(ctx, CHAIN, ids.map((id) => ({ to: C.frax, abi: fraxAbi, fn: "nftInformation", args: [id] }))), rpcCall(ctx, CHAIN, "eth_getBalance", [C.frax, "latest"])]);
    return ids.map((id, i) => {
      const r = info[i];
      if (!r || r[0]) return null;
      return row("Frax", "ETH", ZERO, r[2], "pending", id, { ready_at: iso(r[1]), detail: `frxETH redemption ticket NFT ${id}, matures ${iso(r[1]).slice(0, 10)}; the queue holds ${units(bal).toFixed(2)} ETH` });
    });
  },

  // Mantle mETH: UnstakeRequestCreated logs by requester; requester zeroed = claimed; finalized and fully funded = ready
  async mantle(ctx, a) {
    const ids = [...new Set((await logs(ctx, { address: C.mantle, topics: [ev("UnstakeRequestCreated(uint256,address,uint256,uint256,uint256,uint256)"), null, topicAddr(a)] })).map((l) => big(l.topics[1])))];
    if (!ids.length) return [];
    const res = await multi(ctx, CHAIN, [{ to: C.mantle, abi: mantleAbi, fn: "numberOfBlocksToFinalize" }, ...ids.flatMap((id) => [{ to: C.mantle, abi: mantleAbi, fn: "requestByID", args: [id] }, { to: C.mantle, abi: mantleAbi, fn: "requestInfo", args: [id] }])]);
    const blocks = res.shift() ?? 0n;
    const open = ids.map((id, i) => [id, res[2 * i], res[2 * i + 1]]).filter(([, r, inf]) => r && inf && lc(r.requester) === lc(a));
    if (!open.length) return [];
    const h = open.some(([, r, inf]) => !(inf[0] && inf[1] >= r.ethRequested)) ? await head(ctx) : null;
    return open.map(([id, r, [fin, claimable]]) => {
      const ready = fin && claimable >= r.ethRequested;
      return row("Mantle", "ETH", ZERO, r.ethRequested, ready ? "ready" : "pending", id, {
        ...(!ready && etaOf(h, Number(r.blockNumber + blocks))), detail: `mETH unstake request ${id} (${units(r.mETHLocked).toFixed(4)} mETH)${ready ? ", finalized and funded" : fin ? ", finalized, waiting for funds" : ", not finalized yet"}`,
      });
    });
  },

  // Puffer: WithdrawalRequested logs by recipient; recipient zeroed = completed; batch <= finalized batch = ready
  async puffer(ctx, a) {
    const idx = [...new Set((await logs(ctx, { address: C.puffer, topics: [ev("WithdrawalRequested(uint256,uint256,uint256,address)"), null, null, topicAddr(a)] })).map((l) => big(l.topics[1])))];
    if (!idx.length) return [];
    const res = await multi(ctx, CHAIN, [
      { to: C.puffer, abi: pufferAbi, fn: "getFinalizedWithdrawalBatch" }, { to: C.puffer, abi: pufferAbi, fn: "BATCH_SIZE" },
      ...idx.map((i) => ({ to: C.puffer, abi: pufferAbi, fn: "getWithdrawal", args: [i] })),
    ]);
    const [fin, size] = res, ws = res.slice(2);
    if (fin == null || !size) throw { error: "Puffer batch reads failed" };
    const open = idx.map((i, k) => [i, ws[k]]).filter(([, w]) => w && w.recipient !== ZERO && lc(w.recipient) === lc(a));
    if (!open.length) return [];
    const batches = [...new Set(open.map(([i]) => i / size))];
    const bRes = await multi(ctx, CHAIN, batches.map((b) => ({ to: C.puffer, abi: pufferAbi, fn: "getBatch", args: [b] })));
    const rateOf = new Map(batches.map((b, k) => [b, bRes[k] ? BigInt(bRes[k].pufETHToETHExchangeRate) : 0n]));
    return open.map(([i, w]) => {
      const b = i / size, ready = b <= fin, br = rateOf.get(b);
      const rate = ready && br && br < w.pufETHToETHExchangeRate ? br : w.pufETHToETHExchangeRate;
      return row("Puffer", "ETH", ZERO, (w.pufETHAmount * rate) / 10n ** 18n, ready ? "ready" : "pending", i, { detail: `pufETH withdrawal ${i} in batch ${b} (${units(w.pufETHAmount).toFixed(4)} pufETH)${ready ? ", batch finalized" : `, batch not finalized yet (finalized up to ${fin})`}` });
    });
  },

  // Renzo: open requests of the user; a request still waiting in the fill queue is pending, else it is ready once the
  // cooldown (the larger of the queue's and the risk oracle's) has passed since createdAt
  async renzo(ctx, a) {
    const n = Number(await read(ctx, CHAIN, C.renzo, renzoAbi, "getOutstandingWithdrawRequests", [a]));
    if (!n) return [];
    const res = await multi(ctx, CHAIN, [
      { to: C.renzo, abi: renzoAbi, fn: "coolDownPeriod" }, { to: C.renzo, abi: renzoAbi, fn: "riskOracleMiddleware" }, { to: C.renzo, abi: renzoAbi, fn: "ethWithdrawQueue" },
      ...Array.from({ length: n }, (_, i) => ({ to: C.renzo, abi: renzoAbi, fn: "withdrawRequests", args: [a, BigInt(i)] })),
    ]);
    const [cd, oracle, ethQ] = res, reqs = res.slice(3);
    if (cd == null || !ethQ) throw { error: "Renzo queue reads failed" };
    const riskCd = !oracle || oracle === ZERO ? 0n : await read(ctx, CHAIN, oracle, renzoAbi, "withdrawCooldownPeriod").catch(() => 0n);
    const cooldown = riskCd > cd ? riskCd : cd;
    const open = reqs.filter(Boolean);
    const hashes = open.map(([token, id, amt, ez, at]) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "address" }], [token, id, amt, ez, at, a])));
    const erc20 = [...new Set(open.map(([t]) => t).filter((t) => lc(t) !== lc(EEE)))];
    const [queued, qs] = await Promise.all([
      multi(ctx, CHAIN, hashes.map((x) => ({ to: C.renzo, abi: renzoAbi, fn: "withdrawQueued", args: [x] }))),
      multi(ctx, CHAIN, erc20.map((t) => ({ to: C.renzo, abi: renzoAbi, fn: "erc20WithdrawQueue", args: [t] }))),
    ]);
    const filled = new Map([[lc(EEE), ethQ[1]], ...erc20.map((t, k) => [lc(t), qs[k]?.[1] ?? 0n])]);
    return open.map(([token, id, amt, ez, at], k) => {
      const eth = lc(token) === lc(EEE), q = queued[k];
      const waiting = !!(q && q[0] && q[1] > filled.get(lc(token)));
      return row("Renzo", eth ? "ETH" : lc(token) === lc(STETH) ? "stETH" : token, eth ? ZERO : token, amt, "pending", id, {
        ...(!waiting && { ready_at: iso(at + cooldown) }), detail: `ezETH withdrawal request ${id} (${units(ez).toFixed(4)} ezETH)${waiting ? ", waiting in Renzo's fill queue" : `, cooldown ${Number(cooldown) / 86400} days from ${iso(at).slice(0, 10)}`}`,
      });
    });
  },

  // Liquid Collective: RequestedRedeem logs by recipient; resolveRedeemRequests >= 0 = satisfied by a withdrawal
  // event (claimable), -1 = not yet, -3 = claimed. ETH out follows the claim math over the events it spans.
  async liquidCollective(ctx, a) {
    const ids = [...new Set((await logs(ctx, { address: C.lc, topics: [ev("RequestedRedeem(address,uint256,uint256,uint256,uint32)"), topicAddr(a)] }))
      .map((l) => decodeEventLog({ abi: lcAbi, data: l.data, topics: l.topics }).args.id))];
    if (!ids.length) return [];
    const res = await multi(ctx, CHAIN, [
      { to: C.lc, abi: lcAbi, fn: "resolveRedeemRequests", args: [ids] }, { to: C.lc, abi: lcAbi, fn: "getWithdrawalEventCount" },
      ...ids.map((id) => ({ to: C.lc, abi: lcAbi, fn: "getRedeemRequestDetails", args: [id] })),
    ]);
    const [resolved, count] = res, details = res.slice(2);
    if (!resolved || count == null) throw { error: "Liquid Collective resolve failed" };
    const out = [];
    for (const [k, id] of ids.entries()) {
      const r = details[k], e = Number(resolved[k]);
      if (!r || e < -1 || r.amount === 0n || lc(r.recipient) !== lc(a)) continue;
      if (e === -1) { out.push(row("Liquid Collective", "LsETH", LSETH, r.amount, "pending", id, { detail: `LsETH redeem request ${id}, not yet satisfied by a withdrawal report (up to ${units(r.maxRedeemableEth).toFixed(4)} ETH)` })); continue; }
      let left = r.amount, height = r.height, eth = 0n;
      for (let w = e; left > 0n && w < Number(count); w++) {
        const x = await read(ctx, CHAIN, C.lc, lcAbi, "getWithdrawalEventDetails", [w]);
        const m = x.height + x.amount - height < left ? x.height + x.amount - height : left;
        const got = (m * x.withdrawnEth) / x.amount, cap = (m * r.maxRedeemableEth) / r.amount;
        eth += got < cap ? got : cap; left -= m; height += m;
      }
      out.push(row("Liquid Collective", "ETH", ZERO, eth, "ready", id, { detail: `LsETH redeem request ${id} (${units(r.amount - left).toFixed(4)} LsETH satisfied)` }));
      if (left > 0n) out.push(row("Liquid Collective", "LsETH", LSETH, left, "pending", id, { detail: `rest of LsETH redeem request ${id}, not yet satisfied` }));
    }
    return out;
  },

  // ether.fi WithdrawRequestNFT (found through Transfer logs): valid and finalized = claimWithdraw pays getClaimableAmount
  async etherfi(ctx, a) {
    const ids = await ownedFromLogs(ctx, C.etherfi, a);
    if (!ids.length) return [];
    const res = await multi(ctx, CHAIN, ids.flatMap((id) => [{ to: C.etherfi, abi: efAbi, fn: "getRequest", args: [id] }, { to: C.etherfi, abi: efAbi, fn: "isFinalized", args: [id] }, { to: C.etherfi, abi: efAbi, fn: "getClaimableAmount", args: [id] }]));
    return ids.map((id, i) => {
      const [req, fin, claimable] = res.slice(3 * i, 3 * i + 3);
      if (!req || !req.isValid) return null;
      const ready = !!fin && claimable != null;
      return row("ether.fi", "ETH", ZERO, ready ? claimable : req.amountOfEEth, ready ? "ready" : "pending", id, { detail: `eETH withdraw request NFT ${id}${ready ? ", finalized" : ", not finalized yet"}` });
    });
  },
};

export async function lrtWithdrawals(p, ctx) {
  if (!p?.address) throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
  const a = p.address;
  const { items, errors } = await each(Object.fromEntries(Object.entries(READERS).map(([k, fn]) => [k, () => fn(ctx, a)])));
  const open = items.filter((i) => i.amount > 0);
  if (open.length) {
    const px = await prices(ctx, open.map((i) => llamaKey(CHAIN, i.token)));
    for (const i of open) { const pr = priceOf(px, llamaKey(CHAIN, i.token)); i.usd = pr == null ? null : i.amount * pr; }
  }
  return { items: open, errors };
}
