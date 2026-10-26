// forgotten/stargate.mjs - Stargate veSTG fee rewards (read 2026-10-20): stargate.finance's own API lists the merkle
// entries a veSTG locker earned; each distributor's isClaimed(index) says if it was taken. An entry whose root is no
// longer the distributor's merkleRoot() cannot be claimed and is left out.
import { isEvmAddr } from "../solana.mjs";
import { multi, units } from "./evm.mjs";

export const STG_DIST = {
  ethereum: ["0x12a272A581feE5577A5dFa371afEB4b2F3a8C2F8", "USDC", 6],
  arbitrum: ["0x0cEb237E109eE22374a567c6b09F373C73FA4cBb", "USDC", 6],
  optimism: ["0xa7348290de5cf01772479c48D50dec791c3fC212", "USDC", 6],
  polygon: ["0x0cEb237E109eE22374a567c6b09F373C73FA4cBb", "USDC", 6],
  avalanche: ["0xda6087E69C51E7D31b6DBAD276a3c44703DFdCAd", "USDC", 6],
  bsc: ["0x102d758f688a4C1C5a80b116bD945d4455460282", "USDT", 18],
};
const ABI = ["function merkleRoot() view returns (bytes32)", "function isClaimed(uint256 index) view returns (bool)"];

export async function stargateFees(p, ctx) {
  if (p.address == null || p.address === "") throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  if (!isEvmAddr(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
  const r = await ctx.call("rewards.stargate_fee_api", { address: p.address.toLowerCase() });
  if (!r.ok) throw { status: 502, error: `step rewards.stargate_fee_api failed (upstream ${r.status})`, detail: r.data };
  const entries = Array.isArray(r.data) ? r.data.filter((e) => e?.merkleRoot && e.index != null && BigInt(e.amount || 0) > 0n) : [];
  if (!entries.length) return { items: [], errors: [] };
  const items = [], errors = [];
  await Promise.all(Object.entries(STG_DIST).map(async ([chain, [to, sym, dec]]) => {
    try {
      const [root] = await multi(ctx, chain, [{ to, abi: ABI, fn: "merkleRoot" }]);
      const mine = entries.filter((e) => root && e.merkleRoot.toLowerCase() === root.toLowerCase());
      if (!mine.length) return;
      const claimed = await multi(ctx, chain, mine.map((e) => ({ to, abi: ABI, fn: "isClaimed", args: [BigInt(e.index)] })));
      mine.forEach((e, i) => items.push({
        category: "reward", chain, protocol: "Stargate", asset: sym, amount: units(e.amount, dec), usd: units(e.amount, dec), status: claimed[i] === true ? "claimed" : claimed[i] === false ? "unclaimed" : "unknown",
        index: String(e.index), distributor: to, name: e.merkleName || null,
        action: `claim Stargate veSTG fee rewards (${e.merkleName || chain})`, how_to_claim: "https://stargate.finance/earn?tab=stake",
        detail: `${e.merkleName || "fee distribution"}: merkle index ${e.index} on ${to}`,
      }));
    } catch (e) { errors.push(`${chain}: ${String(e?.error || e?.message || e).slice(0, 120)}`); }
  }));
  return { items, errors };
}
