// forgotten/blast.mjs - Blast USDB withdrawals waiting for their last step on Ethereum (bridge.blast_usdb, read
// 2026-10-21 from the verified USDYieldManager source, blast-io/blast WithdrawalQueue.sol). A USDB withdrawal from
// Blast is proven and finalized on the OptimismPortal like any OP Stack exit (bridge.stuck checks that part); the
// finalize does not pay out: the L1 Blast bridge files a request in the USD yield manager's withdrawal queue, and the
// wallet must call claimWithdrawal(requestId, hintId) itself, once the request is finalized, to get DAI. The queue
// lists a wallet's requests (getWithdrawalRequests), their state (getWithdrawalStatus) and the DAI each pays now
// (getClaimableEther with the checkpoint hint from findCheckpointHints; below the nominal amount if Blast had a
// negative yield). The Blast app stops on 2026-10-26 (the sunset-chains row); the contract keeps paying after.
import { readFileSync } from "node:fs";
import { readOn, pricesOf, trustedPrice, needEvm, round } from "./anyrpc.mjs";

export const USD_YIELD_MANAGER = "0xa230285d5683C74935aD14c446e137c8c8828438";
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const QUEUE = [
  "struct S { uint256 amount; address recipient; uint256 timestamp; bool isFinalized; bool isClaimed; }",
  "function getWithdrawalRequests(address owner) view returns (uint256[])",
  "function getWithdrawalStatus(uint256[] requestIds) view returns (S[])",
  "function getLastCheckpointId() view returns (uint256)",
  "function findCheckpointHints(uint256[] requestIds, uint256 firstIndex, uint256 lastIndex) view returns (uint256[])",
  "function getClaimableEther(uint256[] requestIds, uint256[] hintIds) view returns (uint256[])",
];
const BLAST = JSON.parse(readFileSync(new URL("../data/sunset-chains.json", import.meta.url), "utf8")).find((s) => s.id === "blast") || {};
export const BLAST_APP_ENDS = BLAST.closes || null;

export async function blastUsdb(p, ctx) {
  needEvm(p);
  const ids = await readOn(ctx, "ethereum", USD_YIELD_MANAGER, QUEUE, "getWithdrawalRequests", [p.address]);
  if (!ids.length) return { items: [], errors: [] };
  const [status, lastCp, px] = await Promise.all([
    readOn(ctx, "ethereum", USD_YIELD_MANAGER, QUEUE, "getWithdrawalStatus", [ids]),
    readOn(ctx, "ethereum", USD_YIELD_MANAGER, QUEUE, "getLastCheckpointId"),
    pricesOf(ctx, [`ethereum:${DAI.toLowerCase()}`]),
  ]);
  const open = ids.map((id, i) => ({ id, s: status[i] })).filter((r) => !r.s.isClaimed);
  const ready = open.filter((r) => r.s.isFinalized);
  let hints = [], pays = [];
  if (ready.length && lastCp > 0n) {
    hints = await readOn(ctx, "ethereum", USD_YIELD_MANAGER, QUEUE, "findCheckpointHints", [ready.map((r) => r.id), 1n, lastCp]);
    pays = await readOn(ctx, "ethereum", USD_YIELD_MANAGER, QUEUE, "getClaimableEther", [ready.map((r) => r.id), hints]);
  }
  const dai = trustedPrice(px, `ethereum:${DAI.toLowerCase()}`);
  const items = open.map((r) => {
    const k = ready.indexOf(r), fin = k >= 0, raw = fin && pays[k] != null ? pays[k] : r.s.amount, amount = Number(raw) / 1e18;
    const when = new Date(Number(r.s.timestamp) * 1000).toISOString().slice(0, 10);
    return {
      category: "bridge_stuck", chain: "ethereum", protocol: "Blast USDB", asset: "DAI", token: DAI.toLowerCase(), amount: round(amount, 6), usd: dai == null ? null : round(amount * dai),
      status: fin ? "ready" : "queued", request_id: String(r.id), ...(fin && { hint_id: String(hints[k]) }), deadline: BLAST_APP_ENDS,
      action: fin ? `claim the USDB withdrawal (pays DAI): in the Blast app before ${BLAST_APP_ENDS}, after that claimWithdrawal(${r.id}, ${hints[k]}) on the Blast USD yield manager (no onchain expiry)` : `wait for Blast to finalize the USDB withdrawal request (about a day), then claim it: in the Blast app before ${BLAST_APP_ENDS}, after that claimWithdrawal on the USD yield manager`,
      how_to_claim: BLAST.link || "https://blast.io/en/bridge",
      detail: `USDB withdrawal request ${r.id} of ${round(Number(r.s.amount) / 1e18, 2)} USDB filed ${when}, ${fin ? "finalized and not claimed" : "not finalized yet"}; the Blast app stops on ${BLAST_APP_ENDS}, after that call it at https://etherscan.io/address/${USD_YIELD_MANAGER}#writeProxyContract (the contract keeps paying)`,
    };
  });
  return { items, errors: [] };
}
