// forgotten/anyrpc.mjs - eth_call and Multicall3 on any chain the hiddenfunds-gap sources read: publicnode hosts go
// through evm.rpc (as forgotten/evm.mjs does), chains publicnode does not serve (Zora, Plasma, Cronos, Fantom, Karak K2) go
// through evm.public_rpc, whose host pattern is the only list of hosts it accepts. Every network step goes through
// ctx.call, so pacing, timeouts and the cache stay in engine.mjs and tests answer from fixtures.
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";

// our chain name -> [route, params]
export const RPC = {
  ethereum: ["evm.rpc", { chain: "ethereum" }], optimism: ["evm.rpc", { chain: "optimism" }], arbitrum: ["evm.rpc", { chain: "arbitrum-one" }],
  base: ["evm.rpc", { chain: "base" }], polygon: ["evm.rpc", { chain: "polygon-bor" }], bsc: ["evm.rpc", { chain: "bsc" }], gnosis: ["evm.rpc", { chain: "gnosis" }],
  blast: ["evm.rpc", { chain: "blast" }], linea: ["evm.rpc", { chain: "linea" }], metis: ["evm.rpc", { chain: "metis" }], avalanche: ["evm.rpc", { chain: "avalanche-c-chain" }],
  zora: ["evm.public_rpc", { host: "rpc.zora.energy" }], plasma: ["evm.public_rpc", { host: "rpc.plasma.to" }],
  cronos: ["evm.public_rpc", { host: "evm.cronos.org" }], fantom: ["evm.public_rpc", { host: "rpcapi.fantom.network" }],
  mantle: ["evm.rpc", { chain: "mantle" }], fraxtal: ["evm.rpc", { chain: "fraxtal" }], karak: ["evm.public_rpc", { host: "rpc.karak.network" }],
};
// DefiLlama chain prefix for our names
export const LLAMA = { ethereum: "ethereum", optimism: "optimism", arbitrum: "arbitrum", base: "base", polygon: "polygon", bsc: "bsc", gnosis: "xdai", blast: "blast", linea: "linea", metis: "metis", avalanche: "avax", zora: "zora", plasma: "plasma", cronos: "cronos", fantom: "fantom", mantle: "mantle", fraxtal: "fraxtal", karak: "karak" };
export const EXPLORER = { ethereum: "https://etherscan.io", optimism: "https://optimistic.etherscan.io", arbitrum: "https://arbiscan.io", base: "https://basescan.org", polygon: "https://polygonscan.com", bsc: "https://bscscan.com", gnosis: "https://gnosisscan.io", blast: "https://blastscan.io", linea: "https://lineascan.build", metis: "https://andromeda-explorer.metis.io", zora: "https://explorer.zora.energy", plasma: "https://plasmascan.to", cronos: "https://explorer.cronos.org", fantom: "https://ftmscan.com", mantle: "https://mantlescan.xyz", fraxtal: "https://fraxscan.com", karak: "https://explorer.karak.network" };
export const writeLink = (chain, a) => `${EXPLORER[chain] || EXPLORER.ethereum}/address/${a}#writeContract`;
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

const abiOf = (abi) => (typeof abi[0] === "string" ? parseAbi(abi) : abi);
const mcAbi = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }", "function aggregate3(Call3[] calls) payable returns (Result[] returnData)"]);

export async function rpcOn(ctx, chain, method, params) {
  const [id, p] = RPC[chain] || ["evm.rpc", { chain }];
  const r = await ctx.call(id, p, { body: { jsonrpc: "2.0", id: 1, method, params } });
  if (!r.ok) throw { status: 502, error: `${chain} ${method} failed (upstream ${r.status})`, detail: r.data };
  if (r.data?.error) throw { status: 502, error: `${chain} ${method} failed`, detail: r.data.error };
  return r.data.result;
}
export const callOn = (ctx, chain, to, data) => rpcOn(ctx, chain, "eth_call", [{ to, data }, "latest"]);

// one view call
export async function readOn(ctx, chain, to, abi, fn, args = []) {
  const a = abiOf(abi);
  return decodeFunctionResult({ abi: a, functionName: fn, data: await callOn(ctx, chain, to, encodeFunctionData({ abi: a, functionName: fn, args })) });
}

// many view calls in Multicall3 batches; a failed call answers null. calls: [{ to, abi, fn, args }]
export async function multiOn(ctx, chain, calls, { batch = 200 } = {}) {
  const out = new Array(calls.length).fill(null);
  const starts = [];
  for (let i = 0; i < calls.length; i += batch) starts.push(i);
  await Promise.all(starts.map(async (start) => {
    const part = calls.slice(start, start + batch).map((c) => ({ ...c, abi: abiOf(c.abi) }));
    const data = encodeFunctionData({ abi: mcAbi, functionName: "aggregate3", args: [part.map((c) => ({ target: c.to, allowFailure: true, callData: encodeFunctionData({ abi: c.abi, functionName: c.fn, args: c.args || [] }) }))] });
    const res = decodeFunctionResult({ abi: mcAbi, functionName: "aggregate3", data: await callOn(ctx, chain, MULTICALL3, data) });
    res.forEach((r, j) => {
      if (!r.success || r.returnData === "0x") return;
      try { out[start + j] = decodeFunctionResult({ abi: part[j].abi, functionName: part[j].fn, data: r.returnData }); } catch { /* not this shape */ }
    });
  }));
  return out;
}

// DefiLlama prices -> Map(lowercase key -> coin); trusted() applies the thin-market rule (confidence under 0.9 = no price)
export async function pricesOf(ctx, keys) {
  const uniq = [...new Set(keys.filter(Boolean).map((k) => k.toLowerCase()))], out = new Map();
  for (let i = 0; i < uniq.length; i += 60) {
    const r = await ctx.call("token.prices", { coins: uniq.slice(i, i + 60).join(",") }).catch(() => null);
    for (const [k, v] of Object.entries(r?.ok ? r.data?.coins || {} : {})) out.set(k.toLowerCase(), v);
  }
  return out;
}
export const trustedPrice = (px, key) => { const c = px.get(String(key).toLowerCase()); return c && c.price != null && (c.confidence ?? 1) >= 0.9 ? c.price : null; };
export const tokenKey = (chain, token) => `${LLAMA[chain] || chain}:${String(token).toLowerCase()}`;

export const isEvm = (a) => /^0x[0-9a-fA-F]{40}$/.test(String(a || ""));
export function needEvm(p) {
  if (p.address == null || p.address === "") throw { status: 400, error: "missing required param(s)", detail: ["address"] };
  if (!isEvm(p.address)) throw { status: 400, error: "address must be an EVM 0x address" };
}
export const units = (raw, decimals = 18) => Number(BigInt(raw ?? 0)) / 10 ** Number(decimals);
export const errText = (e) => String(e?.error || e?.message || e).slice(0, 120);
export const round = (v, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
// run named sub-reads in parallel; a failed one lands in errors[] instead of failing the route
export async function parts(named) {
  const errors = [];
  const res = await Promise.all(Object.entries(named).map(([name, fn]) => fn().catch((e) => { errors.push(`${name}: ${errText(e)}`); return []; })));
  return { items: res.flat().filter(Boolean), errors };
}
