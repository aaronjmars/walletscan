// forgotten/streams.mjs - payment streams a wallet never withdrew, and old Authereum smart wallets (read 2026-10-22).
// Sablier Flow (rewards.sablier_flow_streams): open ended Flow streams. Sablier's keyless Envio indexer lists the wallet's
// streams that still hold money; the stream balance is only an upper bound (a paused stream or a sender who stopped
// paying leaves money that belongs to the sender), so withdrawableAmountOf(streamId) is read on the stream's own chain,
// and getRecipient(streamId) checks the wallet still owns the stream NFT. Lockup streams are rewards.sablier_streams.
// LlamaPay: v1 salary streams (one LlamaPay contract per token, made by a LlamaPayFactory) and LlamaPay vesting
// escrows. Its subgraphs are gone, so the wallet's streams come from eth_getLogs over the whole chain (Alchemy, one
// network per chain): StreamCreated / StreamCreatedWithReason have the payee as topic 2, StreamModified (new payee) and
// VestingEscrowCreated as topic 3. Every emitter is checked: a LlamaPay contract is the factory's CREATE2 address for
// its own token(), an escrow comes only from a known LlamaPay vesting factory, so look-alike events count for nothing.
// Authereum: smart contract wallets of 2019-2021 (shut down 2021). An account emits AuthKeyAdded(authKey) for each key
// it trusts; an account still trusting the wallet (authKeys(wallet) now) and running a known Authereum implementation
// is the wallet's, and its ETH and tokens are what the key can still move out.
import { multiOn, pricesOf, trustedPrice, tokenKey, needEvm, round, errText, writeLink, MULTICALL3 } from "./anyrpc.mjs";
import { logs, topicAddr } from "./evm.mjs";

// Sablier chain id -> our chain name (anyrpc RPC map; unknown names fall through to <name>-rpc.publicnode.com) and
// DefiLlama prefix. Flow chains publicnode does not serve (XDC 50, ZKsync 324, Abstract 2741, Morph 2818, Mode 34443,
// Monad 143, 4663) are not read: they held a few dollars of test streams on 2026-10-22
const FLOW_CHAINS = {
  1: ["ethereum", "ethereum"], 10: ["optimism", "optimism"], 56: ["bsc", "bsc"], 100: ["gnosis", "xdai"], 137: ["polygon", "polygon"],
  146: ["sonic", "sonic"], 999: ["hyperliquid", "hyperliquid"], 5000: ["mantle", "mantle"], 8453: ["base", "base"],
  42161: ["arbitrum", "arbitrum"], 43114: ["avalanche", "avax"], 59144: ["linea", "linea"], 80094: ["berachain", "berachain"], 81457: ["blast", "blast"],
  88888: ["chiliz", "chz"], 130: ["unichain", "unichain"], 534352: ["scroll", "scroll"], 1329: ["sei-evm", "sei"],
};
const TESTNETS = new Set([11155111, 84532, 421614, 11155420, 80002, 43113, 97]);
const FLOW = ["function withdrawableAmountOf(uint256 streamId) view returns (uint128)", "function getRecipient(uint256 streamId) view returns (address)"];

export async function sablierFlow(p, ctx) {
  needEvm(p);
  const a = p.address.toLowerCase();
  const r = await ctx.call("rewards.sablier_flow_streams", { recipient: a });
  if (!r.ok) throw { status: 502, error: `step rewards.sablier_flow_streams failed (upstream ${r.status})`, detail: r.data };
  const all = (r.data?.data?.FlowStream || []).filter((s) => !TESTNETS.has(Number(s.chainId)));
  const errors = [], byChain = new Map();
  for (const s of all) {
    const c = FLOW_CHAINS[Number(s.chainId)];
    if (!c) { errors.push(`${s.alias}: chain ${s.chainId} not read (no public RPC)`); continue; }
    byChain.set(c[0], [...(byChain.get(c[0]) || []), s]);
  }
  const read = [];
  await Promise.all([...byChain].map(async ([chain, ss]) => {
    try {
      const out = await multiOn(ctx, chain, ss.flatMap((s) => [
        { to: s.contract, abi: FLOW, fn: "withdrawableAmountOf", args: [BigInt(s.tokenId)] },
        { to: s.contract, abi: FLOW, fn: "getRecipient", args: [BigInt(s.tokenId)] },
      ]));
      ss.forEach((s, i) => { if (out[2 * i] > 0n && String(out[2 * i + 1] || "").toLowerCase() === a) read.push({ s, chain, raw: out[2 * i] }); });
    } catch (e) { errors.push(`${chain}: ${errText(e)}`); }
  }));
  if (!read.length) return { items: [], errors };
  const key = (x) => `${FLOW_CHAINS[Number(x.s.chainId)][1]}:${x.s.asset.address.toLowerCase()}`;
  const px = await pricesOf(ctx, read.map(key));
  const items = read.map((x) => {
    const { s } = x, dec = Number(s.asset.decimals), amount = Number(x.raw) / 10 ** dec, price = trustedPrice(px, key(x));
    const balance = Number(BigInt(s.availableAmount)) / 10 ** dec, withdrawn = Number(BigInt(s.withdrawnAmount || 0)) / 10 ** dec;
    const since = new Date(Number(s.startTime) * 1000).toISOString().slice(0, 10);
    return {
      category: "vesting", chain: x.chain, protocol: "Sablier Flow", asset: s.asset.symbol, token: s.asset.address.toLowerCase(), amount: round(amount, 6), usd: price == null ? null : round(amount * price),
      status: "ready", stream_id: s.alias, deadline: null,
      action: `withdraw the Sablier Flow payment stream ${s.alias}`, how_to_claim: `https://app.sablier.com/payments/stream/${s.alias}`,
      detail: `Flow stream ${s.alias} (${s.version}) paying since ${since}${s.voided ? ", voided by the sender" : s.paused ? ", paused" : ""}: ${round(amount, 4)} ${s.asset.symbol} withdrawable now of ${round(balance, 4)} in the stream, ${round(withdrawn, 4)} withdrawn so far; withdrawableAmountOf(${s.tokenId}) on ${s.contract}`,
    };
  });
  return { items, errors };
}

// ---- LlamaPay ------------------------------------------------------------------------------------------------
// chain -> Alchemy network, LlamaPayFactory, LlamaPay vesting factories (LlamaPay docs contracts.md and the vesting
// subgraph's manifest, each checked for code 2026-10-22). Fantom (same factory) has no Alchemy network: not read.
// Gnosis (factory LLAMA_FACTORY) and Avalanche (factory 0x7d507b4c) are not read either: Alchemy answers a full-range
// eth_getLogs there only on a paid plan ("up to a 10000 block range")
const LLAMA_FACTORY = "0xde1C04855c2828431ba637675B6929A684f84C7F", VEST_V1 = "0xB93427b83573C8F27a08A909045c3e809610411a", VEST_V2 = "0x62E13BE78af77C86D38a027ae432F67d9EcD4c10";
export const LLAMA_CHAINS = {
  ethereum: { net: "eth-mainnet", factory: LLAMA_FACTORY, vest: [VEST_V1, "0x98d3872b4025ABE58C4667216047Fe549378d90f", "0x5fa57626bdaf4584b84d2394ef44f6bd41b37caf", "0xcf61782465Ff973638143d6492B51A85986aB347"] },
  arbitrum: { net: "arb-mainnet", factory: LLAMA_FACTORY, vest: [VEST_V1, "0x5fa57626bdaf4584b84d2394ef44f6bd41b37caf", VEST_V2] },
  optimism: { net: "opt-mainnet", factory: LLAMA_FACTORY, vest: [VEST_V1, VEST_V2] },
  polygon: { net: "polygon-mainnet", factory: LLAMA_FACTORY, vest: [VEST_V1, VEST_V2] },
  bsc: { net: "bnb-mainnet", factory: LLAMA_FACTORY, vest: [VEST_V1, VEST_V2] },
  base: { net: "base-mainnet", factory: "0x09c39B8311e4B7c678cBDAD76556877ecD3aEa07", vest: [VEST_V1, VEST_V2] },
};
const T = {
  created: "0xbdf2ad452fb5e7123ebc3e977452088bc6ac9aa4c6b807fa043bb65f7dd62810", // StreamCreated(address,address,uint216,bytes32)
  reason: "0xf9b31dda66c763701e363e12ac3126c9030e68c82e939dbd42c33a8021e6dda8", // StreamCreatedWithReason(address,address,uint216,bytes32,string)
  modified: "0x0edc6e7edb775c1fb5a1326f1b041b17e4e1cbfb9ea4a0562920bda1a7d03134", // StreamModified(address,address,uint216,bytes32,address,uint216,bytes32)
  vest: "0x4d924f2be6d90da83be47ca6bc3c90e0f5c5e365d7e9797faeb4b9f823505a78", // VestingEscrowCreated(address,address,address,address,uint256 x4)
  vest2: "0x99fd02dbc65944923f77d3e5d3e77e8c4c1b4026201be5445a8e827183e993e2", // VestingEscrowCreated(... uint256 x4, bool), vesting v2
};
const LLAMA = [
  "function token() view returns (address)",
  "function getLlamaPayContractByToken(address token) view returns (address predictedAddress, bool isDeployed)",
  "function withdrawable(address from, address to, uint216 amountPerSec) view returns (uint256 withdrawableAmount, uint256 lastUpdate, uint256 owed)",
  "function recipient() view returns (address)", "function unclaimed() view returns (uint256)", "function locked() view returns (uint256)", "function end_time() view returns (uint256)",
  "function decimals() view returns (uint8)", "function symbol() view returns (string)",
];
const word = (data, i) => `0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}`;
const addrOf = (w) => `0x${w.slice(-40)}`.toLowerCase();
const day = (s) => new Date(Number(s) * 1000).toISOString().slice(0, 10);

// eth_getLogs over a whole chain (Alchemy answers the full range when the topics narrow it down)
async function chainLogs(ctx, net, topics) {
  const r = await ctx.call("evm.alchemy_rpc", { network: net }, { body: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest", topics }] } });
  if (!r.ok) throw { status: 502, error: `step evm.alchemy_rpc ${net} failed (upstream ${r.status})`, detail: r.data };
  if (r.data?.error) throw { status: 502, error: `eth_getLogs ${net} failed`, detail: r.data.error, needs_key: r.data.error.data?.needs_key };
  return r.data.result || [];
}

async function llamaOn(ctx, chain, a) {
  const c = LLAMA_CHAINS[chain], me = topicAddr(a);
  const [made, moved] = await Promise.all([
    chainLogs(ctx, c.net, [[T.created, T.reason], null, me]),
    chainLogs(ctx, c.net, [[T.modified, T.vest, T.vest2], null, null, me]),
  ]);
  const streams = new Map(), escrows = new Set(), vestFrom = new Set(c.vest.map((v) => v.toLowerCase()));
  const add = (l, k) => streams.set(`${l.address}|${l.topics[1]}|${BigInt(word(l.data, k))}`, { c: l.address.toLowerCase(), from: addrOf(l.topics[1]), aps: BigInt(word(l.data, k)) });
  for (const l of made) add(l, 0);
  for (const l of moved) {
    if (l.topics[0] === T.modified) add(l, 2); // data: oldAmountPerSec, oldStreamId, amountPerSec, newStreamId
    else if (vestFrom.has(l.address.toLowerCase())) escrows.add(addrOf(word(l.data, 0)));
  }
  const ss = [...streams.values()], es = [...escrows];
  if (!ss.length && !es.length) return [];
  // withdrawable() reverts (null) once a stream was cancelled, paused or modified, which all paid the payee out
  const pays = [...new Set(ss.map((s) => s.c))];
  const first = await multiOn(ctx, chain, [
    ...pays.map((x) => ({ to: x, abi: LLAMA, fn: "token" })),
    ...ss.map((s) => ({ to: s.c, abi: LLAMA, fn: "withdrawable", args: [s.from, a, s.aps] })),
    ...es.flatMap((e) => ["recipient", "unclaimed", "locked", "token", "end_time"].map((fn) => ({ to: e, abi: LLAMA, fn }))),
  ]);
  const tokenOf = new Map(pays.map((x, i) => [x, first[i] ? String(first[i]).toLowerCase() : null]));
  const w = first.slice(pays.length, pays.length + ss.length), v = first.slice(pays.length + ss.length);
  const live = ss.map((s, i) => ({ ...s, w: w[i], token: tokenOf.get(s.c) })).filter((s) => s.w && s.w[0] > 0n && s.token);
  const vests = es.map((e, i) => ({ e, to: v[5 * i], amt: v[5 * i + 1], locked: v[5 * i + 2], token: v[5 * i + 3] ? String(v[5 * i + 3]).toLowerCase() : null, end: v[5 * i + 4] }))
    .filter((x) => String(x.to || "").toLowerCase() === a && x.amt > 0n && x.token);
  if (!live.length && !vests.length) return [];
  // a stream counts only on a real LlamaPay contract: the factory's CREATE2 address for that contract's own token
  const paysLive = [...new Set(live.map((s) => s.c))], toks = [...new Set([...live.map((s) => s.token), ...vests.map((x) => x.token)])];
  const [second, px] = await Promise.all([
    multiOn(ctx, chain, [...paysLive.map((x) => ({ to: c.factory, abi: LLAMA, fn: "getLlamaPayContractByToken", args: [tokenOf.get(x)] })),
      ...toks.flatMap((t) => [{ to: t, abi: LLAMA, fn: "decimals" }, { to: t, abi: LLAMA, fn: "symbol" }])]),
    pricesOf(ctx, toks.map((t) => tokenKey(chain, t))),
  ]);
  const real = new Set(paysLive.filter((x, i) => second[i] && String(second[i][0]).toLowerCase() === x && second[i][1]));
  const meta = new Map(toks.map((t, i) => [t, { dec: second[paysLive.length + 2 * i], sym: second[paysLive.length + 2 * i + 1] }]));
  const out = [];
  for (const s of live.filter((x) => real.has(x.c))) {
    const m = meta.get(s.token);
    if (m?.dec == null) continue;
    const amount = Number(s.w[0]) / 10 ** Number(m.dec), price = trustedPrice(px, tokenKey(chain, s.token)), dry = s.w[2] > 0n;
    out.push({
      category: "vesting", chain, protocol: "LlamaPay", asset: m.sym, token: s.token, amount: round(amount, 6), usd: price == null ? null : round(amount * price), status: "ready", deadline: null,
      action: `withdraw the LlamaPay stream: withdraw(${s.from}, ${a}, ${s.aps}) on the ${m.sym} LlamaPay contract (anyone may call it, it pays the payee)`,
      how_to_claim: writeLink(chain, s.c),
      detail: `LlamaPay ${m.sym} stream from ${s.from} on ${s.c}: ${round(amount, 4)} ${m.sym} earned and not withdrawn${dry ? `; the payer's balance ran out on ${day(s.w[1])}, so it stopped growing (${round(Number(s.w[2]) / 10 ** Number(m.dec), 4)} ${m.sym} owed past that)` : ""}`,
    });
  }
  for (const x of vests) {
    const m = meta.get(x.token);
    if (m?.dec == null) continue;
    const amount = Number(x.amt) / 10 ** Number(m.dec), price = trustedPrice(px, tokenKey(chain, x.token)), left = Number(x.locked || 0n) / 10 ** Number(m.dec);
    out.push({
      category: "vesting", chain, protocol: "LlamaPay Vesting", asset: m.sym, token: x.token, amount: round(amount, 6), usd: price == null ? null : round(amount * price), status: "ready", deadline: null,
      action: `claim the vested ${m.sym}: claim() on the LlamaPay vesting escrow`, how_to_claim: writeLink(chain, x.e),
      detail: `LlamaPay vesting escrow ${x.e}: ${round(amount, 4)} ${m.sym} vested and not claimed${left > 0 ? `, ${round(left, 4)} still locked until ${day(x.end)}` : ", fully vested"}`,
    });
  }
  return out;
}

export async function llamaPay(p, ctx) {
  needEvm(p);
  const a = p.address.toLowerCase(), errors = [], items = [];
  let skipped = 0;
  // a chain skipped for a missing key is already listed under skipped_for_keys: only real failures count here
  await Promise.all(Object.keys(LLAMA_CHAINS).map((chain) => llamaOn(ctx, chain, a).then((xs) => items.push(...xs), (e) => (e?.needs_key ? skipped++ : errors.push(`${chain}: ${errText(e)}`)))));
  if (errors.length && errors.length + skipped === Object.keys(LLAMA_CHAINS).length) throw { status: 502, error: errors.join("; ") };
  return { items, errors };
}

// ---- Authereum -----------------------------------------------------------------------------------------------
// the 8 Authereum account implementations on Ethereum (authereum/contracts README); each account proxy answers
// implementation()
const AUTH_IMPLS = new Set(["0xe45a5176bc0f2c1198e2451c4e4501d4ed9b65a6", "0x237edcdd43349227ef511581cc834962ecf23076", "0x20af9e54a3670ef6a601bca1f1ec22b1f93cbe23", "0x2e1723d1dfa2947f0d08d5c5d214b71def4f951f",
  "0x79fee076b1bcd4054dff0b4364c26899492198dc", "0x211deb5c0a28a213fcf5976ac22c70ff96b9004c", "0x185c46c8d3ef5155f3678e69c827db7a2116a6cd", "0xd8cab604bdd8cbb7c3eb0c26f7dc3abffb005a92"]);
const AUTH_KEY_ADDED = "0xb020719d16d3c4de45a91f9c329aa61d5bad3f44f760840c8d5d82d4cd3bcc33"; // AuthKeyAdded(address indexed authKey)
const AUTH = [
  "function implementation() view returns (address)", "function authKeys(address) view returns (bool)", "function getEthBalance(address) view returns (uint256)",
  "function decimals() view returns (uint8)", "function symbol() view returns (string)",
];
const DUST_USD = 1, MAX_ACCOUNTS = 20;

// the ERC-20s an account holds, from Alchemy's token index on Ethereum
async function tokensOf(ctx, w) {
  const r = await ctx.call("evm.alchemy", {}, { body: { jsonrpc: "2.0", id: 1, method: "alchemy_getTokenBalances", params: [w, "erc20"] } });
  if (!r.ok || r.data?.error) throw { status: 502, error: `alchemy_getTokenBalances failed (upstream ${r.status})`, detail: r.data?.error || r.data };
  return (r.data.result?.tokenBalances || []).filter((t) => t.tokenBalance && BigInt(t.tokenBalance) > 0n).map((t) => ({ token: t.contractAddress.toLowerCase(), raw: BigInt(t.tokenBalance) }));
}

export async function authereum(p, ctx) {
  needEvm(p);
  const a = p.address.toLowerCase();
  const found = [...new Set((await logs(ctx, { topics: [AUTH_KEY_ADDED, topicAddr(a)] })).map((l) => l.address.toLowerCase()))];
  if (!found.length) return { items: [], errors: [] };
  // a key can be removed later: only an account that still trusts the wallet, on an Authereum implementation, counts
  const chk = await multiOn(ctx, "ethereum", found.flatMap((w) => [{ to: w, abi: AUTH, fn: "implementation" }, { to: w, abi: AUTH, fn: "authKeys", args: [a] }, { to: MULTICALL3, abi: AUTH, fn: "getEthBalance", args: [w] }]));
  const mine = found.map((w, i) => ({ w, impl: String(chk[3 * i] || "").toLowerCase(), trusted: chk[3 * i + 1], wei: chk[3 * i + 2] || 0n })).filter((x) => AUTH_IMPLS.has(x.impl) && x.trusted === true);
  if (!mine.length) return { items: [], errors: [] };
  const errors = [];
  // a person has one or two accounts; Authereum's own modules (recovery, delegate key) sit on hundreds: token reads stop at 20
  if (mine.length > MAX_ACCOUNTS) errors.push(`${mine.length} accounts trust this key, tokens read on the first ${MAX_ACCOUNTS}`);
  const held = await Promise.all(mine.map((x, i) => (i >= MAX_ACCOUNTS ? [] : tokensOf(ctx, x.w).catch((e) => { errors.push(`tokens of ${x.w}: ${errText(e)}`); return []; }))));
  const toks = [...new Set(held.flat().map((t) => t.token))];
  const [meta, px] = await Promise.all([
    toks.length ? multiOn(ctx, "ethereum", toks.flatMap((t) => [{ to: t, abi: AUTH, fn: "decimals" }, { to: t, abi: AUTH, fn: "symbol" }])) : [],
    pricesOf(ctx, ["coingecko:ethereum", ...toks.map((t) => tokenKey("ethereum", t))]),
  ]);
  const info = new Map(toks.map((t, i) => [t, { dec: meta[2 * i], sym: meta[2 * i + 1] }]));
  const ethPx = trustedPrice(px, "coingecko:ethereum"), items = [];
  mine.forEach((x, k) => {
    // tokens without a trusted price on an old wallet are mostly spam airdrops: left out
    const legs = held[k].map((t) => {
      const m = info.get(t.token), price = trustedPrice(px, tokenKey("ethereum", t.token));
      if (m?.dec == null || price == null) return null;
      const amount = Number(t.raw) / 10 ** Number(m.dec);
      return { token: t.token, asset: m.sym, amount: round(amount, 6), usd: round(amount * price) };
    }).filter((l) => l && l.usd >= DUST_USD);
    const eth = Number(x.wei) / 1e18;
    if (eth > 0 && (ethPx == null || eth * ethPx >= DUST_USD)) legs.unshift({ token: "native", asset: "ETH", amount: round(eth, 8), usd: ethPx == null ? null : round(eth * ethPx) });
    if (!legs.length) return;
    const one = legs.length === 1 ? legs[0] : null, usd = legs.some((l) => l.usd == null) ? null : round(legs.reduce((s, l) => s + l.usd, 0));
    items.push({
      category: "reward", chain: "ethereum", protocol: "Authereum (L1 smart wallet)", asset: one ? one.asset : legs.map((l) => l.asset).join(" + "), ...(one && one.token !== "native" && { token: one.token }),
      amount: one ? one.amount : legs[0].amount, usd, status: "ready", deadline: null, ...(!one && { legs }),
      action: `move the money out of your old Authereum wallet ${x.w}: this wallet is still one of its auth keys, so it can sign the transfer itself (executeMultipleTransactions on the newest version, an executeMultipleAuthKeyMetaTransactions signed with this key on older ones). Authereum shut down in 2021; its open source Authereum Direct tool does it with this key`,
      how_to_claim: "https://github.com/authereum/direct",
      detail: `Authereum account ${x.w} (implementation ${x.impl}) still lists this wallet in authKeys() and holds ${legs.map((l) => `${l.amount} ${l.asset}`).join(", ")}`,
    });
  });
  return { items, errors };
}
