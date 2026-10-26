// forgotten/index.mjs - the forgotten-money sources as COMPOSE functions (spread into compose.mjs COMPOSE): each is
// async (params, ctx) -> { items[], errors[] } of facts; findings.mjs turns them into findings or holdings.
import { lrtWithdrawals } from "./lrt.mjs";
import { bnbFarms } from "./bnb.mjs";
import { solLeftovers, solStreams } from "./solana.mjs";
import { deadDefi } from "./deaddefi.mjs";
import { oldTokens, expiredLocks } from "./tokens.mjs";
import { stargateFees } from "./stargate.mjs";
import { smartWallets } from "./wallets.mjs";
import { deadApps } from "./deadapps.mjs";
import { balancerPools } from "./balancer.mjs";
import { veNfts } from "./venft.mjs";

export const FORGOTTEN = { lrtWithdrawals, bnbFarms, solLeftovers, solStreams, deadDefi, oldTokens, expiredLocks, stargateFees, smartWallets, deadApps, balancerPools, veNfts };

// hiddenfunds.xyz gap sources (forgotten/hf.mjs): Blur Pool, Plasma vault, Zora + 0xSplits, dead DEX LPs, Blast USDB, Balancer rescue, Agglayer,
// Nucleus vault shares, Mooniswap LPs, Karak queue, K2 claims, Polkadot sale claims, dead Solana apps
import { HF } from "./hf.mjs";
Object.assign(FORGOTTEN, HF);

// live Solana DeFi positions + their unclaimed money (forgotten/soldefi.mjs): Kamino, MarginFi, Orca, Raydium CLMM, Meteora
import { solDefi } from "./soldefi.mjs";
Object.assign(FORGOTTEN, { solDefi });
// sources earlier rounds skipped for want of a proof wallet (forgotten/skipped.mjs): Aave and Compound incentives,
// Sablier Flow, LlamaPay, Authereum wallets, PinkLock, HoodLock, Klik and Bankr fees, Alpaca 2.0, MM Finance farms
import { SKIPPED } from "./skipped.mjs";
Object.assign(FORGOTTEN, SKIPPED);

import { pons } from "./pons.mjs";
Object.assign(FORGOTTEN, { pons });
