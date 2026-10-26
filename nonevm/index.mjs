// nonevm/index.mjs - the non-EVM, non-Solana chains: one module per chain, each exporting
//   ROUTES   registry entries (apis.mjs shape, see registry.mjs): raw upstream routes + the compose source routes
//   COMPOSE  compose functions of its source routes: async (params, ctx) -> { items[], holdings[], errors[] }
//            items    = findings facts in the hfClaims shape (forgotten/hf-findings.mjs): { category, chain, asset, token?,
//                       amount, usd, protocol, status (ready = claimable now -> high when priced; hint -> low; anything
//                       else -> medium), action, how_to_claim, deadline, detail, unpriced?, cost_usd? (claim cost when
//                       it is not the flat L2 estimate, e.g. a Bitcoin transaction fee) }
//            holdings = plain balances and positions { kind (token | staked | locked), chain, asset, token?, amount, usd,
//                       verified, protocol?, detail? }
//            errors   = parts that failed (a source that read nothing at all throws instead); any error marks the
//                       source failed in the scan (partial: true) while its rows stay
//   SCAN     { kind (nonevm/address.mjs), id (scan.<chain>), compose (name of the scan in COMPOSE), chains[], sources[]
//            (source route ids, run in parallel), returns (doc), example (a proof address for the health sweep) }
// compose.mjs builds every scan.<chain> from SCAN (scanChain) and scan.all / scan.wallets route each address kind to it.
import * as btc from "./btc.mjs";
import * as tron from "./tron.mjs";
import * as near from "./near.mjs";
import * as dot from "./dot.mjs";
import * as sui from "./sui.mjs";
import * as ton from "./ton.mjs";

const MODULES = [btc, tron, near, dot, sui, ton].filter((m) => m.SCAN && m.SCAN.sources?.length);

// kind -> SCAN spec, for the chains that have sources
export const CHAINS = Object.fromEntries(MODULES.map((m) => [m.SCAN.kind, m.SCAN]));
export const COMPOSE = Object.assign({}, ...MODULES.map((m) => m.COMPOSE || {}));

const scanEntry = (s) => ({
  id: s.id, group: "scan", method: "GET", compose: s.compose, usesAny: s.sources, url: `(compose: ${s.sources.join(", ")})`,
  input: { address: s.label || `${s.kind} address`, min_usd: "default 1", skip: "optional comma list of sources to leave out" },
  returns: `same shape as scan.all (kind ${s.kind}): ${s.returns}`, example: { address: s.example }, check: "weekly", timeout: 90,
});
export const SCAN_ROUTES = MODULES.map((m) => scanEntry(m.SCAN));
export const ROUTES = MODULES.flatMap((m) => m.ROUTES || []);
