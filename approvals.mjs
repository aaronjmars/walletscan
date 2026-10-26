// Read-only approval exposure on the four networks whose history is available without an API key.
// Log entries discover candidates only. Current allowance/owner/operator state decides whether they remain active.
import { keccak256, stringToHex } from "viem";
import { multiOn, needEvm } from "./forgotten/anyrpc.mjs";

export const APPROVAL_CHAINS = { ethereum: 1, avalanche: 43114, mantle: 5000, blast: 81457 };
const ABI = [
  "function allowance(address,address) view returns (uint256)", "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)", "function symbol() view returns (string)",
  "function ownerOf(uint256) view returns (address)", "function getApproved(uint256) view returns (address)",
  "function isApprovedForAll(address,address) view returns (bool)",
];
const EVENTS = [keccak256(stringToHex("Approval(address,address,uint256)")), keccak256(stringToHex("ApprovalForAll(address,address,bool)"))];
const addressOf = (topic) => /^0x0{24}[0-9a-fA-F]{40}$/.test(topic || "") ? `0x${topic.slice(-40)}`.toLowerCase() : null;
const validToken = (s) => /^0x[0-9a-fA-F]{40}$/.test(s || "");
const lower = (s) => String(s || "").toLowerCase();

export function approvalCandidates(logs, owner) {
  const out = new Map();
  for (const l of logs) {
    if (!validToken(l.address) || addressOf(l.topics?.[1]) !== lower(owner) || l.removed) continue;
    const spender = addressOf(l.topics?.[2]);
    if (!spender || /^0x0{40}$/.test(spender)) continue;
    const event = lower(l.topics[0]);
    let type, tokenId;
    if (event === EVENTS[1]) type = "operator";
    else if (event === EVENTS[0]) {
      type = l.topics.length === 4 ? "erc721" : "erc20";
      if (type === "erc721") {
        try { tokenId = BigInt(l.topics[3]).toString(); } catch { continue; }
      }
    } else continue;
    const token = lower(l.address), key = `${token}:${spender}:${type}:${tokenId || ""}`;
    out.set(key, { token, spender, type, ...(tokenId && { token_id: tokenId }) });
  }
  return [...out.values()];
}

export async function approvals(p, ctx) {
  needEvm(p);
  const owner = lower(p.address), topic = `0x${"0".repeat(24)}${owner.slice(2)}`;
  const requested = String(p.chains || Object.keys(APPROVAL_CHAINS).join(",")).split(",");
  const chains = [...new Set(requested)].filter((c) => APPROVAL_CHAINS[c]);
  const errors = [], coverage = {}, out = [];
  await Promise.all(chains.map(async (chain) => {
    const logs = [], until = Date.now() + 15000;
    let truncated = false;
    try {
      for (const event of EVENTS) {
        for (let page = 1; page <= 3; page++) {
          const r = await ctx.call("security.approval_logs", { chain_id: String(APPROVAL_CHAINS[chain]), owner: topic, event, page: String(page) });
          const d = r.data;
          const empty = r.ok && String(d?.status) === "0" && /no (records|logs) found/i.test(`${d?.message} ${d?.result}`);
          if (empty) break;
          if (!r.ok || String(d?.status) !== "1" || !Array.isArray(d.result)) throw new Error(`approval history upstream ${r.status}: ${String(d?.result || d?.message).slice(0, 60)}`);
          logs.push(...d.result);
          if (d.result.length < 1000) break;
          if (page === 3 || Date.now() >= until) { truncated = true; break; }
        }
        if (Date.now() >= until) { truncated = true; break; }
      }
      const all = approvalCandidates(logs, owner), candidates = all.slice(0, 50);
      if (all.length > candidates.length) truncated = true;
      const calls = candidates.flatMap((c) => c.type === "erc20" ? [
        { to: c.token, abi: ABI, fn: "allowance", args: [owner, c.spender] },
        { to: c.token, abi: ABI, fn: "balanceOf", args: [owner] },
        { to: c.token, abi: ABI, fn: "decimals" }, { to: c.token, abi: ABI, fn: "symbol" },
      ] : c.type === "erc721" ? [
        { to: c.token, abi: ABI, fn: "ownerOf", args: [BigInt(c.token_id)] },
        { to: c.token, abi: ABI, fn: "getApproved", args: [BigInt(c.token_id)] },
      ] : [{ to: c.token, abi: ABI, fn: "isApprovedForAll", args: [owner, c.spender] }]);
      const values = await multiOn(ctx, chain, calls);
      let i = 0, unreadable = 0;
      for (const c of candidates) {
        const n = c.type === "erc20" ? 4 : c.type === "erc721" ? 2 : 1, v = values.slice(i, i + n); i += n;
        if (v[0] == null || (c.type === "erc721" && v[1] == null)) { unreadable++; continue; }
        if (c.type === "erc20" && !(v[0] > 0n)) continue;
        if (c.type === "erc721" && (lower(v[0]) !== owner || lower(v[1]) !== c.spender)) continue;
        if (c.type === "operator" && v[0] !== true) continue;
        out.push({ ...c, chain, chain_id: APPROVAL_CHAINS[chain], owner,
          ...(c.type === "erc20" && { allowance_raw: String(v[0]), balance_raw: v[1] == null ? null : String(v[1]),
            exposed_raw: v[1] == null ? null : String(v[0] < v[1] ? v[0] : v[1]), unlimited: v[0] >= 2n ** 255n,
            decimals: v[2] == null ? null : Number(v[2]), symbol: v[3] || null }),
          how_to_revoke: `https://revoke.cash/address/${owner}?chainId=${APPROVAL_CHAINS[chain]}`,
        });
      }
      coverage[chain] = { status: truncated || unreadable ? "truncated" : "complete", checked: candidates.length, candidates: all.length, unreadable,
        ...(truncated || unreadable ? { reason: unreadable ? "some current permissions could not be read" : "history or permission check budget reached" } : {}) };
    } catch (e) { const reason = String(e.error || e.message || e).slice(0, 140); errors.push({ chain, reason }); coverage[chain] = { status: "failed", reason }; }
  }));
  return { approvals: out, coverage, errors, unsupported_chains: requested.filter((c) => !APPROVAL_CHAINS[c]),
    note: "current token permissions, not proof of malicious activity; exposure is separate from money found. Other chains' approval history is not checked." };
}
