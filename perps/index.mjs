// perps/index.mjs - perp exchange balances beyond GMX v2 / Lighter / Kwenta (those stay in compose.mjs).
// One reader per venue: async (address, io) -> item[]; io is perps/rpc.mjs makeIo(ctx) (or a fake in tests).
//
// Item shape (findings.mjs perpsHoldings / perpsFindings turn them into holdings or findings):
//   { protocol, chain, asset, amount, usd, kind: "position" | "deposit", status, detail,
//     category?, confidence?, action?, how_to_claim?, deadline? }
// status: live   = the venue still trades: a holding (money still at work, not forgotten)
//         closed = the venue shut down, went withdraw-only or was abandoned: a finding (money to take back);
//                  category defaults to exchange_balance, confidence high (the venue's own number is withdrawable
//                  now) or medium (our estimate, e.g. collateral without PnL)
//         hint   = an account exists but its balance cannot be read keylessly: a low finding, amount/usd null
// A venue that fails is named in errors[]; the others still answer.
import { makeIo } from "./rpc.mjs";
import * as sol from "./solana.mjs";
import * as vaults from "./evm-vaults.mjs";
import * as onchain from "./evm-onchain.mjs";
import * as rest from "./rest.mjs";

export { makeIo };

// venue id -> reader; each module exports EVM / SOL maps of its readers
export const EVM_VENUES = { ...vaults.EVM, ...onchain.EVM, ...rest.EVM };
export const SOL_VENUES = { ...sol.SOL };

const msg = (e) => String((e && (e.error || e.message)) || e).slice(0, 160);

// each venue gets VENUE_MS: the whole read must end inside the scan's 45 s step (compose.mjs runSources), so one
// hung RPC costs that venue alone
export const VENUE_MS = 25000;
const timeout = (ms, id) => new Promise((_, no) => setTimeout(() => no({ error: `${id} took over ${ms / 1000}s` }), ms).unref());

export async function readVenues(address, io, venues, { ms = VENUE_MS } = {}) {
  const items = [], errors = [];
  await Promise.all(Object.entries(venues).map(async ([id, read]) => {
    try {
      for (const it of (await Promise.race([read(address, io), timeout(ms, id)])) || []) items.push({ venue: id, ...it });
    } catch (e) {
      errors.push({ venue: id, error: msg(e) });
    }
  }));
  return { items: items.sort((x, y) => (y.usd ?? 0) - (x.usd ?? 0)), errors: errors.sort((a, b) => a.venue.localeCompare(b.venue)), venues_checked: Object.keys(venues).length };
}
