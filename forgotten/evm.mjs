// forgotten/evm.mjs - shared read helpers for the forgotten-money sources: eth_call and Multicall3 through the
// evm.rpc route (publicnode, keyless), eth_getLogs on Ethereum through evm.alchemy (publicnode refuses wide block
// ranges), and DefiLlama prices through token.prices. Every network step goes through ctx.call, so pacing, timeouts and
// the cache stay in engine.mjs and tests can answer from fixtures.
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";

// our chain name -> publicnode host prefix (evm.rpc {chain}) and Alchemy network prefix (evm.alchemy {net})
export const HOST = { ethereum: "ethereum", arbitrum: "arbitrum-one", optimism: "optimism", base: "base", polygon: "polygon-bor", bsc: "bsc", avalanche: "avalanche-c-chain", blast: "blast", sonic: "sonic" };
export const LLAMA = { ethereum: "ethereum", arbitrum: "arbitrum", optimism: "optimism", base: "base", polygon: "polygon", bsc: "bsc", avalanche: "avax", blast: "blast", sonic: "sonic" };
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const ZERO = "0x0000000000000000000000000000000000000000";

const rpc = (method, params = []) => ({ jsonrpc: "2.0", id: 1, method, params });
const abiOf = (abi) => (typeof abi[0] === "string" ? parseAbi(abi) : abi);
const mcAbi = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }", "function aggregate3(Call3[] calls) payable returns (Result[] returnData)"]);

async function send(ctx, id, params, body) {
  const r = await ctx.call(id, params, { body });
  if (!r.ok) throw { status: 502, error: `step ${id} failed (upstream ${r.status})`, detail: r.data };
  if (r.data?.error) throw { status: 502, error: `${body.method} failed`, detail: r.data.error };
  return r.data.result;
}

export const ethCall = (ctx, chain, to, data) => send(ctx, "evm.rpc", { chain: HOST[chain] || chain }, rpc("eth_call", [{ to, data }, "latest"]));
export const rpcCall = (ctx, chain, method, params) => send(ctx, "evm.rpc", { chain: HOST[chain] || chain }, rpc(method, params));

// one view call: abi = parseAbi result or human-readable signatures
export async function read(ctx, chain, to, abi, fn, args = []) {
  const a = abiOf(abi);
  return decodeFunctionResult({ abi: a, functionName: fn, data: await ethCall(ctx, chain, to, encodeFunctionData({ abi: a, functionName: fn, args })) });
}

// many view calls in Multicall3 batches; a failed call answers null instead of throwing
// calls: [{ to, abi, fn, args }]
export async function multi(ctx, chain, calls, { batch = 150 } = {}) {
  const out = new Array(calls.length).fill(null);
  const chunks = [];
  for (let i = 0; i < calls.length; i += batch) chunks.push(i);
  await Promise.all(chunks.map(async (start) => {
    const part = calls.slice(start, start + batch).map((c) => ({ ...c, abi: abiOf(c.abi) }));
    const data = encodeFunctionData({ abi: mcAbi, functionName: "aggregate3", args: [part.map((c) => ({ target: c.to, allowFailure: true, callData: encodeFunctionData({ abi: c.abi, functionName: c.fn, args: c.args || [] }) }))] });
    const res = decodeFunctionResult({ abi: mcAbi, functionName: "aggregate3", data: await ethCall(ctx, chain, MULTICALL3, data) });
    res.forEach((r, j) => {
      if (!r.success || r.returnData === "0x") return;
      try { out[start + j] = decodeFunctionResult({ abi: part[j].abi, functionName: part[j].fn, data: r.returnData }); } catch { /* not this shape: null */ }
    });
  }));
  return out;
}

// eth_getLogs on Ethereum over the whole history (Alchemy answers wide ranges when topics narrow it down)
export async function logs(ctx, filter) {
  const r = await ctx.call("evm.alchemy", {}, { body: rpc("eth_getLogs", [{ fromBlock: "0x0", toBlock: "latest", ...filter }]) });
  if (!r.ok) throw { status: 502, error: `step evm.alchemy failed (upstream ${r.status})`, detail: r.data };
  if (r.data?.error) throw { status: 502, error: "eth_getLogs failed", detail: r.data.error };
  return r.data.result || [];
}
export const topicAddr = (a) => `0x${a.toLowerCase().slice(2).padStart(64, "0")}`;

// DefiLlama prices: keys like "ethereum:0x...", "bsc:0x...", "coingecko:ethereum" -> Map(lowercased key -> {price, decimals, symbol})
export async function prices(ctx, keys) {
  const uniq = [...new Set(keys.filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < uniq.length; i += 60) {
    const r = await ctx.call("token.prices", { coins: uniq.slice(i, i + 60).join(",") }).catch(() => null);
    for (const [k, v] of Object.entries(r?.ok ? r.data?.coins || {} : {})) out.set(k.toLowerCase(), v);
  }
  return out;
}
// a thin market (DefiLlama confidence under 0.9) is no price, as in unclaimed/ and chains/
export const trusted = (c) => (c && c.price != null && (c.confidence ?? 1) >= 0.9 ? c : null);
export const priceOf = (px, key) => trusted(px.get(String(key).toLowerCase()))?.price ?? null;
export const llamaKey = (chain, token) => (token === "native" || token === ZERO ? (chain === "bsc" ? "coingecko:binancecoin" : chain === "avalanche" ? "coingecko:avalanche-2" : chain === "polygon" ? "coingecko:polygon-ecosystem-token" : "coingecko:ethereum") : `${LLAMA[chain] || chain}:${String(token).toLowerCase()}`);

export const big = (v) => { try { return BigInt(v ?? 0); } catch { return 0n; } };
export const units = (raw, decimals = 18) => Number(big(raw)) / 10 ** Number(decimals);
export const writeLink = (chain, a) => `${{ ethereum: "https://etherscan.io", bsc: "https://bscscan.com", arbitrum: "https://arbiscan.io", optimism: "https://optimistic.etherscan.io", base: "https://basescan.org", polygon: "https://polygonscan.com", avalanche: "https://snowtrace.io" }[chain] || "https://etherscan.io"}/address/${a}#writeContract`;
// run named sub-reads in parallel; a failed one lands in errors[] instead of failing the route
export async function each(parts) {
  const errors = [];
  const res = await Promise.all(Object.entries(parts).map(([name, fn]) => fn().catch((e) => { errors.push(`${name}: ${String(e?.error || e?.message || e).slice(0, 120)}`); return []; })));
  return { items: res.flat().filter(Boolean), errors };
}
