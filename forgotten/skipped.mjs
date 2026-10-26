// forgotten/skipped.mjs - sources the earlier build rounds skipped for want of a proof wallet, built 2026-10-22 once
// one was found, merged into FORGOTTEN by forgotten/index.mjs. Each is a compose function returning { items, errors }
// in the hfClaims shape (forgotten/hf-findings.mjs); SKIPPED_ROUTES maps each scan route id to its function, and
// compose.mjs adds one scan.evm line per entry.
// Still skipped (reasons in the module headers): Thruster positions inside lockers (lockers.mjs), Stargate fees on
// Fantom, D8X and Agglayer exits of chains other than Silicon and Polygon zkEVM (legacy.mjs).
import { aaveIncentives, compoundRewards } from "./lending-rewards.mjs";
import { sablierFlow, llamaPay, authereum } from "./streams.mjs";
import { pinkLocks, hoodLocks, klikFees, bankrFees } from "./lockers.mjs";
import { alpaca2, mmFinance } from "./legacy.mjs";

export const SKIPPED = { aaveIncentives, compoundRewards, sablierFlow, llamaPay, authereum, pinkLocks, hoodLocks, klikFees, bankrFees, alpaca2, mmFinance };

export const SKIPPED_ROUTES = {
  "rewards.aave_incentives": "aaveIncentives",
  "rewards.compound_rewards": "compoundRewards",
  "rewards.sablier_flow": "sablierFlow",
  "rewards.llamapay": "llamaPay",
  "rewards.authereum_wallets": "authereum",
  "rewards.pink_locks": "pinkLocks",
  "rewards.hood_locks": "hoodLocks",
  "rewards.klik_fees": "klikFees",
  "rewards.bankr_fees": "bankrFees",
  "rewards.alpaca2": "alpaca2",
  "rewards.mm_finance": "mmFinance",
};
// locked memecoins keep a DefiLlama price on a pool far too thin to sell into: GoPlus's DEX liquidity check applies
export const SKIPPED_GOPLUS = ["rewards.pink_locks", "rewards.hood_locks"];
