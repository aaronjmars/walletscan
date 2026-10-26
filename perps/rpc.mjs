// perps/rpc.mjs - the io the venue readers use: registry routes (ctx.call), EVM view calls batched through
// Multicall3, DefiLlama prices. Readers only see io, so tests hand them a fake one built from fixtures.
import { encodeFunctionData, decodeFunctionResult, parseAbi } from "viem";

// chain key -> how to reach it: publicnode hosts go through evm.rpc (chain param), the rest through
// holdings.perps_rpc (fixed host list). multicall: false = no Multicall3 deployed there (plain eth_call batches)
export const CHAINS = {
  arbitrum: { route: "evm.rpc", params: { chain: "arbitrum-one" } },
  avalanche: { route: "evm.rpc", params: { chain: "avalanche-c-chain" } },
  optimism: { route: "evm.rpc", params: { chain: "optimism" } },
  base: { route: "evm.rpc", params: { chain: "base" } },
  blast: { route: "evm.rpc", params: { chain: "blast" } },
  bsc: { route: "evm.rpc", params: { chain: "bsc" } },
  opbnb: { route: "evm.rpc", params: { chain: "opbnb" } },
  berachain: { route: "evm.rpc", params: { chain: "berachain" } },
  polygon: { route: "evm.rpc", params: { chain: "polygon-bor" } },
  ink: { route: "evm.rpc", params: { chain: "ink" } },
  fantom: { route: "holdings.perps_rpc", params: { host: "rpcapi.fantom.network" } },
  cronos: { route: "holdings.perps_rpc", params: { host: "evm.cronos.org" } },
  zksync: { route: "holdings.perps_rpc", params: { host: "mainnet.era.zksync.io" } },
  "cronos-zkevm": { route: "holdings.perps_rpc", params: { host: "mainnet.zkevm.cronos.org" }, multicall: false },
  apechain: { route: "holdings.perps_rpc", params: { host: "rpc.apechain.com" } },
  megaeth: { route: "holdings.perps_rpc", params: { host: "mainnet.megaeth.com", path: "rpc" } },
  monad: { route: "holdings.perps_rpc", params: { host: "rpc.monad.xyz" } },
  manta: { route: "holdings.perps_rpc", params: { host: "pacific-rpc.manta.network", path: "http" } },
  aevo: { route: "holdings.perps_rpc", params: { host: "rpc-aevo-mainnet-prod-0.t.conduit.xyz" } },
  orderly: { route: "holdings.perps_rpc", params: { host: "rpc.orderly.network" }, multicall: false },
};
// the host list holdings.perps_rpc accepts (its `pattern`), so the route cannot be pointed anywhere else
export const RPC_HOSTS = [...new Set(Object.values(CHAINS).filter((c) => c.route === "holdings.perps_rpc").map((c) => c.params.host))];

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const mcAbi = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"]);
const MC_CHUNK = 150, BATCH = 10; // calls per aggregate3; eth_calls per JSON-RPC batch (Cronos caps batches at 10)

const errText = (r) => `upstream ${r.status}: ${JSON.stringify(r.data).slice(0, 120)}`;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const RETRY_MS = [400, 1200]; // waits before the 2nd and 3rd try
const rateLimited = (res) => res.some((x) => x?.error && /rate|limit/i.test(x.error.message || ""));

export function makeIo(ctx) {
  const call = (id, params, over) => ctx.call(id, params, over);
  async function get(id, params) {
    const r = await ctx.call(id, params);
    if (!r.ok) throw { error: errText(r) };
    return r.data;
  }
  // one JSON-RPC request (or a batch: body array) on a chain key
  async function rpcBody(chain, body) {
    const c = CHAINS[chain];
    if (!c) throw { error: `no RPC for chain ${chain}` };
    // public RPCs drop connections under a scan's burst (502 fetch failed): two more tries before the venue errors
    let r = await ctx.call(c.route, c.params, { body });
    for (const ms of RETRY_MS) {
      if (r.ok || r.status < 500) break;
      await sleep(ms);
      r = await ctx.call(c.route, c.params, { body });
    }
    if (!r.ok) throw { error: `${chain} rpc ${errText(r)}` };
    return r.data;
  }
  async function rpc(chain, method, params = []) {
    const j = await rpcBody(chain, { jsonrpc: "2.0", id: 1, method, params });
    if (j?.error) throw { error: `${chain} ${method}: ${j.error.message || JSON.stringify(j.error)}` };
    return j?.result;
  }
  // calls: [{ to, abi, functionName, args }] -> decoded result per call (viem shape), null when that call reverted
  async function multicall(chain, calls) {
    if (!calls.length) return [];
    const data = calls.map((c) => encodeFunctionData({ abi: c.abi, functionName: c.functionName, args: c.args || [] }));
    const dec = (c, hex) => { try { return hex && hex !== "0x" ? decodeFunctionResult({ abi: c.abi, functionName: c.functionName, data: hex }) : null; } catch { return null; } };
    const out = new Array(calls.length).fill(null);
    if (CHAINS[chain]?.multicall === false) {
      for (let i = 0; i < calls.length; i += BATCH) {
        const body = calls.slice(i, i + BATCH).map((c, k) => ({ jsonrpc: "2.0", id: i + k, method: "eth_call", params: [{ to: c.to, data: data[i + k] }, "latest"] }));
        // Conduit RPCs (Orderly L2) count each call of a batch against a per-second limit: wait and send it again
        let res = await rpcBody(chain, body);
        for (const ms of RETRY_MS) {
          if (!Array.isArray(res) || !rateLimited(res)) break;
          await sleep(ms + 400);
          res = await rpcBody(chain, body);
        }
        if (!Array.isArray(res)) throw { error: `${chain} eth_call batch: ${JSON.stringify(res).slice(0, 120)}` };
        if (rateLimited(res)) throw { error: `${chain} rate limited` };
        for (const x of res) if (x && !x.error) out[x.id] = dec(calls[x.id], x.result);
      }
      return out;
    }
    for (let i = 0; i < calls.length; i += MC_CHUNK) {
      const part = calls.slice(i, i + MC_CHUNK);
      const cd = encodeFunctionData({ abi: mcAbi, functionName: "aggregate3", args: [part.map((c, k) => ({ target: c.to, allowFailure: true, callData: data[i + k] }))] });
      const hex = await rpc(chain, "eth_call", [{ to: MULTICALL3, data: cd }, "latest"]);
      const res = decodeFunctionResult({ abi: mcAbi, functionName: "aggregate3", data: hex });
      res.forEach((r, k) => { out[i + k] = r.success ? dec(part[k], r.returnData) : null; });
    }
    return out;
  }
  // DefiLlama keys (chain:address or coingecko:id) -> Map(lowercased key -> price)
  async function prices(keys) {
    const ks = [...new Set(keys.filter(Boolean))];
    const m = new Map();
    for (let i = 0; i < ks.length; i += 80) {
      const r = await ctx.call("token.prices", { coins: ks.slice(i, i + 80).join(",") }).catch(() => null);
      for (const [k, v] of Object.entries(r?.ok ? r.data?.coins || {} : {})) if (v?.price != null && (v.confidence ?? 1) >= 0.9) m.set(k.toLowerCase(), v.price); // a thin market (DefiLlama confidence under 0.9) is no price
    }
    return m;
  }
  return { call, get, rpc, multicall, prices };
}
