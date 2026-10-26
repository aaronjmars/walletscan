// findings.mjs - pure normalizers: one raw upstream answer in, findings out. No network here (compose.mjs does
// the calls), so tests run them on the fixtures in test/fixtures.
//
// A finding is money the owner can likely take back now, or must act on before a date:
//   { category, chain, asset, amount, usd, net_after_fees_usd, action, how_to_claim, deadline, confidence, source, detail }
//   + bucket (who must act: you_can_claim | team_must_release | may_not_work, set by summarize from bucketOf)
// category: solana_rent | solana_rent_surplus | solana_stake | creator_fees | reward | vesting | prediction_winnings |
//           unstake_ready | bridge_stuck | bridge_blocked | airdrop | token_migration
//           | exchange_balance (margin, collateral or a refund left on a perp exchange that closed or went withdraw-only)
// confidence: high = the source says it is claimable now (claimable_usd); medium = computed by us or a third
//             party's word (likely_usd, check it in the app); low = a hint worth checking by hand (left out of totals)
// usd null = no price; such findings still count, with 0 in totals.
// Holdings (plain balances and DeFi positions) are kept apart: { kind, chain, asset, amount, usd, verified, protocol, detail }.

const num = (v) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const units = (raw, decimals) => Number(BigInt(raw)) / 10 ** Number(decimals || 0);
const hoursAgo = (t) => (Date.now() - new Date(t).getTime()) / 3600000;
// a thin market: the token's DEX pools (Jupiter's liquidity on Solana) hold under twice the row's value, so that price
// cannot be sold into: a finding goes low, a holding unverified (applyGoplus has the same rule on GoPlus liquidity).
// No liquidity figure = no call either way
export const thinMarket = (liquidity, usd) => num(liquidity) != null && (usd ?? 0) > 0 && Number(liquidity) < usd * 2;

export const EVM_CHAINS = {
  1: "ethereum", 10: "optimism", 56: "bsc", 100: "gnosis", 130: "unichain", 137: "polygon", 146: "sonic", 252: "fraxtal",
  324: "zksync", 480: "worldchain", 999: "hyperevm", 1868: "soneium", 4663: "robinhood", 5000: "mantle", 8453: "base",
  9745: "plasma", 34443: "mode", 42161: "arbitrum", 42220: "celo", 43114: "avalanche", 57073: "ink", 59144: "linea",
  60808: "bob", 80094: "berachain", 534352: "scroll", 7777777: "zora", 81457: "blast",
};
export const chainName = (id) => EVM_CHAINS[Number(id)] || String(id);
// Zerion's slugs for the chains EVM_CHAINS names otherwise: rows from different sources are matched on sameChain()
const ZERION_ALIAS = { "binance-smart-chain": "bsc", xdai: "gnosis", "zksync-era": "zksync", world: "worldchain" };
export const sameChain = (c) => ZERION_ALIAS[c] || c;
const TESTNETS = new Set([11155111, 84532, 421614, 11155420, 80002, 17000, 5, 97, 43113]);

// ---- claim cost ----------------------------------------------------------------------------------------------
// gas a claim takes, by category; an Ethereum claim costs gas x gasPrice x ETH, an L2 or sidechain one a flat
// estimate (cents), a Solana one 5,000 lamports per transaction
const GAS = { reward: 150_000, vesting: 120_000, unstake_ready: 120_000, bridge_stuck: 400_000, token_migration: 180_000, prediction_winnings: 200_000, airdrop: 150_000 };
const L2_COST_USD = 0.05;
export function claimCostUsd(f, env) {
  if (num(f.cost_usd) != null) return Number(f.cost_usd); // the source's own estimate (non-EVM chains: a Bitcoin fee...)
  if (f.chain === "solana") return ((f.txs || 1) * 5000 / 1e9) * (env.solUsd || 0);
  if (f.chain === "ethereum") return env.gasPriceWei && env.ethUsd ? ((GAS[f.category] || 150_000) * env.gasPriceWei / 1e18) * env.ethUsd : null;
  if (f.category === "prediction_winnings") return 0.01; // Polymarket pays the gas for redeems through its app
  return L2_COST_USD;
}
export function withNet(f, env) {
  const cost = claimCostUsd(f, env);
  const { txs, cost_usd, ...out } = f;
  return { ...out, usd: round(f.usd), net_after_fees_usd: f.usd == null || cost == null ? null : round(f.usd - cost), claim_cost_usd: cost == null ? null : round(cost, 4) };
}

// ---- Solana ------------------------------------------------------------------------------------------------
// token accounts (Token and Token-2022 answers of getTokenAccountsByOwner) -> rent in empty accounts, plus the
// surplus non-empty accounts hold since the Sept 2026 rent cut (rentMin165 = today's minimum for 165 bytes)
export function solRent(answers, { solUsd, rentMin165 }) {
  const rows = answers.flatMap((a) => a?.result?.value || []);
  const empty = [], frozen = [], withheld = [];
  let surplus = 0, surplusN = 0;
  const perByte = rentMin165 ? rentMin165 / (165 + 128) : null; // rent = (space + 128 header bytes) x rate
  for (const r of rows) {
    const info = r.account?.data?.parsed?.info || {};
    const lamports = Number(r.account?.lamports || 0);
    if (info.tokenAmount?.amount === "0") {
      if (info.state === "frozen") { frozen.push(r.pubkey); continue; }
      const fee = (info.extensions || []).find((e) => e.extension === "transferFeeAmount");
      if (fee && fee.state?.withheldAmount && fee.state.withheldAmount !== 0 && fee.state.withheldAmount !== "0") { withheld.push(r.pubkey); continue; }
      empty.push(lamports);
    } else if (perByte && !info.isNative) {
      const min = Math.ceil((Number(r.account?.space ?? 165) + 128) * perByte);
      if (lamports > min) { surplus += lamports - min; surplusN++; }
    }
  }
  const out = [];
  if (empty.length) {
    const sol = empty.reduce((a, b) => a + b, 0) / 1e9;
    out.push({
      category: "solana_rent", chain: "solana", asset: "SOL", amount: round(sol, 6), usd: solUsd ? sol * solUsd : null, txs: Math.ceil(empty.length / 20),
      action: `close ${empty.length} empty token account${empty.length > 1 ? "s" : ""} to get their rent deposit back`,
      how_to_claim: "https://jup.ag/portfolio", deadline: null, confidence: "high", source: "sol.token_accounts",
      detail: `${empty.length} accounts with a zero balance${frozen.length ? `; ${frozen.length} more are frozen by their token and cannot be closed` : ""}${withheld.length ? `; ${withheld.length} Token-2022 accounts hold withheld fees and need a harvest first` : ""}`,
    });
  }
  if (surplusN) {
    const sol = surplus / 1e9;
    out.push({
      category: "solana_rent_surplus", chain: "solana", asset: "SOL", amount: round(sol, 6), usd: solUsd ? sol * solUsd : null, txs: Math.ceil(surplusN / 20),
      action: `withdraw the extra rent ${surplusN} token accounts still hold since the Sept 2026 rent cut (they stay open)`,
      how_to_claim: null, deadline: null, confidence: "medium", source: "sol.token_accounts",
      detail: "Solana lowered the deposit an account must hold (SIMD-0437, more steps expected Nov 2026); older accounts keep the old deposit. Taking it out needs a wallet or tool that sends WithdrawExcessLamports",
    });
  }
  return out;
}

// stake accounts where the wallet is the withdraw authority: deactivated or never delegated = withdrawable
export function solStakes(answer, { solUsd, epoch }) {
  const out = [];
  for (const r of answer?.result || []) {
    const info = r.account?.data?.parsed?.info || {};
    const d = info.stake?.delegation;
    const deact = d && d.deactivationEpoch !== "18446744073709551615" ? Number(d.deactivationEpoch) : null;
    const free = !d || (deact != null && (epoch == null || deact < epoch));
    if (!free) continue;
    const sol = Number(r.account.lamports) / 1e9;
    out.push({
      category: "solana_stake", chain: "solana", asset: "SOL", amount: round(sol, 6), usd: solUsd ? sol * solUsd : null,
      action: d ? "withdraw the deactivated stake back to the wallet" : "the stake account holds SOL but is not delegated: withdraw or delegate it",
      how_to_claim: `https://solscan.io/account/${r.pubkey}`, deadline: null, confidence: "high", source: "sol.stake_accounts",
      detail: `stake account ${r.pubkey}${deact != null ? `, deactivated in epoch ${deact}` : ""}`,
    });
  }
  return out;
}

export function pumpFees(data, { solUsd, address }) {
  const sol = Number(data?.claimable_sol || 0);
  if (!(sol > 0)) return [];
  return [{
    category: "creator_fees", chain: "solana", asset: "SOL", amount: round(sol, 6), usd: solUsd ? sol * solUsd : null,
    action: "claim pump.fun creator rewards", how_to_claim: `https://pump.fun/profile/${address}`, deadline: null, confidence: "high", source: "sol.pump_creator_fees",
    detail: `bonding curve vault ${round(data.bonding_curve?.claimable_sol ?? 0, 6)} SOL, PumpSwap vault ${round(data.pumpswap?.claimable_sol ?? 0, 6)} SOL`,
  }];
}

// Helius DAS fungibles with a price -> holdings; Jupiter verification (token.jup_info rows) marks the trusted ones
// a Jupiter-unverified token counts as real money when its pool holds at least this much
const SOL_MARKET_USD = 50000;
export function solHoldings(das, jup = [], { minUsd = 1 } = {}) {
  const byMint = new Map((jup || []).map((t) => [t.id, t]));
  const out = [];
  let unpriced = 0;
  const nat = das?.result?.nativeBalance;
  if (nat?.lamports) out.push({ kind: "token", chain: "solana", asset: "SOL", amount: round(nat.lamports / 1e9, 6), usd: round(num(nat.total_price)), verified: true });
  for (const it of das?.result?.items || []) {
    if (!["FungibleToken", "FungibleAsset"].includes(it.interface)) continue;
    const ti = it.token_info || {}, j = byMint.get(it.id);
    const amount = units(BigInt(Math.round(Number(ti.balance || 0))), ti.decimals);
    // Helius prices only the big tokens: Jupiter's price fills the rest
    const usd = num(ti.price_info?.total_price) ?? (num(j?.usdPrice) != null ? Number(amount) * Number(j.usdPrice) : null);
    if (usd == null) unpriced++;
    if (usd != null && usd < minUsd) continue;
    const listed = !!(j && (j.isVerified || (j.tags || []).some((t) => t === "verified" || t === "strict")));
    // not on Jupiter's verified list but a real market: deep pool, no mint or freeze authority left (airdropped bait keeps those)
    const market = !listed && !!j && num(j.liquidity) >= SOL_MARKET_USD && j.audit?.mintAuthorityDisabled === true && j.audit?.freezeAuthorityDisabled === true;
    const verified = usd != null && (listed || market), thin = j && thinMarket(j.liquidity, usd);
    out.push({
      kind: "token", chain: "solana", asset: ti.symbol || it.content?.metadata?.symbol || j?.symbol || it.id, mint: it.id, amount, usd: round(usd), verified: verified && !thin,
      ...((!listed || thin) && { detail: [market ? `not verified by Jupiter, priced from a $${Math.round(j.liquidity / 1000)}k pool with no mint or freeze authority` : !verified && "not verified by Jupiter: check before selling", thin && `thin market (about $${Math.round(j.liquidity)} liquidity): not counted in holdings_usd`].filter(Boolean).join("; ") }),
    });
  }
  out.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  return { holdings: out, unpriced };
}

// Parcl PRCL airdrops (airdrop.parcl): never claimed, or claimed with vested tokens never withdrawn = high (medium when
// the distributor's vault holds less than the amount). Clawed-back seasons are gone. An unclaimed season past its
// clawback date still pays until Parcl claws it back, so it has no deadline.
export function parcl(data, { now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  return (data?.items || []).filter((i) => !i.clawed_back && num(i.amount) > 0).map((i) => {
    const open = i.clawback_start > today, short = i.vault_balance != null && i.vault_balance < i.amount;
    return {
      category: "airdrop", chain: "solana", asset: "PRCL", mint: "4LLbsb5ReP3yEtYzmXewyGjcir5uXtKFURtaEUVC2AHs", amount: round(i.amount, 6), usd: num(i.usd), protocol: "Parcl",
      action: i.claimed ? `withdraw the vested PRCL from your ${i.name} claim` : `claim the ${i.name} airdrop`, how_to_claim: i.claim_url, deadline: open ? i.clawback_start : null,
      confidence: short ? "medium" : "high", source: "airdrop.parcl",
      detail: [
        `Parcl distributor ${i.distributor}`, i.claimed ? "claimed, vested part never withdrawn" : "never claimed",
        open ? `Parcl can claw unclaimed tokens back from ${i.clawback_start}` : `clawback allowed since ${i.clawback_start} but nothing was clawed back yet: claimable until Parcl does`,
        i.vesting_left > 0 && `${round(i.vesting_left, 6)} PRCL more still vesting until ${i.vesting_end}`, short && `the distributor vault holds only ${i.vault_balance} PRCL`,
      ].filter(Boolean).join("; "),
    };
  });
}

// Blast apps (rewards.blast): Thruster LP, Orbit and Pac deposits to take out, then bridge before Blast's app
// withdrawals end (after that, through its L1 bridge contracts). high = the market holds the cash and no loan
// blocks it; medium = the market is short of cash (usd = what its cash covers, first come, first served) or a loan
// must be repaid first (usd = this deposit's share of the protocol position net of the loans); low = no cash left,
// or the loans are worth as much as the deposits (or cannot be priced), so nothing comes out now
export function blastApps(data, { now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10), closes = data?.closes || null, open = !closes || today <= closes;
  const bridge = open ? `then bridge it to Ethereum before ${closes} (Blast app withdrawals end)` : `then exit through the Blast bridge contracts on Ethereum (Blast app withdrawals ended ${closes})`;
  return (data?.items || []).filter((i) => num(i.amount) > 0 || (i.tokens || []).some((t) => t.amount > 0)).map((i) => {
    const lp = i.kind === "lp", short = i.cash != null && i.cash < i.amount, owes = (i.debts || []).length > 0;
    const net = owes && i.debt_usd != null && i.supply_usd > 0 ? (i.supply_usd - i.debt_usd) / i.supply_usd : null, underwater = owes && !(net > 0);
    const share = Math.min(short ? Math.max(0, i.cash) / i.amount : 1, owes && !underwater ? net : 1), stuck = underwater || (short && !(i.cash > 0));
    const usd = num(i.usd) == null ? null : i.usd * share;
    return {
      category: "unstake_ready", chain: "blast", asset: lp ? `${i.asset} LP` : i.asset, amount: lp ? null : round(i.amount, 6), usd, protocol: i.protocol,
      action: `${lp ? `remove the ${i.protocol} liquidity` : `${owes ? "repay the loan, then " : ""}withdraw ${i.asset} from ${i.protocol}`}, ${bridge}`, how_to_claim: i.how_to_claim, deadline: closes,
      confidence: stuck ? "low" : short || owes ? "medium" : "high", source: "rewards.blast",
      detail: [
        lp && i.tokens.map((t) => `${round(t.amount, 6)} ${t.symbol}`).join(" + "), i.detail,
        short && (i.cash > 0 ? `the market holds only ${round(i.cash, 6)} ${i.asset}: first come, first served` : `the market has no ${i.asset} cash left: nothing comes out until borrowers repay`),
        short && num(i.usd) != null && `full deposit worth $${Math.round(i.usd)}`,
        owes && `loan of ${i.debts.map((d) => `${round(d.amount, 6)} ${d.asset}`).join(" + ")} locks the deposit`,
        underwater && (i.debt_usd == null ? "the loan could not be priced: check what is left after repaying" : `the loans ($${Math.round(i.debt_usd)}) are worth more than the ${i.protocol} deposits ($${Math.round(i.supply_usd)}): nothing to take out`),
        owes && !underwater && `usd = this deposit's share of the position net of the loans ($${Math.round(i.supply_usd - i.debt_usd)} of $${Math.round(i.supply_usd)})`,
        !open && data?.exit,
      ].filter(Boolean).join("; "),
    };
  });
}

// ---- rewards -----------------------------------------------------------------------------------------------
export function merkl(answer, { address }) {
  const out = [];
  for (const c of Array.isArray(answer) ? answer : []) {
    for (const r of c.rewards || []) {
      let left;
      try { left = BigInt(r.amount) - BigInt(r.claimed || 0); } catch { continue; }
      if (left <= 0n) continue;
      const amount = units(left, r.token?.decimals ?? 18);
      const price = num(r.token?.price);
      out.push({
        category: "reward", chain: chainName(c.chain?.id), asset: r.token?.symbol || r.token?.address, amount, usd: price == null ? null : amount * price,
        action: "claim Merkl rewards", how_to_claim: `https://app.merkl.xyz/users/${address}`, deadline: null, confidence: "high", source: "rewards.merkl",
        detail: `Merkl incentive rewards on ${c.chain?.name || c.chain?.id}`,
      });
    }
  }
  return out;
}

// protocols whose Zerion reward amount is known to be wrong
const ZERION_BAD_REWARDS = /gearbox/i;

// Zerion complex positions: reward = claimable now; locked / deposit / staked = positions (holdings); loan = debt (negative holding)
export function zerionPositions(answer, { deadlines = [], now = Date.now() } = {}) {
  const findings = [], holdings = [], today = new Date(now).toISOString().slice(0, 10);
  for (const p of answer?.data || []) {
    const a = p.attributes || {};
    const chain = p.relationships?.chain?.data?.id;
    const token = String((a.fungible_info?.implementations || []).find((i) => i.chain_id === chain)?.address || "").toLowerCase();
    const row = { chain, asset: a.fungible_info?.symbol, amount: num(a.quantity?.numeric), usd: num(a.value), protocol: a.protocol || a.application_metadata?.name || null, ...(token && { token }) };
    if (a.position_type === "reward") {
      // a reward with no price is mostly an airdropped spam token paired in a pool or a fee token nobody trades
      const priced = row.usd != null && row.usd > 0;
      // Gearbox: Zerion adds a past, claimed GEAR airdrop to the amount (100,160 GEAR where DeBank, Octav and the app show
      // 160, checked 2026-10-22): a hint only, out of the totals
      const bad = ZERION_BAD_REWARDS.test(row.protocol || "");
      findings.push({
        category: "reward", ...row, action: `collect in ${row.protocol || "the app"}`, how_to_claim: a.application_metadata?.url || null,
        // medium, not high: Zerion's amount is its own read (it once showed a past GEAR airdrop as 100k claimable), the app has the real one
        deadline: null, confidence: priced && !bad ? "medium" : "low", source: "rewards.zerion",
        detail: [a.name, bad ? "Zerion's amount for this protocol has been far too high (it counts past claims): check it in the app" : priced ? "amount as read by Zerion: check it in the app" : "no price: likely a spam or untradeable token"].filter(Boolean).join("; ") || null,
      });
      continue;
    }
    if (a.position_type === "loan") { holdings.push({ kind: "loan", ...row, usd: row.usd == null ? null : -row.usd, verified: true, detail: a.name || "debt" }); continue; }
    // Zerion names a time lock by its end date ("Wayfinder PRIME Pool (2025-02-08T12:34:01Z)"): once it has passed,
    // the tokens can be withdrawn, so a finding instead of a locked holding (medium: Zerion's date, check it in the app)
    const ends = a.position_type === "locked" && /\((\d{4}-\d{2}-\d{2})T[\d:.]+Z?\)/.exec(a.name || "")?.[1];
    if (ends && ends < today) {
      findings.push({
        category: "unstake_ready", ...row, action: `the ${row.protocol || ""} lock ended on ${ends}: withdraw it`.replace("the  lock", "the lock"), how_to_claim: a.application_metadata?.url || null,
        deadline: null, confidence: row.usd > 0 ? "medium" : "low", source: "rewards.zerion", detail: `${a.name}; lock end date as read by Zerion: check it in the app`,
      });
      continue;
    }
    holdings.push({ kind: a.position_type || "position", ...row, verified: true, detail: a.name || null });
    const d = deadlines.find((x) => x.match?.protocol && String(row.protocol || "").toLowerCase().includes(x.match.protocol));
    if (d) findings.push({
      category: "token_migration", ...row, action: `withdraw from ${row.protocol} before ${d.closes}`, how_to_claim: d.link, deadline: d.closes,
      confidence: "medium", source: "rewards.zerion", detail: `${d.name}: ${d.what}`,
    });
  }
  return { findings, holdings };
}

// Zerion plain balances -> holdings, plus token migrations with a deadline or penalty (deadline.list matches)
export function zerionHoldings(answer, { deadlines = [], minUsd = 1 } = {}) {
  const findings = [], holdings = [];
  for (const p of answer?.data || []) {
    const a = p.attributes || {};
    const chain = p.relationships?.chain?.data?.id;
    const impl = (a.fungible_info?.implementations || []).find((i) => i.chain_id === chain);
    const addr = String(impl?.address || "").toLowerCase();
    const row = { chain, asset: a.fungible_info?.symbol, amount: num(a.quantity?.numeric), usd: num(a.value) };
    // match.address = one token on one chain; match.chain alone = any balance left on a closed chain (an exit claim)
    const d = deadlines.find((x) => x.match?.chain === chain && (x.match.address ? x.match.address === addr : !x.match.protocol));
    if (d && !d.match.address) { // not spendable where it sits, so a finding instead of a holding
      if (!(row.usd > 0)) continue; // unpriced leftovers (Gravity "Point" tokens) are not money
      // the exit window already closed: maybe gone, a low hint (as in chainSweep)
      const action = d.expired ? `the exit window closed on ${d.closes}: ask the ${d.name} team. ${d.how_to_check}` : d.closes ? `get it out before ${d.closes}: ${d.how_to_check}` : `get it out: ${d.how_to_check}`;
      findings.push({
        category: d.category || "bridge_stuck", ...row, action, how_to_claim: d.link, deadline: d.closes, ...(d.expired && { expired: true }),
        confidence: d.expired ? "low" : "medium", source: "holdings.zerion", detail: d.what,
      });
      continue;
    }
    if (d) findings.push({
      category: "token_migration", ...row, action: d.closes ? `migrate before ${d.closes}` : `migrate: ${d.name}`, how_to_claim: d.link, deadline: d.closes,
      confidence: "high", source: "holdings.zerion", detail: d.what,
    });
    if ((row.usd ?? 0) < minUsd) continue;
    holdings.push({ kind: "token", ...row, ...(addr && { token: addr }), verified: !!a.fungible_info?.flags?.verified, ...(!a.fungible_info?.flags?.verified && { detail: "not verified by Zerion: check before selling" }) });
  }
  return { findings, holdings };
}

// open (not yet resolved) bets with a value: holdings, not findings
export function polymarketOpen(rows) {
  return (Array.isArray(rows) ? rows : []).filter((r) => !r.redeemable && num(r.currentValue) > 0).map((r) => ({
    kind: "position", chain: "polygon", asset: `${r.outcome} shares`, amount: num(r.size), usd: num(r.currentValue), protocol: "Polymarket", verified: true, detail: r.title,
  }));
}

export function polymarket(rows, { users = [] } = {}) {
  return (Array.isArray(rows) ? rows : []).filter((r) => r.redeemable && num(r.currentValue) > 0).map((r) => ({
    category: "prediction_winnings", chain: "polygon", asset: "USDC", amount: num(r.size), usd: num(r.currentValue),
    action: `redeem the winning "${r.outcome}" shares`, how_to_claim: "https://polymarket.com/portfolio", deadline: null, confidence: "high", source: "rewards.polymarket_redeemable",
    detail: `${r.title}${users.length > 1 ? ` (proxy wallet ${r.proxyWallet})` : ""}`,
  }));
}

export function hyperliquidReferral(answer) {
  const u = num(answer?.unclaimedRewards);
  if (!(u > 0)) return [];
  return [{
    category: "reward", chain: "hyperliquid", asset: "USDC", amount: u, usd: u, action: "claim Hyperliquid referral rewards",
    how_to_claim: "https://app.hyperliquid.xyz/referrals", deadline: null, confidence: "high", source: "rewards.hyperliquid_referral", detail: null,
  }];
}

export function lido(data, { ethUsd }) {
  const eth = num(data?.claimable_eth);
  if (!(eth > 0)) return [];
  const n = (data.requests || []).filter((r) => r.finalized && !r.claimed).length;
  return [{
    category: "unstake_ready", chain: "ethereum", asset: "ETH", amount: eth, usd: ethUsd ? eth * ethUsd : null, protocol: "Lido",
    action: `claim ${n} finished Lido withdrawal${n > 1 ? "s" : ""}`, how_to_claim: "https://stake.lido.fi/withdrawals/claim", deadline: null, confidence: "high", source: "rewards.lido_withdrawals",
    detail: "stETH unstaked and finalized by Lido, ETH waiting in the withdrawal queue",
  }];
}

// EigenLayer queued withdrawals (rewards.eigenlayer_withdrawals): one finding per token and state (beacon chain ETH,
// stETH, EIGEN... never summed across tokens); past the escrow delay = high, still in escrow = medium; a strategy
// that could not be read = low, no amount
export function eigenlayer(data, { ethUsd } = {}) {
  const groups = new Map();
  for (const w of data?.withdrawals || []) {
    for (const a of w.assets || []) {
      if (a.amount != null && !(num(a.amount) > 0)) continue;
      const key = `${w.ready}|${a.token ?? (a.symbol ? "eth" : a.strategy)}`;
      const g = groups.get(key) || { ready: w.ready, token: a.token, symbol: a.symbol, strategy: a.strategy, amount: 0, usd: 0, priced: true, read: true, n: 0, hrs: [] };
      if (a.amount == null) g.read = false; else g.amount += a.amount;
      const usd = a.usd != null ? num(a.usd) : !a.token && a.symbol === "ETH" && a.amount != null && ethUsd ? a.amount * ethUsd : null;
      if (usd == null) g.priced = false; else g.usd += usd;
      g.n++;
      if (!w.ready) g.hrs.push(w.approx_hours_remaining ?? 0);
      groups.set(key, g);
    }
  }
  return [...groups.values()].map((g) => {
    const s = g.n > 1 ? "s" : "", asset = g.symbol || g.token || "unknown token", hrs = g.hrs.sort((x, y) => x - y)[0];
    return {
      category: "unstake_ready", chain: "ethereum", asset, ...(g.token && { token: g.token }), amount: g.read ? round(g.amount, 6) : null, usd: g.read && g.priced ? round(g.usd) : null, protocol: "EigenLayer",
      action: g.ready ? `complete ${g.n} finished EigenLayer queued withdrawal${s} of ${asset} (completeQueuedWithdrawal)` : `EigenLayer queued withdrawal${s} of ${asset} in escrow (~${hrs}h remaining)`,
      how_to_claim: "https://app.eigenlayer.xyz", deadline: null, confidence: !g.read ? "low" : g.ready ? "high" : "medium", source: "rewards.eigenlayer_withdrawals",
      detail: !g.read ? `strategy ${g.strategy} could not be read: check the withdrawal in the app` : g.ready ? "restaked assets queued for withdrawal on EigenLayer passed the escrow delay; amount = withdrawable shares after slashing, in the strategy's token" : `${g.n} withdrawal${s} initiated on EigenLayer, waiting for the escrow delay; amount = withdrawable shares after slashing, in the strategy's token`,
    };
  });
}
// Venice staking on Base (rewards.venice): unclaimed VVV rewards and a finished unstake cooldown are findings;
// DIEM minted against locked sVVV is a debt (a negative holding) Zerion does not return
export function venice(data) {
  const findings = [], holdings = [];
  if (num(data?.pending_vvv) > 0) findings.push({
    category: "reward", chain: "base", asset: "VVV", amount: data.pending_vvv, usd: data.vvv_usd == null ? null : data.pending_vvv * data.vvv_usd, protocol: "Venice",
    action: "claim Venice staking rewards", how_to_claim: "https://venice.ai/token", deadline: null, confidence: "high", source: "rewards.venice", detail: "pendingRewards on the sVVV staking contract",
  });
  const cd = data?.cooldown;
  if (num(cd?.vvv) > 0 && cd.ends && cd.ends <= new Date().toISOString()) findings.push({
    category: "unstake_ready", chain: "base", asset: "VVV", amount: cd.vvv, usd: data.vvv_usd == null ? null : cd.vvv * data.vvv_usd, protocol: "Venice",
    action: "finish the Venice unstake (finalizeUnstake)", how_to_claim: "https://venice.ai/token", deadline: null, confidence: "high", source: "rewards.venice", detail: `cooldown ended ${cd.ends.slice(0, 10)}`,
  });
  if (num(data?.diem_debt) > 0) holdings.push({
    kind: "loan", chain: "base", asset: "DIEM", amount: data.diem_debt, usd: data.diem_usd == null ? null : -round(data.diem_debt * data.diem_usd), protocol: "Venice", verified: true, source: "rewards.venice",
    detail: `DIEM minted against ${round(data.locked_svvv, 6)} locked sVVV: burn it to unlock the stake`,
  });
  return { findings, holdings };
}

// Pendle (rewards.pendle): PT, YT and LP left in markets past their expiry, and merkle rewards never claimed
const PENDLE_PART = { pt: ["unstake_ready", "redeem the matured PT"], yt: ["reward", "claim the YT interest"], lp: ["unstake_ready", "remove liquidity from the expired pool"] };
export function pendle(data) {
  const out = [];
  for (const m of data?.matured || []) {
    const [category, what] = PENDLE_PART[m.part];
    out.push({
      category, chain: chainName(m.chain_id), asset: `${m.part.toUpperCase()}-${m.name}`, amount: m.amount ?? null, usd: num(m.usd), protocol: "Pendle",
      action: `${what} (${m.name}, expired ${m.expiry})`, how_to_claim: "https://app.pendle.finance/trade/dashboard/overview", deadline: null, confidence: "high", source: "rewards.pendle",
      detail: `Pendle market ${m.market}`,
    });
  }
  for (const r of data?.rewards || []) out.push({
    category: "reward", chain: chainName(r.chain_id), asset: r.symbol || r.token, token: r.token, amount: r.amount, usd: num(r.usd), protocol: "Pendle",
    action: "claim Pendle rewards", how_to_claim: "https://app.pendle.finance/trade/dashboard/overview", deadline: null, confidence: "high", source: "rewards.pendle",
    detail: r.title ? `Pendle merkle rewards: ${r.title}` : "Pendle merkle rewards",
  });
  return out;
}

// HyperCore (Hyperliquid's own L1) balances as holdings: spot tokens, perps account, staked HYPE, vault deposits
export function hyperliquid(data, { minUsd = 1 } = {}) {
  return (data?.items || []).filter((i) => (i.usd ?? 0) >= minUsd).map((i) => ({
    kind: i.kind, chain: "hypercore", asset: i.asset, amount: round(i.amount, 6), usd: round(i.usd), ...(i.protocol && { protocol: i.protocol }),
    verified: !!i.verified, source: "holdings.hyperliquid", ...(i.detail && { detail: i.detail }),
  }));
}

// Perpetual DEX holdings (holdings.perps, holdings.perps_sol): GMX V2, zkLighter, Kwenta Smart Margin, and every
// perps/ venue that still trades (status live). Closed venues and hints are findings (perpsFindings)
export function perpsHoldings(data, { minUsd = 1, source = "holdings.perps" } = {}) {
  return (data?.items || []).filter((i) => (i.status || "live") === "live" && (i.usd ?? 0) >= minUsd).map((i) => ({
    kind: i.kind || "position", chain: i.chain, asset: i.asset, amount: round(i.amount, 6), usd: round(i.usd),
    protocol: i.protocol, verified: true, source, ...(i.detail && { detail: i.detail }),
  }));
}

// perps/ venues that closed, went withdraw-only or were abandoned (status closed): money to take back, at the
// venue's own confidence (low on a thin market: Drift DFX at its Jupiter price); status hint = an account exists but
// no balance can be read keylessly (low, no amount)
export function perpsFindings(data, { source = "holdings.perps" } = {}) {
  return (data?.items || []).filter((i) => (i.status === "closed" && num(i.amount) > 0) || i.status === "hint").map((i) => {
    const thin = i.status !== "hint" && thinMarket(i.liquidity, num(i.usd));
    return {
      category: i.category || "exchange_balance", chain: i.chain, asset: i.asset, amount: i.status === "hint" ? null : round(num(i.amount), 6),
      usd: i.status === "hint" || i.usd == null ? null : num(i.usd), protocol: i.protocol, action: i.action,
      how_to_claim: i.how_to_claim || null, deadline: i.deadline || null, confidence: i.status === "hint" || thin ? "low" : i.confidence || "medium", source,
      detail: thin ? `${i.detail}; thin market (about $${Math.round(i.liquidity)} liquidity): this price cannot be sold into` : i.detail,
    };
  });
}

// old claims with no deadline (rewards.legacy): ZKsync Lite exits, Liquity leftover collateral, Curve fees, GNT/DGD
export function legacy(data) {
  return (data?.items || []).filter((i) => num(i.amount) > 0).map((i) => ({
    category: i.kind, chain: i.chain || "ethereum", asset: i.asset, amount: num(i.amount), usd: i.usd == null ? null : num(i.usd), protocol: i.protocol,
    action: i.action, how_to_claim: i.how_to_claim, deadline: null, confidence: "high", source: "rewards.legacy", detail: i.detail,
  }));
}

// money left in old Ethereum contracts (rewards.old_contracts, rewards.maker_scd, rewards.argent_wallets: oldeth/).
// Each item carries its own confidence: high = read onchain now (EtherDelta/IDEX balance, ENS deed owned by the
// wallet, a PoWH clone's dividends, an Argent wallet's ETH); medium = a SAI vault with debt settled at our estimate,
// Zerion's token read in an Argent wallet; low = listed in Forgotten ETH's index with no onchain reader here (a hint)
const CONF = new Set(["high", "medium", "low"]);
export function oldEthereum(data, { source }) {
  return (data?.items || []).filter((i) => num(i.amount) > 0).map((i) => ({
    category: i.category, chain: "ethereum", asset: i.asset, amount: num(i.amount), usd: i.usd == null ? null : num(i.usd), protocol: i.protocol,
    action: i.action, how_to_claim: i.how_to_claim, deadline: null, confidence: CONF.has(i.confidence) ? i.confidence : "low", source, detail: i.detail,
  }));
}

// validators with 0x00 withdrawal credentials (rewards.validators_0x00): the balance of exited ones and the rewards
// above 32 ETH of active ones are findings (medium: found from the wallet's own deposits, the withdrawal key may sit
// elsewhere); the 32 ETH an active validator still stakes is a holding
export function validators0x00(data) {
  return {
    findings: oldEthereum(data, { source: "rewards.validators_0x00" }),
    holdings: (data?.holdings || []).filter((h) => num(h.amount) > 0).map((h) => ({
      kind: h.kind, chain: "ethereum", asset: h.asset, amount: num(h.amount), usd: h.usd == null ? null : num(h.usd), protocol: h.protocol, verified: true, source: "rewards.validators_0x00", detail: h.detail,
    })),
  };
}

// Sablier lockup streams: what has streamed and was not withdrawn (linear estimate: cliffs and curves are close
// enough for a hint, the app shows the exact amount); no price here (usd null)
export function sablier(answer, { now = Date.now() / 1000 } = {}) {
  const out = [];
  for (const s of answer?.data?.LockupStream || []) {
    if (TESTNETS.has(Number(s.chainId))) continue;
    const start = Number(s.startTime), end = Number(s.endTime), dep = BigInt(s.depositAmount || 0), wd = BigInt(s.withdrawnAmount || 0);
    const share = end > start ? Math.min(1, Math.max(0, (now - start) / (end - start))) : 1;
    const streamed = (dep * BigInt(Math.round(share * 1e6))) / 1_000_000n;
    const free = streamed - wd;
    if (free <= 0n) continue;
    out.push({
      category: "vesting", chain: chainName(s.chainId), asset: s.asset?.symbol, amount: units(free, s.asset?.decimals ?? 18), usd: null,
      action: "withdraw the vested part of the Sablier stream", how_to_claim: `https://app.sablier.com/vesting/stream/${s.alias}`, deadline: null,
      confidence: "medium", source: "rewards.sablier_streams", detail: `stream ${s.alias}, ends ${new Date(end * 1000).toISOString().slice(0, 10)}`,
    });
  }
  return out;
}

// ---- unclaimed/ (contracts read directly): a row the contract says is claimable now is high; one with no price is
// low (mostly airdropped memecoins nobody trades: a hint, out of the totals)
const priced = (x) => x.usd != null && x.usd > 0;
const sure = (x) => (priced(x) ? "high" : "low");
const noPrice = (x) => (priced(x) ? null : "no price: likely a spam or untradeable token");

// Polygon zkEVM exit claims (bridge.polygon_zkevm): exact amounts from Polygon's claimer, unclaimed per isClaimed on
// the bridge (a failed read = medium); zkEVM-born tokens have no market price but are still the wallet's
export function zkevmExits(data, { deadline = "2027-12-31" } = {}) {
  return (data?.items || []).filter((i) => !i.claimed && num(i.amount) > 0).map((i) => ({
    category: "bridge_stuck", chain: "ethereum", asset: i.asset, amount: num(i.amount), usd: i.usd == null ? null : num(i.usd), token: i.token, protocol: "Polygon zkEVM",
    action: `claim ${i.asset || "the token"} left on Polygon zkEVM (exit claim on Ethereum)`, how_to_claim: "https://zkevm-claims.polygon.technology", deadline,
    confidence: i.read === false || i.unmapped ? "medium" : "high", source: "bridge.polygon_zkevm",
    detail: `Polygon zkEVM shut down on 2026-07-03; exit leaf ${i.deposit_count} from Polygon's claimer, ${i.read === false ? "claimed state not read" : "isClaimed false on the bridge"}${i.unmapped ? "; a token born on zkEVM with no Ethereum copy yet (the claim deploys it), name and decimals read on zkEVM" : ""}`,
  }));
}

// Hedgey plans (rewards.hedgey): what planBalanceOf says redeems now; what is still locked goes in the detail
export function hedgey(data) {
  return (data?.items || []).filter((i) => num(i.amount) > 0).map((i) => ({
    category: "vesting", chain: i.chain, asset: i.asset, amount: num(i.amount), usd: i.usd == null ? null : num(i.usd), token: i.token, protocol: "Hedgey",
    action: `redeem the unlocked part of Hedgey ${i.kind} plan #${i.plan_id}`, how_to_claim: `https://app.hedgey.finance/${i.kind === "lockup" ? "lockups" : "vesting"}`, deadline: null,
    confidence: sure(i), source: "rewards.hedgey",
    detail: [num(i.locked) > 0 && `${round(i.locked, 6)} ${i.asset} still locked${i.next_unlock ? ` (next unlock ${i.next_unlock})` : ""}`, noPrice(i)].filter(Boolean).join("; ") || null,
  }));
}

// Flaunch creator fees (rewards.flaunch): ETH in the Base FeeEscrow
export function flaunch(data) {
  return (data?.items || []).filter((i) => num(i.amount) > 0).map((i) => ({
    category: "creator_fees", chain: "base", asset: "ETH", amount: num(i.amount), usd: i.usd == null ? null : num(i.usd), protocol: "Flaunch",
    action: "withdraw Flaunch creator fees", how_to_claim: "https://flaunch.gg", deadline: null, confidence: "high", source: "rewards.flaunch",
    detail: "trading fees credited to the launch NFT holder, balances(address) on the Flaunch FeeEscrow",
  }));
}

// Uniswap fees (rewards.uniswap_fees): one finding per token of a position. Legs with no price are dropped (fees in
// airdropped spam pairs); v3 is a simulated collect (high), v4 our fee growth math (medium: a hook can change it)
export function uniswapFees(data) {
  const out = [];
  for (const p of data?.items || []) {
    for (const l of p.legs || []) {
      if (!(num(l.amount) > 0) || !priced(l)) continue;
      out.push({
        category: "reward", chain: p.chain, asset: l.asset, amount: num(l.amount), usd: num(l.usd), token: l.token, protocol: p.protocol,
        action: `collect fees on ${p.protocol} position #${p.position_id}${p.closed ? " (closed: collects the tokens left in it)" : ""}`,
        how_to_claim: `https://app.uniswap.org/positions/${p.version}/${p.chain === "bsc" ? "bnb" : p.chain}/${p.position_id}`, deadline: null,
        confidence: p.version === "v3" ? "high" : "medium", source: "rewards.uniswap_fees",
        detail: p.version === "v3" ? "collect() simulated as the owner" : `fee growth since the last touch x liquidity${p.hooks ? `; pool hook ${p.hooks} may change the payout` : ""}`,
      });
    }
  }
  return out;
}

// Superfluid pools (rewards.superfluid): pool shares never claimed (getClaimableNow)
export function superfluid(data) {
  return (data?.items || []).filter((i) => num(i.amount) > 0).map((i) => ({
    category: "reward", chain: i.chain, asset: i.asset, amount: num(i.amount), usd: i.usd == null ? null : num(i.usd), token: i.token, protocol: "Superfluid",
    action: `claim your share of Superfluid pool ${i.pool.slice(0, 10)}...${i.connected ? "" : " (or connect to it)"}`, how_to_claim: "https://app.superfluid.org", deadline: null,
    confidence: sure(i), source: "rewards.superfluid", detail: ["getClaimableNow on the distribution pool", noPrice(i)].filter(Boolean).join("; "),
  }));
}

// UNCX / Team Finance / Unvest (rewards.token_locks): unlocked or vested and never withdrawn
const LOCK_UI = { UNCX: "https://app.uncx.network", "Team Finance": "https://www.team.finance/claim", Unvest: "https://app.unvest.io" };
export function tokenLocks(data) {
  return (data?.items || []).filter((i) => num(i.amount) > 0).map((i) => ({
    category: i.protocol === "Team Finance" ? "unstake_ready" : "vesting", chain: i.chain, asset: i.asset, amount: num(i.amount), usd: i.usd == null ? null : num(i.usd), token: i.token, protocol: i.protocol,
    action: i.protocol === "Unvest" ? `claim the vested ${i.asset} from Unvest` : `withdraw ${i.protocol} lock #${i.lock_id}`, how_to_claim: LOCK_UI[i.protocol], deadline: null,
    confidence: sure(i), source: "rewards.token_locks",
    detail: [i.protocol === "Team Finance" ? `unlocked on ${i.unlocked}` : i.protocol === "UNCX" ? "getWithdrawableTokens on UNCX TokenVesting" : `claimableBalanceOf on vesting token ${i.contract}`, noPrice(i)].filter(Boolean).join("; "),
  }));
}

// ---- bridges -----------------------------------------------------------------------------------------------
// where to finish a stuck withdrawal, by stuck bridge key (the action text from stuck says which step)
const BRIDGE_UI = {
  base: "https://superbridge.app/base", optimism: "https://superbridge.app/optimism", zora: "https://superbridge.app/zora", ink: "https://superbridge.app/ink",
  unichain: "https://superbridge.app/unichain", soneium: "https://superbridge.app/soneium", worldchain: "https://superbridge.app/world-chain", shape: "https://superbridge.app/shape",
  blast: "https://superbridge.app/blast", arbitrum: "https://portal.arbitrum.io/bridge", polygon: "https://portal.polygon.technology/bridge", linea: "https://linea.build/hub/bridge",
  zksync: "https://portal.zksync.io/bridge", scroll: "https://portal.scroll.io/bridge", wormhole: "https://portalbridge.com", "wormhole-ntt": "https://portalbridge.com",
  debridge: "https://app.debridge.finance/orders", gnosis: "https://bridge.gnosischain.com", starknet: "https://starkgate.starknet.io", ronin: "https://app.roninchain.com/bridge",
  sui: "https://bridge.sui.io", lisk: "https://bridge.lisk.com", mode: "https://app.mode.network/bridge", bob: "https://app.gobob.xyz/bridge",
  mantle: "https://app.mantle.xyz/bridge", manta: "https://pacific-bridge.manta.network",
  dbk: "https://etherscan.io/address/0x63CA00232F471bE2A3Bf3C4e95Bc1d2B3EA5DB92#writeProxyContract", // DBK Chain: no bridge app on file, its OptimismPortal
  taiko: "https://bridge.taiko.xyz/transactions", opbnb: "https://opbnb-bridge.bnbchain.org/history", morph: "https://bridge.morph.network",
};
const CLAIMABLE = new Set(["claimable", "ready-to-prove", "ready-to-finalize"]);
// bridges whose last step is a transaction on Ethereum (L2 exits and L1 bridge contracts); the others claim on a
// destination the item does not name
const CLAIM_ON_L1 = new Set(["base", "optimism", "zora", "ink", "unichain", "soneium", "worldchain", "shape", "blast", "arbitrum", "polygon", "linea", "zksync", "scroll", "gnosis", "starknet", "starkex", "ronin", "sui", "lisk", "mode", "bob", "dbk", "mantle", "manta", "taiko", "morph"]);
export function stuck(data) {
  const out = [];
  for (const i of data?.items || []) {
    if (!CLAIMABLE.has(i.status) && i.status !== "blocked") continue;
    const key = String(i.key || "").toLowerCase();
    const blocked = i.status === "blocked";
    out.push({
      // claimChain: an item claimed off Ethereum (opBNB exits on BNB Chain, a failed Taiko message recalled on Taiko)
      category: blocked ? "bridge_blocked" : "bridge_stuck", chain: i.claimChain || (CLAIM_ON_L1.has(key) ? "ethereum" : null), asset: i.symbol, amount: num(i.value), usd: num(i.usd),
      action: blocked ? `stuck until the ${i.bridge} team acts: contact them with tx ${i.tx}` : i.action || `${i.status} on ${i.bridge}`,
      how_to_claim: BRIDGE_UI[key] || null, deadline: i.deadline || null, confidence: blocked ? "low" : i.confidence || "high", source: "bridge.stuck",
      detail: [`${i.bridge}: ${i.status}`, i.tx && `tx ${i.tx}`, i.detail].filter(Boolean).join("; "),
    });
  }
  return out;
}

// Scroll's unclaimed L2 -> L1 withdrawals (bridge.scroll: scans use it only when bridge.stuck, which reads the same
// API, has no answer). ETH and the L1 tokens below come with their decimals; another token has no amount (raw units in
// the detail). A withdrawal whose batch is not finalized yet (claim_info.claimable false) cannot be claimed now: medium
const SCROLL_TOKENS = {
  "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2": ["WETH", 18], "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": ["USDC", 6], "0xdac17f958d2ee523a2206206994597c13d831ec7": ["USDT", 6],
  "0x6b175474e89094c44da98b954eedeac495271d0f": ["DAI", 18], "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": ["WBTC", 8], "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0": ["wstETH", 18],
};
export function scrollBridge(answer, { ethUsd } = {}) {
  const results = answer?.data?.results;
  if (!Array.isArray(results) || !results.length) return [];
  return results.map((r) => {
    const token = String(r.l1_token_address ?? r.token ?? "").toLowerCase(), raw = r.token_amounts?.[0] ?? r.token_amount ?? r.amount;
    const eth = !token || /^0x0{40}$/.test(token), [symbol, dec] = eth ? ["ETH", 18] : SCROLL_TOKENS[token] || [token, null];
    const amount = raw != null && dec != null ? units(raw, dec) : null, waiting = r.claim_info?.claimable === false;
    return {
      category: "bridge_stuck", chain: "ethereum", asset: symbol, ...(!eth && { token }), amount,
      usd: (eth || symbol === "WETH") && amount != null && ethUsd ? amount * ethUsd : null,
      action: waiting ? "Scroll withdrawal waiting for its batch to be finalized on Ethereum: claim it once it is" : "claim Scroll withdrawal on Ethereum",
      how_to_claim: "https://portal.scroll.io/bridge", deadline: null, confidence: waiting ? "medium" : "high", source: "bridge.scroll",
      detail: [r.hash ? `Scroll L2 tx ${r.hash}` : "Scroll bridge withdrawal", amount == null && raw != null && `${raw} raw units of ${token} (decimals unknown here)`].filter(Boolean).join("; "),
    };
  });
}

export function layerzero(answer) {
  return (answer?.data || []).filter((m) => ["FAILED", "BLOCKED", "PAYLOAD_STORED"].includes(m.status?.name)).map((m) => ({
    category: "bridge_stuck", chain: null, asset: m.pathway?.sender?.name || null, amount: null, usd: null,
    action: m.status.name === "PAYLOAD_STORED" ? "retry the stored payload on the destination chain" : "retry or clear the failed message",
    how_to_claim: `https://layerzeroscan.com/tx/${m.source?.tx?.txHash}`, deadline: null, confidence: "medium", source: "bridge.layerzero",
    detail: `LayerZero ${m.status.name}: ${m.status.message || ""} (eid ${m.pathway?.srcEid} -> ${m.pathway?.dstEid})`.trim(),
  }));
}

export function ccip(answer) {
  return (answer?.data || []).filter((m) => m.readyForManualExecution).map((m) => ({
    category: "bridge_stuck", chain: m.destNetworkInfo?.chainId ? chainName(m.destNetworkInfo.chainId) : null, asset: null, amount: null, usd: null,
    action: "execute the message by hand on the destination chain", how_to_claim: `https://ccip.chain.link/msg/${m.messageId}`, deadline: null, confidence: "high", source: "bridge.ccip",
    detail: `CCIP ${m.status} from ${m.sourceNetworkInfo?.displayName} to ${m.destNetworkInfo?.displayName}, sent ${m.sendTimestamp}`,
  }));
}

export function lifi(answer) {
  const out = [];
  for (const t of answer?.transfers || []) {
    const pending = t.status === "PENDING" && hoursAgo((t.sending?.timestamp || 0) * 1000) > 24;
    if (t.status !== "FAILED" && !pending && t.substatus !== "PARTIAL") continue;
    const partial = t.substatus === "PARTIAL";
    out.push({
      category: "bridge_stuck", chain: chainName(t.receiving?.chainId || t.sending?.chainId), asset: partial ? t.receiving?.token?.symbol : t.sending?.token?.symbol,
      amount: null, usd: num(partial ? t.receiving?.amountUSD : t.sending?.amountUSD),
      action: partial ? `the transfer arrived as ${t.receiving?.token?.symbol} instead of the token asked for: swap it if you want` : "check the transfer: it failed or never arrived",
      how_to_claim: t.lifiExplorerLink || null, deadline: null, confidence: partial ? "low" : "medium", source: "bridge.lifi",
      detail: `LI.FI ${t.status}/${t.substatus} via ${t.tool}`,
    });
  }
  return out;
}

// Across refunds expired deposits on its own, and its API marks some old filled deposits as unfilled, so an
// unfilled deposit is only a hint to check
export function across(rows) {
  return (Array.isArray(rows) ? rows : []).filter((d) => ["unfilled", "expired", "slowFillRequested"].includes(d.status) && !d.depositRefundTxHash && hoursAgo(d.depositBlockTimestamp) > 6).map((d) => {
    return {
      category: "bridge_stuck", chain: chainName(d.originChainId), asset: d.inputToken, amount: null, usd: null,
      action: "check the deposit on Across: an expired deposit should come back to the origin chain on its own", how_to_claim: `https://app.across.to/transactions`, deadline: null,
      confidence: "low", source: "bridge.across", detail: `Across ${d.status} ${chainName(d.originChainId)} -> ${chainName(d.destinationChainId)}, deposit ${d.depositTxHash}`,
    };
  });
}

export function mayan(answer) {
  return (answer?.data || []).filter((s) => !["COMPLETED", "REFUNDED"].includes(s.clientStatus) && hoursAgo(s.initiatedAt) > 2).map((s) => ({
    category: "bridge_stuck", chain: null, asset: s.fromTokenSymbol, amount: num(s.fromAmount), usd: num(s.fromAmount) != null && num(s.fromTokenPrice) != null ? s.fromAmount * s.fromTokenPrice : null,
    action: "check the swap on Mayan: it did not complete or refund", how_to_claim: `https://explorer.mayan.finance/swap/${s.sourceTxHash}`, deadline: null,
    confidence: "medium", source: "bridge.mayan", detail: `Mayan ${s.status} (${s.clientStatus})`,
  }));
}

export function axelar(answer) {
  return (answer?.data || []).filter((g) => ["error", "insufficient_fee"].includes(g.status) || g.is_insufficient_fee).map((g) => ({
    category: "bridge_stuck", chain: g.call?.chain || null, asset: g.symbol || null, amount: num(g.amount), usd: num(g.value),
    action: g.is_insufficient_fee ? "add gas to the Axelar call so it can execute" : "retry the failed Axelar call", how_to_claim: `https://axelarscan.io/gmp/${g.call?.transactionHash}`,
    deadline: null, confidence: "medium", source: "bridge.axelar", detail: `Axelar ${g.status}`,
  }));
}

// Wormhole ops from Solana (EVM ones are checked by bridge.stuck): a signed VAA with no target tx was never
// redeemed; Mayan Swift and other app ids settle elsewhere, so only the plain transfer apps count
const WH_APPS = new Set(["PORTAL_TOKEN_BRIDGE", "NATIVE_TOKEN_TRANSFER", "CCTP_WORMHOLE_INTEGRATION"]);
export function wormhole(answer) {
  return (answer?.operations || []).filter((o) => !o.targetChain && (o.content?.standarizedProperties?.appIds || []).some((a) => WH_APPS.has(a)) && hoursAgo(o.sourceChain?.timestamp) > 1).map((o) => ({
    category: "bridge_stuck", chain: null, asset: o.data?.symbol || null, amount: num(o.data?.tokenAmount), usd: num(o.data?.usdAmount),
    action: "redeem the Wormhole transfer on the destination chain", how_to_claim: "https://portalbridge.com", deadline: null, confidence: "medium", source: "bridge.wormholescan",
    detail: `Wormhole op ${o.id}, source tx ${o.sourceChain?.transaction?.txHash}`,
  }));
}

// deBridge orders from Solana (EVM ones are checked by bridge.stuck): created and never filled = cancel to refund
export function debridge(answer) {
  return (answer?.orders || []).filter((o) => o.state === "Created" && hoursAgo((o.createdSrcEventMetadata?.blockTimeStamp || 0) * 1000) > 6).map((o) => ({
    category: "bridge_stuck", chain: null, asset: o.giveOfferWithMetadata?.metadata?.symbol || null, amount: null, usd: num(o.giveOfferWithMetadata?.finalAmount?.usdAmount ?? o.giveOfferWithMetadata?.amountUsd),
    action: "cancel the unfilled deBridge order to get the funds back", how_to_claim: `https://app.debridge.finance/order?orderId=${o.orderId?.stringValue || o.orderId}`, deadline: null,
    confidence: "medium", source: "bridge.debridge", detail: `deBridge order ${o.orderId?.stringValue || o.orderId} still Created`,
  }));
}

// ---- forgotten money (forgotten/): old token swaps, expired locks, Stargate fees, dead apps, smart wallets ------
// old tokens with an official swap path (rewards.old_tokens): high when a funded contract pays at a rate it reports
// (SAI, NU, KEEP, REPv1); FTM to S through the Sonic Gateway is medium (the app shows the rate and any fee); OHM v1
// whose migrator holds no gOHM to pay is a low hint without a price
export function oldTokens(data) {
  return (data?.items || []).filter((i) => num(i.amount) > 0).map((i) => ({
    category: "token_migration", chain: i.chain || "ethereum", asset: i.asset, token: String(i.token).toLowerCase(), amount: num(i.amount), usd: i.status === "unfunded" ? null : num(i.usd), protocol: i.protocol,
    action: i.action, how_to_claim: i.how_to_claim, deadline: null, confidence: i.status === "ready" ? "high" : i.status === "check" ? "medium" : "low", source: "rewards.old_tokens", detail: i.detail,
  }));
}

// vote locks (rewards.expired_locks): a lock past its end date (or a vlCVX lock past its epoch: no end given) earns
// nothing and withdraws now = high; a lock still running stays a locked holding (Zerion lists those)
export function expiredLocks(data, { now = Date.now() } = {}) {
  return (data?.items || []).filter((i) => num(i.amount) > 0 && (i.ends == null || Date.parse(i.ends) <= now)).map((i) => ({
    category: "unstake_ready", chain: "ethereum", asset: i.asset, amount: num(i.amount), usd: num(i.usd), protocol: i.protocol, ...(num(i.locked) > 0 && { locked: num(i.locked) }),
    action: i.action, how_to_claim: i.how_to_claim, deadline: null, confidence: "high", source: "rewards.expired_locks",
    detail: i.ends ? `${i.detail}; ended ${i.ends.slice(0, 10)}; or call it on ${i.write}` : `${i.detail}; or call it on ${i.write}`,
  }));
}

// Stargate veSTG fees (rewards.stargate_fees): an entry the distributor says is not claimed = high; claimed ones are
// dropped; one whose isClaimed read failed is a low hint
export function stargateFees(data) {
  return (data?.items || []).filter((i) => i.status !== "claimed" && num(i.amount) > 0).map((i) => ({
    category: "reward", chain: i.chain, asset: i.asset, amount: num(i.amount), usd: num(i.usd), protocol: "Stargate",
    action: i.action, how_to_claim: i.how_to_claim, deadline: null, confidence: i.status === "unclaimed" ? "high" : "low", source: "rewards.stargate_fees",
    detail: i.status === "unclaimed" ? i.detail : `${i.detail} (claimed state not readable)`,
  }));
}

// Balancer pool shares (rewards.balancer): BPT in the wallet (token_migration: summarize() leaves it out of the totals
// when a priced holding lists the same BPT) or staked in a gauge / Aura (unstake_ready), valued at the underlying.
// High when the balance was read onchain and every leg has a trusted price; medium when some leg is unpriced or the
// amount is the API's; no price at all = a low hint. Priced dust is dropped (a deadline would keep it on show)
export function balancer(data, { minUsd = 1 } = {}) {
  return (data?.items || []).filter((i) => num(i.amount) > 0 && (i.usd == null || num(i.usd) >= minUsd)).map((i) => {
    const legs = (i.legs || []).filter((l) => num(l.amount) > 0).map((l) => `${round(l.amount, 4)} ${l.asset || l.token}`).join(" + ");
    return {
      category: i.category, chain: i.chain, asset: i.asset, ...(i.category === "token_migration" && i.token && { token: String(i.token).toLowerCase() }), amount: num(i.amount), usd: num(i.usd), protocol: i.protocol,
      action: i.deadline ? `${i.action} before ${i.deadline}` : i.action, how_to_claim: i.how_to_claim, deadline: i.deadline || null,
      confidence: i.usd == null ? "low" : !i.confirmed || i.unpriced > 0 ? "medium" : "high", source: "rewards.balancer",
      detail: [i.detail, legs && `= ${legs}`, i.unpriced > 0 && `${i.unpriced} leg${i.unpriced === 1 ? "" : "s"} without a trusted price (left out of usd)`,
        i.deadline && `pausable Balancer pools go withdraw-only on ${i.deadline} (BIP-928); exits stay open after`].filter(Boolean).join("; "),
    };
  });
}

// Zerion lists Balancer LPs as deposit / staked positions (one row per underlying token) and adds a deadline row for
// them; once rewards.balancer answered, those rows are the same money as our findings, so they go. Aura rows go too
// on a chain where our read found Aura-staked BPT. veBAL (locked) rows stay: expired_locks covers those
export function dropBalancerTwins(run) {
  if (run.sources?.["rewards.balancer"] !== "ok") return run;
  const aura = new Set(run.findings.filter((f) => f.source === "rewards.balancer" && /aura/i.test(f.how_to_claim || "")).map((f) => sameChain(f.chain)));
  const twin = (x) => /balancer/i.test(x.protocol || "") || (/aura/i.test(x.protocol || "") && aura.has(sameChain(x.chain)));
  return {
    ...run,
    holdings: run.holdings.filter((h) => !(!h.source && ["deposit", "staked"].includes(h.kind) && twin(h))),
    findings: run.findings.filter((f) => !(f.source === "rewards.zerion" && ["token_migration", "unstake_ready"].includes(f.category) && twin(f))),
  };
}

// the same money read twice: Zerion's read and one of our exact sources (KNCL: holdings.zerion "KNC" migration and
// rewards.legacy; Zora rewards: rewards.zerion and rewards.legacy), or Compound III COMP that Merkl pays out now
// (rewards.compound_rewards, whose CometRewards is empty, and rewards.merkl). Same chain, category and amount = one
// row: the exact source stays
const READER_TWINS = [
  { drop: (f) => /zerion/.test(f.source || ""), keep: (g) => !/zerion/.test(g.source || "") },
  { drop: (f) => f.source === "rewards.compound_rewards", keep: (g) => g.source === "rewards.merkl" },
];
const sameAmount = (a, b) => a > 0 && b > 0 && Math.abs(a - b) <= Math.max(a, b) * 1e-4;
export function dropReaderTwins(findings) {
  const twin = (f, g) => g !== f && g.category === f.category && sameChain(g.chain) === sameChain(f.chain) && sameAmount(num(f.amount), num(g.amount));
  return findings.filter((f) => !READER_TWINS.some((r) => r.drop(f) && findings.some((g) => r.keep(g) && twin(f, g))));
}

// one holding worth more than this is a bad price or a fake balance (0x...dEaD holds 4e32 XP on Xphere): it is kept,
// as unverified, so it cannot fill holdings_usd
export const ABSURD_USD = 1e11;
export const saneHolding = (h) => (h.verified && (h.usd ?? 0) > ABSURD_USD ? { ...h, verified: false, note: "worth over $100B: a bad price or a fake balance" } : h);

// Aerodrome / Velodrome veNFTs (rewards.ve_nfts): voting fees and bribes with a trusted price = high (an unpriced
// bribe token is mostly spam: a low hint); a rebase of a running lock is medium (claiming adds it to the lock, it is
// not spendable); an ended lock = unstake_ready, high when priced
export function veNfts(data) {
  return (data?.items || []).filter((i) => num(i.amount) > 0).map((i) => ({
    category: i.category, chain: i.chain, asset: i.asset, amount: num(i.amount), usd: i.priced ? num(i.usd) : null, protocol: i.protocol,
    action: i.action, how_to_claim: i.how_to_claim, deadline: null,
    confidence: !i.priced ? (i.category === "unstake_ready" ? "medium" : "low") : i.into_lock ? "medium" : "high", source: "rewards.ve_nfts",
    detail: i.priced ? i.detail : `${i.detail}; no trusted price${i.category === "reward" ? ": check the token before claiming" : ""}`,
  }));
}

// single-contract leftovers (rewards.dead_apps): GLP to sell, Element PT/YT/LP, EntryPoint gas deposits, Lighter
// withdrawals waiting on Ethereum. High when the contract prices it or the asset is a stable/native coin; medium
// without a price, or when a smart account's deposit needs a withdraw function it may not have
export function deadApps(data) {
  return (data?.items || []).filter((i) => num(i.amount) > 0).map((i) => ({
    category: i.category, chain: i.chain, asset: i.asset, ...(i.token && i.token !== "native" && { token: i.token }), amount: num(i.amount), usd: num(i.usd), protocol: i.protocol,
    action: i.action, how_to_claim: i.how_to_claim, deadline: null, confidence: i.status === "ready" && i.usd != null ? "high" : "medium", source: "rewards.dead_apps", detail: i.detail,
  }));
}

// smart wallets the address controls alone (holdings.smart_wallets: L2 DSProxies, Instadapp DSAs, 1-owner Safes,
// ERC-4337 accounts whose owner read names it, or not deployed yet: the factory's address already binds the owner):
// their priced tokens are holdings (money the owner may not see in its portfolio); Aave debt is a negative loan row.
// A 4337 account whose owner read is unclear is never a holding: smartWalletHints makes it one low finding
export function smartWallets(data, { minUsd = 1 } = {}) {
  return (data?.items || []).filter((i) => i.verified && !i.hint && Math.abs(num(i.usd) ?? 0) >= minUsd).map((i) => ({
    kind: i.kind, chain: i.chain, asset: i.asset, ...(i.token !== "native" && { token: i.token }), amount: round(i.amount, 6), usd: round(i.usd), protocol: i.protocol,
    verified: true, source: "holdings.smart_wallets", detail: i.detail,
  }));
}

// a guess (a 4337 account its factory made for this owner that now answers to another validator, or has code that
// skips the owner check): one low hint per account with what it holds, out of the totals
export function smartWalletHints(data, { minUsd = 1 } = {}) {
  const by = new Map();
  for (const i of (data?.items || []).filter((x) => x.hint && x.kind === "token")) by.set(`${i.chain}:${i.wallet.toLowerCase()}`, [...(by.get(`${i.chain}:${i.wallet.toLowerCase()}`) || []), i]);
  return [...by.values()].map((list) => {
    const usd = list.reduce((t, i) => t + (i.verified ? num(i.usd) ?? 0 : 0), 0), top = [...list].sort((a, b) => (num(b.usd) ?? 0) - (num(a.usd) ?? 0))[0];
    return { usd, list, top };
  }).filter((x) => x.usd >= minUsd).map(({ usd, list, top }) => ({
    category: "reward", chain: top.chain, asset: list.length > 1 ? `${top.asset} +${list.length - 1}` : top.asset, amount: list.length > 1 ? null : round(top.amount, 6), usd: round(usd), protocol: top.protocol,
    action: `check who controls smart account ${top.wallet} before moving anything`, how_to_claim: top.how_to_claim || null, deadline: null, confidence: "low", source: "holdings.smart_wallets", detail: top.detail,
  }));
}

// Zerion lists some of the positions our own reads cover (a veCRV lock as "locked", a Kelp withdrawal as "locked
// ETH", staked GLP, a PancakeSwap or Alpaca farm stake): when a finding from our read and a Zerion row on the same chain
// share the protocol and the amount (within 3%), the Zerion row goes, so the same money is not both a finding and a
// holding. vlCVX: our finding is the unlockable part, Zerion's row the whole lock, so that row keeps the locked rest.
// Same for Zerion's rows of a matured Pendle PT / YT / LP, a Lido or EigenLayer withdrawal and a finished Venice unstake
const TWIN_SOURCES = new Set(["rewards.expired_locks", "rewards.lrt_withdrawals", "rewards.dead_apps", "rewards.bnb_farms", "rewards.pendle", "rewards.lido_withdrawals", "rewards.eigenlayer_withdrawals", "rewards.venice", "rewards.ve_nfts"]);
const TWIN_NAME = { veCRV: "curve", veFXS: "frax", veBAL: "balancer", vlCVX: "convex", "Liquid Collective": "liquid collective", "ether.fi": "ether.fi", "GMX v1": "gmx", "PancakeSwap MasterChef v1": "pancakeswap" };
export function dropZerionTwins(run) {
  // dead_apps: only staked GLP (EntryPoint deposits, Element and Lighter have no Zerion position); bnb_farms: stakes and
  // their pending rewards (a wallet-held ibToken or LP is a token_migration, which summarize() matches to the holding);
  // pendle: the matured positions, not its merkle rewards; venice: the finished unstake, not its staking rewards
  const ours = run.findings.filter((f) => TWIN_SOURCES.has(f.source) && (f.source !== "rewards.dead_apps" || f.protocol === "GMX v1") && f.category !== "token_migration"
    && (f.source !== "rewards.pendle" || /^(PT|YT|LP)-/.test(f.asset || "")) && (f.source !== "rewards.venice" || f.category === "unstake_ready"));
  if (!ours.length) return run;
  const near = (a, b) => a != null && b != null && b !== 0 && Math.abs(a - b) / Math.abs(b) <= 0.03;
  const twinOf = (x) => x.protocol && ours.find((f) => sameChain(x.chain) === sameChain(f.chain) && String(x.protocol).toLowerCase().includes(TWIN_NAME[f.protocol] || String(f.protocol).split(" ")[0].toLowerCase())
    && (near(x.amount, f.amount) || near(x.usd, f.usd) || (f.locked > 0 && near(x.amount, f.amount + f.locked))));
  const holdings = [];
  for (const h of run.holdings) {
    const f = !h.source && ["locked", "deposit", "staked"].includes(h.kind) ? twinOf(h) : null;
    if (!f) { holdings.push(h); continue; }
    // the whole vlCVX lock: what is still locked stays a locked holding, priced at Zerion's rate
    if (f.locked > 0 && !near(h.amount, f.amount)) holdings.push({ ...h, amount: round(f.locked, 6), usd: h.usd == null ? null : round(h.usd * f.locked / h.amount) });
  }
  return { ...run, holdings, findings: run.findings.filter((f) => !(f.source === "rewards.zerion" && ["unstake_ready", "reward"].includes(f.category) && twinOf(f))) };
}

// unclaimed/ reads these protocols' contracts: Zerion's reward rows for them would count twice, except on a chain whose
// read failed (failed: source id -> Set of chains, from failedChains). Polygon's zkEVM claimer (it answered ok and lists
// the wallet) or an exact exit claim replaces the shut-down chain hints: the every-chain sweep's chain 1101 row and
// Zerion's polygon-zkevm balance, a frozen copy of the same money
const DIRECT = { "rewards.uniswap_fees": /uniswap/i, "rewards.hedgey": /hedgey/i, "rewards.superfluid": /superfluid/i, "rewards.flaunch": /flaunch/i, "rewards.token_locks": /uncx|unicrypt|team finance|unvest/i };
export const failedChains = (errors) => new Set((errors || []).map((e) => sameChain(String(e).split(":")[0].split(" ").pop())));
export function dropDirectTwins(run, { failed = {}, zkevmKnown = false } = {}) {
  const direct = Object.entries(DIRECT).filter(([id]) => run.sources?.[id] === "ok");
  const zkevm = (zkevmKnown && run.sources?.["bridge.polygon_zkevm"] === "ok") || run.findings.some((x) => x.source === "bridge.polygon_zkevm");
  const ours = (f) => f.source === "rewards.zerion" && direct.some(([id, re]) => re.test(f.protocol || "") && !failed[id]?.has(sameChain(f.chain)));
  const hint = (f) => zkevm && ((f.source === "holdings.chains" && f.chain_id === 1101) || (f.source === "holdings.zerion" && f.category === "bridge_stuck" && f.chain === "polygon-zkevm"));
  return { ...run, findings: run.findings.filter((f) => !ours(f) && !hint(f)) };
}

// dead BNB Chain farms (rewards.bnb_farms): stakes left in PancakeSwap MasterChef v1, AutoFarm, Ellipsis, Nerve,
// BakerySwap, Alpaca FairLaunch (unstake_ready), their pending rewards (reward) and Alpaca v1 ibTokens / dead pool
// tokens in the wallet (token_migration); unpriced rows stay at medium, priced dust under $1 is dropped
export function bnbFarms(data, { minUsd = 1 } = {}) {
  return (data?.items || []).filter((i) => num(i.amount) > 0 && (i.usd == null || num(i.usd) >= minUsd)).map((i) => ({
    category: i.category, chain: i.chain || "bsc", asset: i.asset, ...(i.category === "token_migration" && i.token && { token: String(i.token).toLowerCase() }), amount: num(i.amount), usd: i.usd == null ? null : num(i.usd), protocol: i.protocol,
    action: i.action, how_to_claim: i.how_to_claim, deadline: null, confidence: i.status === "ready" && i.usd != null ? "high" : "medium", source: "rewards.bnb_farms",
    detail: i.position === "staked" && i.pid != null ? `${i.detail} (pool ${i.pid})` : i.detail,
  }));
}

// LRT / LST withdrawal queues (rewards.lrt_withdrawals): one finding per protocol + asset + state; finished (or past
// its only time gate) = high, still queued = medium with the expected time
export function lrtWithdrawals(data, { ethUsd, now = Date.now() } = {}) {
  const at = new Date(now).toISOString(), groups = new Map();
  for (const i of data?.items || []) {
    const amount = num(i.amount);
    if (!(amount > 1e-6) || (i.status !== "ready" && i.status !== "pending")) continue;
    const ready = i.status === "ready" || (!!i.ready_at && i.ready_at <= at);
    const key = `${i.protocol}|${i.asset}|${ready}`;
    const g = groups.get(key) || { protocol: i.protocol, chain: i.chain || "ethereum", asset: i.asset, how_to_claim: i.how_to_claim, ready, amount: 0, usd: 0, priced: true, ids: [], details: [], waits: [] };
    const usd = i.usd != null ? num(i.usd) : i.asset === "ETH" && ethUsd ? amount * ethUsd : null;
    g.amount += amount;
    if (usd == null) g.priced = false; else g.usd += usd;
    g.ids.push(i.id);
    g.details.push(i.detail);
    if (!ready && (i.ready_at || i.eta)) g.waits.push(i.ready_at || i.eta);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => {
    const n = g.ids.length, s = n > 1 ? "s" : "", first = g.waits.sort()[0];
    return {
      category: "unstake_ready", chain: g.chain, asset: g.asset, amount: round(g.amount, 6), usd: g.priced ? round(g.usd) : null, protocol: g.protocol,
      action: g.ready ? `claim ${n} finished ${g.protocol} withdrawal${s}` : `${n} ${g.protocol} withdrawal${s} still in the queue${first ? `, expected about ${first.slice(0, 10)}` : ""}: claim once finalized`,
      how_to_claim: g.how_to_claim, deadline: null, confidence: g.ready ? "high" : "medium", source: "rewards.lrt_withdrawals",
      detail: n === 1 ? g.details[0] : `requests ${g.ids.join(", ")}`,
    };
  });
}

// dead-protocol tokens that still redeem for their underlying (rewards.dead_defi: deaddefi.com's 46 Ethereum tokens) +
// the Pickle Finance USDC merkle payout; high = valued by the token's own redeem math, fully priced, the market can
// pay it and no loan sits on it; medium = partly priced, limited or strategy-backed, or only a market price;
// low = unpriced, unreadable or no liquidity. A dForce loan secured by the deposit is taken off usd.
export function deadDefi(data) {
  const out = [];
  for (const i of data?.items || []) {
    const amount = num(i.amount);
    if (!(amount > 0) || i.status === "claimed") continue;
    let usd = i.usd == null ? null : num(i.usd);
    const debt = num(i.debt_usd) || 0;
    if (usd != null && debt > 0) usd = Math.max(0, usd - debt);
    if (usd != null && usd < 0.01) continue; // dust, or fully owed to the loan it secures
    let confidence;
    if (i.category === "airdrop") confidence = i.status === "ready" ? "high" : "medium";
    else if (usd == null || i.status === "unreadable" || i.liquidity === "none") confidence = "low";
    else if (i.valued_by === "contract" && i.status === "redeemable" && i.liquidity === "covers" && !i.unpriced && !debt) confidence = "high";
    else confidence = "medium";
    out.push({
      category: i.category, chain: i.chain || "ethereum", asset: i.asset, ...(i.category === "token_migration" && i.token && { token: String(i.token).toLowerCase() }),
      amount: round(amount, 6), usd: usd == null ? null : round(usd), protocol: i.protocol,
      action: i.action, how_to_claim: i.how_to_claim, deadline: null, confidence, source: "rewards.dead_defi",
      detail: debt > 0 && i.usd != null ? `${i.detail}; usd is the $${round(num(i.usd))} it redeems for minus the $${round(debt)} loan` : i.detail,
    });
  }
  return out;
}

// Solana leftovers (sol.leftovers): Serum v3 OpenOrders funds + rent, Marinade delayed-unstake tickets, program buffers
export function solLeftovers(data, { solUsd, epoch } = {}) {
  const out = [];
  const ep = epoch ?? data?.epoch ?? null;
  const solOf = (i) => (solUsd ? i.amount * solUsd : num(i.usd));
  const base = (i) => ({ chain: "solana", protocol: i.protocol, deadline: null, source: "sol.leftovers", how_to_claim: i.how_to_claim, action: i.action });
  const buffers = [];
  for (const i of data?.items || []) {
    if (!(num(i.amount) > 0)) continue;
    if (i.protocol === "Serum" && i.category === "unstake_ready") {
      // tokens left in a dead Serum market: high only when settle alone frees them, the market vault still holds
      // them and Jupiter verifies the mint with a price; resting orders need a cancel + crank first (medium);
      // unverified or unpriced mints are a hint without usd (low)
      const trusted = i.verified && num(i.price) != null, thin = trusted && thinMarket(i.liquidity, num(i.usd));
      if (trusted && num(i.usd) != null && i.usd < 0.01) continue;
      out.push({
        ...base(i), category: "unstake_ready", asset: i.asset, mint: i.token, amount: i.amount, usd: trusted ? num(i.usd) : null,
        confidence: !trusted || thin ? "low" : i.status === "ready" && i.vault_covers ? "high" : "medium",
        detail: [i.detail, !trusted && "token not verified by Jupiter or no price: check it by hand", thin && `thin market (about $${Math.round(i.liquidity)} liquidity): this price cannot be sold into`].filter(Boolean).join("; "),
      });
    } else if (i.protocol === "Serum" && i.category === "solana_rent") {
      // OpenOrders rent comes back with CloseOpenOrders: high when the accounts only need a settle, medium when
      // resting orders must be cancelled first
      out.push({ ...base(i), category: "solana_rent", asset: "SOL", amount: round(i.amount, 6), usd: solOf(i), txs: Math.ceil((i.count || 1) / 5), confidence: i.status === "ready" ? "high" : "medium", detail: i.detail });
    } else if (i.protocol === "Marinade") {
      // claimable from epoch created_epoch + 1, 30 minutes after it starts (Marinade claim.rs): ready = high,
      // the first eligible epoch = medium (may still be in its first 30 min), earlier = medium (pending)
      const e = ep ?? i.epoch, created = num(i.created_epoch);
      const ready = e != null && created != null && e > created + 1;
      const pending = e != null && created != null && e <= created;
      out.push({
        ...base(i), category: "unstake_ready", asset: "SOL", amount: round(i.amount, 6), usd: solOf(i), confidence: ready ? "high" : "medium",
        action: ready ? i.action : pending ? `Marinade delayed unstake ticket claimable from epoch ${created + 1} (now ${e})` : i.action,
        detail: `${i.detail}${ready ? "" : pending ? "; not due yet" : "; due this epoch, the claim opens 30 minutes after the epoch starts"}`,
      });
    } else if (i.category === "solana_rent") buffers.push(i);
  }
  if (buffers.length) {
    // program buffers: the authority closes them for every lamport, nothing else to wait for (high)
    const sol = buffers.reduce((t, b) => t + b.amount, 0);
    out.push({
      chain: "solana", protocol: "Solana program buffer", category: "solana_rent", asset: "SOL", amount: round(sol, 6), usd: solUsd ? sol * solUsd : buffers.every((b) => b.usd != null) ? buffers.reduce((t, b) => t + b.usd, 0) : null,
      txs: buffers.length, deadline: null, confidence: "high", source: "sol.leftovers", how_to_claim: buffers.length === 1 ? buffers[0].how_to_claim : "https://solana.com/docs/programs/deploying#close-your-program",
      action: buffers.length === 1 ? buffers[0].action : `close ${buffers.length} leftover program buffers: solana program show --buffers, then solana program close <buffer> for each`,
      detail: `upgradeable-loader buffers the wallet is authority of, left by failed or unfinished deploys: ${buffers.map((b) => `${b.buffer} ${round(b.amount, 4)} SOL`).join(", ")}`,
    });
  }
  return out;
}

// Streamflow's calculateUnlockedAmount (js-sdk contractUtils.ts) on the raw stream fields, BigInt, seconds
const sfUnlocked = (s, t) => {
  const now = BigInt(Math.floor(t)), dep = BigInt(s.deposited), cliff = BigInt(s.cliff), end = BigInt(s.end), period = BigInt(s.period || 0), last = BigInt(s.last_rate_change_time || 0);
  if (now < cliff) return 0n;
  if (now > end) return dep;
  const saved = last === 0n ? BigInt(s.cliff_amount) : BigInt(s.funds_unlocked_at_last_rate_change || 0);
  const streamed = period > 0n ? ((now - (last === 0n ? cliff : last)) / period) * BigInt(s.amount_per_period) + saved : saved;
  return streamed < dep ? streamed : dep;
};
// Streamflow vesting / lock streams (sol.vesting_streams): the unlocked, unwithdrawn part is a vesting finding
// (high with a Jupiter-verified priced mint, else a low hint without usd); the still-locked rest is a locked holding
export function solStreams(data, { now = Date.now() } = {}) {
  const findings = [], holdings = [];
  for (const i of data?.items || []) {
    if (i.category !== "vesting" || i.deposited == null) continue;
    const dec = 10 ** Number(i.decimals || 0), dep = BigInt(i.deposited), wd = BigInt(i.withdrawn || 0), escrow = BigInt(i.escrow_raw ?? i.deposited);
    const unlocked = sfUnlocked(i, now / 1000);
    let free = unlocked - wd;
    if (free > escrow) free = escrow; // the escrow pays it: never more than it holds
    const locked = dep - (unlocked > wd ? unlocked : wd);
    const trusted = i.verified && num(i.price) != null;
    const usdOf = (raw) => (trusted ? round((Number(raw) / dec) * i.price) : null);
    const name = i.name ? ` "${i.name}"` : "", thin = trusted && thinMarket(i.liquidity, usdOf(free));
    if (free > 0n && !(trusted && usdOf(free) < 0.01)) findings.push({
      category: "vesting", chain: "solana", protocol: "Streamflow", asset: i.asset, mint: i.token, amount: Number(free) / dec, usd: usdOf(free),
      action: `withdraw the unlocked ${i.asset} from the Streamflow stream${name}`, how_to_claim: i.how_to_claim, deadline: null,
      confidence: !trusted || thin ? "low" : i.status === "paused" ? "medium" : "high", source: "sol.vesting_streams",
      detail: [`stream ${i.stream} from ${i.sender}, ${now / 1000 > Number(i.end) ? `fully unlocked since ${String(i.ends).slice(0, 10)}` : `unlocks until ${String(i.ends).slice(0, 10)}`}, no expiry`, i.status === "paused" && "stream is paused by the sender", i.status === "canceled" && "stream was canceled", !trusted && "token not verified by Jupiter or no price: check it by hand", thin && `thin market (about $${Math.round(i.liquidity)} liquidity): this price cannot be sold into`].filter(Boolean).join("; "),
    });
    if (locked > 0n && i.status !== "canceled") holdings.push({
      kind: "locked", chain: "solana", protocol: "Streamflow", asset: i.asset, mint: i.token, amount: Number(locked) / dec, usd: usdOf(locked), verified: !!i.verified && !thinMarket(i.liquidity, usdOf(locked)),
      detail: `still locked in Streamflow stream ${i.stream}${name}, unlocks until ${String(i.ends).slice(0, 10)}`,
    });
  }
  return { findings, holdings };
}

// ---- every chain (chains/) ---------------------------------------------------------------------------------
// what Zerion answered (holdings.zerion): "<chain>" for each chain and "<chain>:<token address | native>" for each
// balance, so the every-chain sweep can drop what Zerion already counts
export function zerionSeen(answer) {
  const seen = new Set();
  for (const p of answer?.data || []) {
    const chain = p.relationships?.chain?.data?.id;
    if (!chain) continue;
    const impl = (p.attributes?.fungible_info?.implementations || []).find((i) => i.chain_id === chain);
    seen.add(chain);
    // a row Zerion has no price for counts nowhere, so the sweep's priced read of it stays (kpdUSDC: $5,000 unpriced)
    // by symbol too: Zerion gives some native coins a token address (MNT on Mantle), the sweep calls them native
    if (num(p.attributes?.value) > 0) seen.add(`${chain}:${String(impl?.address || "native").toLowerCase()}`).add(`${chain}:$${p.attributes?.fungible_info?.symbol}`);
  }
  return seen;
}
// on a chain Zerion answered for, a sweep row stays only when it is a verified token Zerion missed (indexes lag:
// ENA on HyperEVM, vault receipts); balances on shut-down chains are left to the Zerion deadline match there
export const zerionDrops = (seen, x) => x.source === "holdings.chains" && seen.has(x.chain) && (!!x.category || !x.verified || seen.has(`${x.chain}:${x.token || "native"}`) || seen.has(`${x.chain}:$${x.asset}`));

// holdings.chains: balances -> holdings (on a chain with no new block for a month: unverified, with a warning); a
// balance left on a shut-down chain -> bridge_stuck with its exit path and deadline; past deposits into a shut-down
// chain where nothing can be read any more -> a low hint
export function chainSweep(data, { minUsd = 1 } = {}) {
  const findings = [], holdings = [];
  for (const b of data?.balances || []) {
    if (b.usd != null && b.usd < minUsd) continue;
    const warn = [b.locked && "vault share that cannot be withdrawn now (maxWithdraw 0): not counted in holdings_usd; check the protocol's redeem or migration page", b.halted && `no new block since ${b.halted}: the chain may be halted`, !b.verified && (b.price_from === "explorer" ? "price from the explorer only" : b.price_from === "alchemy" ? "price from Alchemy only" : b.price_from === "none" ? "no price" : "thin market") + ": check before selling"].filter(Boolean);
    holdings.push({
      kind: b.locked ? "locked" : "token", chain: b.chain, chain_id: b.chain_id, asset: b.asset, amount: round(b.amount, 6), usd: round(b.usd), ...(b.token !== "native" && { token: b.token }),
      verified: !!b.verified && !b.halted, source: "holdings.chains", ...(warn.length && { detail: warn.join("; ") }),
      ...(b.locked && { action: "withdrawals are off in this vault for now: find its redeem or migration path", how_to_claim: Number(b.chain_id) === 1 && b.token !== "native" ? `https://etherscan.io/token/${b.token}` : null }),
    });
  }
  for (const s of data?.sunset || []) {
    const when = s.when || `${s.name} ${s.status === "closing" ? "is closing" : "shut down"}`;
    const past = s.closes && s.closes < new Date().toISOString().slice(0, 10); // the window closed: maybe gone, a hint only
    const action = past ? `the exit window closed on ${s.closes}: ask the ${s.name} team. ${s.exit}` : s.closes ? `get it out before ${s.closes}: ${s.exit}` : s.exit;
    for (const b of s.balances || []) findings.push({
      category: "bridge_stuck", chain: s.chain, chain_id: s.chain_id, asset: b.asset, amount: round(b.amount, 6), usd: b.usd, action, how_to_claim: s.link, deadline: s.closes, ...(past && { expired: true }),
      confidence: b.verified && !past ? "medium" : "low", source: "holdings.chains", detail: `${when}; balance read from its ${s.read === "rpc" ? "RPC" : "explorer"}`,
    });
    if (!s.balances?.length && s.deposits_count) findings.push({
      category: "bridge_stuck", chain: s.chain, chain_id: s.chain_id, asset: null, amount: null, usd: null, how_to_claim: s.link, deadline: s.closes, ...(past && { expired: true }), confidence: "low", source: "holdings.chains",
      action: `this wallet bridged to ${s.name} (${s.deposits_count} deposit${s.deposits_count > 1 ? "s" : ""}, last ${s.deposits[0]?.date || "?"}): check for funds left there. ${action}`,
      detail: `${when}; no RPC or explorer still answers, so the balance could not be read`,
    });
  }
  return { findings, holdings };
}

// ---- airdrops ----------------------------------------------------------------------------------------------
// Jupiter's Solana checker: eligible, not claimed and the claim window open = high; claim not open yet = low
// (a heads-up, out of the totals). Claimed, expired and ineligible items are dropped.
export function jupiterAirdrops(answer, { now = Date.now() } = {}) {
  const out = [];
  for (const o of Array.isArray(answer) ? answer : []) {
    for (const a of o.airdrops || []) {
      const ended = a.claimEnd && now > a.claimEnd, notYet = a.claimStart && now < a.claimStart;
      if (ended || /closed|expired/i.test(a.status || "")) continue;
      for (const i of a.items || []) {
        if (!i.isEligible || i.isClaimed || !(num(i.amount) > 0) || /claimed|expired|ineligible/i.test(i.status || "")) continue;
        const name = [a.emitterName, a.label].filter(Boolean).join(" ") || a.id, open = !notYet && /open/i.test(a.status || "");
        out.push({
          category: "airdrop", chain: "solana", asset: i.label || i.address, mint: i.address, amount: num(i.amount), usd: num(i.value),
          action: open ? `claim the ${name} airdrop` : `the ${name} airdrop opens ${a.claimStart ? new Date(a.claimStart).toISOString().slice(0, 10) : "soon"}: claim it then`,
          how_to_claim: a.claimLink || "https://jup.ag/portfolio/airdrop-checker", deadline: a.claimEnd ? new Date(a.claimEnd).toISOString().slice(0, 10) : null,
          confidence: open ? "high" : "low", source: "airdrop.jupiter", detail: `Jupiter airdrop checker (${a.id}), eligible and not claimed`,
        });
      }
    }
  }
  return out;
}

// Streamflow distributors (airdrop.streamflow, spam already dropped): medium, since anyone can make a
// distributor; a mint Jupiter does not verify (only Streamflow does) is a low hint
export function streamflow(data) {
  return (data?.items || []).map((i) => ({
    category: "airdrop", chain: "solana", asset: i.symbol || i.mint, mint: i.mint, amount: i.claimable, usd: i.usd,
    action: `claim ${i.symbol} from the Streamflow airdrop${i.name ? ` "${i.name}"` : ""}`, how_to_claim: i.claim_url, deadline: null,
    confidence: i.verified && !thinMarket(i.liquidity, i.usd) ? "medium" : "low", source: "airdrop.streamflow",
    detail: [`Streamflow distributor ${i.distributor}`, i.locked > 0 && `${Math.round(i.locked * 1e4) / 1e4} more still vesting${i.vesting_end ? ` until ${i.vesting_end}` : ""}`, !i.verified && "token not verified by Jupiter", thinMarket(i.liquidity, i.usd) && `thin market (about $${Math.round(i.liquidity)} liquidity): this price cannot be sold into`].filter(Boolean).join("; "),
  }));
}

// our own index (airdrop.index): only unclaimed hits; high = the onchain read says unclaimed and the window is
// open, low = on a list whose claim we cannot read (a hint). Claimed and expired items never become findings.
export function airdropIndex(data, { now = Date.now() } = {}) {
  const today = new Date(now).toISOString().slice(0, 10);
  return (data?.items || []).filter((i) => (i.status === "unclaimed" || i.status === "unknown") && (!i.deadline || i.deadline >= today)).map((i) => {
    const vest = i.kind === "vesting", sure = i.status === "unclaimed";
    return {
      category: "airdrop", chain: i.chain, asset: i.symbol || i.name, amount: num(i.amount), usd: num(i.usd),
      action: vest ? i.action || `withdraw the vested ${i.symbol} from your ${i.name}` : sure ? `claim the ${i.name} airdrop` : `check the ${i.name} airdrop: the wallet is on its list`,
      how_to_claim: i.claim_url || null, deadline: i.deadline || null, confidence: sure ? "high" : "low", source: "airdrop.index",
      detail: [vest ? `${i.vesting_id ? `vesting ${i.vesting_id} in` : "held in"} ${i.contract}${i.vesting_end ? `, fully vested ${i.vesting_end}` : ""}` : `${i.source} list ${i.id}${sure ? `, not claimed from ${i.distributor} (checked ${i.source === "sablier" ? "in Sablier's indexer" : "onchain"})` : ""}`, i.detail].filter(Boolean).join("; "),
    };
  });
}

// ---- GoPlus token checks (token.goplus_evm / token.goplus_sol, one token per call on the free tier) -----------
// one token's GoPlus row -> { spam: why it is likely worthless, or null; warn; trusted; liquidity: USD in its DEX pools (EVM) }
const on = (v) => v === "1" || v === 1;
export function goplusVerdict(r, { solana = false } = {}) {
  if (!r || typeof r !== "object") return null;
  const tax = num(r.sell_tax), pct = (v) => `${Math.round(v * 100)}%`;
  const spam = solana
    ? [on(r.balance_mutable_authority?.status) && "its owner can change balances", on(r.non_transferable) && "it cannot be transferred",
      ["freezable", "mintable", "closable", "balance_mutable_authority"].some((k) => (r[k]?.authority || []).some((a) => on(a.malicious_address))) && "a known malicious address controls it"]
    : [on(r.is_honeypot) && "honeypot: it cannot be sold", on(r.is_airdrop_scam) && "airdrop scam", on(r.fake_token?.value) && "fake copy of a real token",
      on(r.cannot_sell_all) && "it cannot all be sold", tax >= 0.5 && `sell tax ${pct(tax)}`];
  const warn = solana
    ? [!on(r.trusted_token) && on(r.freezable?.status) && "its owner can freeze it", on(r.closable?.status) && "its owner can close it"]
    : [tax > 0.05 && tax < 0.5 && `sell tax ${pct(tax)}`, on(r.transfer_pausable) && "transfers can be paused", on(r.is_blacklisted) && "it has a blacklist"];
  const why = (xs) => xs.filter(Boolean).join("; ") || null;
  const dex = !solana && Array.isArray(r.dex) && r.dex.length ? r.dex.reduce((t, d) => t + (num(d.liquidity) ?? 0), 0) : null;
  return { spam: why(spam), warn: why(warn), trusted: on(solana ? r.trusted_token : r.trust_list), liquidity: dex };
}

// a verdict on one holding or finding: spam holdings get spam (finish() drops them), spam findings go low (out of the
// totals); a token on GoPlus's trust list counts as verified. A thin market (DEX pools hold under twice the row's
// value, the solHoldings rule) cannot pay that price: a finding goes low, a holding stays unverified
export function applyGoplus(row, v) {
  if (!v) return row;
  const notes = [];
  const thin = !v.trusted && v.liquidity != null && (row.usd ?? 0) > 0 && v.liquidity < row.usd * 2;
  if (v.spam) {
    notes.push(`GoPlus: ${v.spam}`);
    if (row.category) row.confidence = "low"; else row.spam = true;
  } else if (v.trusted && !row.category && !row.verified) {
    row.verified = true;
    row.detail = String(row.detail || "").replace(/^not verified by \w+: check before selling;? ?/, "") || null;
    notes.push("on GoPlus's trust list");
  }
  if (thin) {
    notes.push(`thin market (about $${Math.round(v.liquidity)} DEX liquidity per GoPlus): this price cannot be sold into`);
    if (row.category) row.confidence = "low";
  }
  if (v.warn) notes.push(`GoPlus: ${v.warn}`);
  if (notes.length) row.detail = [row.detail, ...notes].filter(Boolean).join("; ");
  return row;
}

// the same money listed twice: a position and its receipt token (Venice sVVV staked + the sVVV token), or one pool
// under two names (mStable mUSD). Same chain, asset and amount: the position row stays, a verified row beats an
// unverified one. Loans are never merged.
export function dedupeHoldings(holdings) {
  const rank = (h) => (h.kind !== "token" ? 2 : 0) + (h.verified ? 1 : 0);
  const key = (h) => `${h.chain}|${String(h.asset).toLowerCase()}|${Number(h.amount).toPrecision(9)}`;
  const best = new Map();
  for (const h of holdings) {
    if (h.kind === "loan" || !(num(h.amount) > 0)) continue;
    const b = best.get(key(h));
    if (!b || rank(h) > rank(b)) best.set(key(h), h);
  }
  return holdings.filter((h) => h.kind === "loan" || !(num(h.amount) > 0) || best.get(key(h)) === h);
}

// ---- who must act ---------------------------------------------------------------------------------------------
// bucket on every finding (and totals.by_bucket), so an answer can say who has to move first:
//   you_can_claim      the wallet can act now (high: the source says claimable; medium: check the amount in the app)
//   team_must_release  the money exists but the protocol or team must act first: a bridge exit only its team can
//                      unblock, a sunset chain with no exit path, a market holding nothing to pay out, a distributor
//                      vault short of the amount, an airdrop whose claim has not opened yet
//   may_not_work       low confidence hints and windows that already closed
export const BUCKETS = ["you_can_claim", "team_must_release", "may_not_work"];
// sunset-chains.json exits start "None now", "Nothing known", "Nothing possible"... ("Nothing to do" = already moved for you)
const TEAM_ACTION = /until the .+ team acts|(^|: )(none|nothing)\b(?! to do)|officially none|no exit guidance|no (exit|claim)( or claim)? path|opens \S+: claim it then/i;
const TEAM_DETAIL = /holds no underlying|distributor vault holds only/i;
export function bucketOf(f) {
  if (f.category === "bridge_blocked") return "team_must_release";
  if (f.expired) return "may_not_work";
  if (TEAM_ACTION.test(f.action || "") || TEAM_DETAIL.test(f.detail || "")) return "team_must_release";
  return f.confidence === "low" ? "may_not_work" : "you_can_claim";
}

// ---- totals -------------------------------------------------------------------------------------------------
export function summarize(findings, holdings, { minUsd = 1 } = {}) {
  const shown = findings.filter((f) => f.usd == null || f.usd >= minUsd || f.deadline).map((f) => ({ ...f, bucket: bucketOf(f) }));
  // biggest first; low hints and closed windows go last, whatever their value
  const tail = (f) => (f.confidence === "low" || f.expired ? 1 : 0), order = { high: 0, medium: 1, low: 2 };
  shown.sort((a, b) => tail(a) - tail(b) || (b.usd ?? -1) - (a.usd ?? -1) || order[a.confidence] - order[b.confidence]);
  // a token_migration row is a balance already in holdings, except old tokens redeemed by rewards.legacy (GNT, DGD: no market price)
  // and any whose token no priced holding lists (SAI, iwstETH: portfolio APIs skip or misprice them, the redeem value is the money)
  const held = new Set(holdings.filter((h) => h.token && (h.usd ?? 0) > 0).map((h) => `${sameChain(h.chain)}:${String(h.token).toLowerCase()}`));
  const twin = (f) => !(f.category !== "token_migration" || f.source === "rewards.legacy" || (f.token && !held.has(`${sameChain(f.chain)}:${String(f.token).toLowerCase()}`)));
  const counted = shown.filter((f) => f.confidence !== "low" && !twin(f) && f.category !== "bridge_blocked");
  const high = counted.filter((f) => f.confidence === "high"), medium = counted.filter((f) => f.confidence === "medium");
  const sum = (xs, k = "usd") => round(xs.reduce((t, f) => t + (f[k] ?? 0), 0));
  const spendable = holdings.filter((h) => h.kind !== "locked");
  // usd per bucket adds every priced row in it (low hints too: what they are worth if real), never a migration
  // row whose balance is already in holdings_usd; claimable_usd / likely_usd above stay the headline totals
  const by_bucket = Object.fromEntries(BUCKETS.map((b) => {
    const xs = shown.filter((f) => f.bucket === b);
    return [b, { findings: xs.length, usd: sum(xs.filter((f) => !twin(f))), unpriced: xs.filter((f) => f.usd == null).length }];
  }));
  return {
    totals: {
      // high = the source says it is claimable now; medium (likely) = Zerion's read or our estimate: check it in the app
      claimable_usd: sum(high), claimable_net_usd: sum(high, "net_after_fees_usd"), likely_usd: sum(medium), likely_net_usd: sum(medium, "net_after_fees_usd"),
      findings: shown.length, unpriced: shown.filter((f) => f.usd == null).length,
      // unverified tokens are often airdropped bait with a fake price: kept apart so they cannot inflate the total;
      // loans count negative; vault shares that cannot be withdrawn now are locked_usd, not holdings_usd
      holdings_usd: sum(spendable.filter((h) => h.verified)), unverified_holdings_usd: sum(spendable.filter((h) => !h.verified)),
      locked_usd: sum(holdings.filter((h) => h.kind === "locked")), debt_usd: sum(holdings.filter((h) => h.kind === "loan")),
      by_bucket,
    },
    findings: shown,
    hidden_below_min_usd: findings.length - shown.length,
  };
}
export { hfClaims, dropHfTwins } from "./forgotten/hf-findings.mjs"; // hiddenfunds-gap sources (forgotten/claims.mjs, dexes.mjs, ...)
export { solDefiFindings, solDefiHoldings, dropSolDefiTwins } from "./forgotten/soldefi-findings.mjs"; // live Solana DeFi positions (sol.defi)
