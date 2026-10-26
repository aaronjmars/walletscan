// Wormhole Token Bridge (Portal) and NTT: transfers whose VAA was signed but never redeemed on the destination.
// Wormholescan lists the user's operations (as sender or recipient); EVM destinations are checked onchain
// (isTransferCompleted / NttManager state) and the redeem is simulated with eth_call; Token Bridge transfers
// to Solana are checked through the claim PDA. Other destinations fall back to the Wormholescan status.
import { parseAbi, keccak256, sha256, concat, toHex, getAddress, formatUnits, encodeFunctionData, zeroAddress } from "viem";
import * as chains from "viem/chains";
import { ed25519 } from "@noble/curves/ed25519";
import { base58 } from "@scure/base";
import { DAY, MIN, now, client, l1, rpcUrl, pool, memo, warn, revertText, fetchJson } from "../lib.mjs";

const API = "https://api.wormholescan.io";
const MAX_PAGES = 20; // 2000 operations; bots with more are cut off (newest first)

// Wormhole chain id -> [viem chain, Alchemy network, Token Bridge]. Ids checked against TokenBridge.chainId() on each network.
const WH = {
  2: [chains.mainnet, "eth-mainnet", "0x3ee18B2214AFF97000D974cf647E7C347E8fa585"],
  4: [chains.bsc, "bnb-mainnet", "0xB6F6D86a8f9879A9c87f643768d9efc38c1Da6E7"],
  5: [chains.polygon, "polygon-mainnet", "0x5a58505a96D1dbf8dF91cB21B54419FC36e93fdE"],
  6: [chains.avalanche, "avax-mainnet", "0x0e082F06FF657D94310cB8cE8B0D9a04541d8052"],
  13: [chains.kaia, "kaia-mainnet", "0x5b08ac39EAED75c0439FC750d9FE7E1F9dD0193F"],
  14: [chains.celo, "celo-mainnet", "0x796Dff6D74F3E27060B71255Fe517BFb23C93eed"],
  16: [chains.moonbeam, "moonbeam-mainnet", "0xb1731c586ca89a23809861c6103f0b96b3f57d92"],
  23: [chains.arbitrum, "arb-mainnet", "0x0b2402144Bb366A632D14B83F244D2e0e21bD39c"],
  24: [chains.optimism, "opt-mainnet", "0x1D68124e65faFC907325e3EDbF8c4d84499DAa8b"],
  30: [chains.base, "base-mainnet", "0x8d2de8d2f73F1F4cAB472AC9A881C9b123C79627"],
  34: [chains.scroll, "scroll-mainnet", "0x24850c6f61C438823F01B7A3BF2B89B72174Fa9d"],
  35: [chains.mantle, "mantle-mainnet", "0x24850c6f61C438823F01B7A3BF2B89B72174Fa9d"],
  36: [chains.blast, "blast-mainnet", "0x24850c6f61C438823F01B7A3BF2B89B72174Fa9d"],
  37: [chains.xLayer, "xlayer-mainnet", "0x5537857664B0f9eFe38C9f320F75fEf23234D904"],
  38: [chains.linea, "linea-mainnet"],
  39: [chains.berachain, "berachain-mainnet", "0x3Ff72741fd67D6AD0668d93B41a09248F4700560"],
  40: [chains.sei, "sei-mainnet", "0x3Ff72741fd67D6AD0668d93B41a09248F4700560"],
  44: [chains.unichain, "unichain-mainnet", "0x3Ff72741fd67D6AD0668d93B41a09248F4700560"],
  45: [chains.worldchain, "worldchain-mainnet", "0xc309275443519adca74c9136b02A38eF96E3a1f6"],
  46: [chains.ink, "ink-mainnet", "0x3Ff72741fd67D6AD0668d93B41a09248F4700560"],
  47: [chains.hyperEvm, "hyperliquid-mainnet"],
  48: [chains.monad, "monad-mainnet", "0x0B2719cdA2F10595369e6673ceA3Ee2EDFa13BA7"],
  64: [chains.megaeth, "megaeth-mainnet", "0xf97B81E513f53c7a6B57Bd0b103a6c295b3096C5"],
};
const NAMES = { 1: "Solana", 3: "Terra", 8: "Algorand", 15: "NEAR", 18: "Terra 2", 19: "Injective", 21: "Sui", 22: "Aptos", 32: "Sei", 50: "Mezo", 51: "Fogo" };
const chainName = (id) => WH[id]?.[0].name ?? NAMES[id] ?? `chain ${id}`;
const SOL_TOKEN_BRIDGE = "wormDTUJ6AWPNvk59vGQbDvGJmqbDTdgWgAqcLBCgUb";
const ETH_CORE = "0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B";

const tbAbi = parseAbi([
  "function isTransferCompleted(bytes32 hash) view returns (bool)",
  "function completeTransfer(bytes encodedVm)",
  "function completeTransferWithPayload(bytes encodedVm) returns (bytes)",
  "function wrappedAsset(uint16 tokenChainId, bytes32 tokenAddress) view returns (address)",
]);
const nttAbi = parseAbi([
  "function isMessageExecuted(bytes32 digest) view returns (bool)",
  "function isMessageApproved(bytes32 digest) view returns (bool)",
  "function getInboundQueuedTransfer(bytes32 digest) view returns (uint72 amount, uint64 txTimestamp, address recipient)",
  "function rateLimitDuration() view returns (uint64)",
  "function getTransceivers() view returns (address[])",
  "function token() view returns (address)",
  "function receiveMessage(bytes encodedMessage)",
  "function executeMsg(uint16 sourceChainId, bytes32 sourceNttManagerAddress, (bytes32 id, bytes32 sender, bytes payload) message)",
  "error InvalidVaa(string reason)",
  "error TransferAlreadyCompleted(bytes32 vaaHash)",
  "error RequireContractIsNotPaused()",
  "error InvalidWormholePeer(uint16 chainId, bytes32 peerAddress)",
]);
const ercAbi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const coreAbi = parseAbi(["function getCurrentGuardianSetIndex() view returns (uint32)", "function getGuardianSet(uint32 index) view returns ((address[] keys, uint32 expirationTime))"]);

// ---------- Wormholescan ----------

// Both modules read the same operation list: fetch it once per wallet. Pages come newest first.
const operations = memo(async (user) => {
  const page = async (p) => {
    const r = await fetchJson(`${API}/api/v1/operations?address=${user}&page=${p}&pageSize=100`);
    if (!r || r.code) throw new Error(`Wormholescan operations failed${r?.message ? `: ${r.message}` : ""}`);
    return r.operations ?? [];
  };
  const out = await page(0);
  for (let p = 1; out.length === p * 100;) {
    if (p >= MAX_PAGES) { warn(`Wormhole: ${user} has over ${MAX_PAGES * 100} operations, only the newest were checked`); break; }
    const n = Math.min(5, MAX_PAGES - p);
    const batch = await Promise.all(Array.from({ length: n }, (_, i) => page(p + i)));
    p += n;
    for (const b of batch) { out.push(...b); if (b.length < 100) return out; }
  }
  return out;
}, 5 * MIN);

// ---------- VAA parsing ----------

const hex = (b) => toHex(b);
const evmAddr = (b32) => getAddress(hex(b32.subarray(12)));
function parseVaa(raw) {
  const v = Buffer.from(raw, "base64");
  const body = v.subarray(6 + v[5] * 66);
  return { raw: hex(v), gsi: v.readUInt32BE(1), hash: keccak256(keccak256(body)), emitterChain: body.readUInt16BE(8), emitter: body.subarray(10, 42), seq: body.readBigUInt64BE(42), payload: body.subarray(51) };
}

// Token Bridge transfer (payload 1) or transfer with payload (3); amounts are capped at 8 decimals.
function parseTransfer(p) {
  if (p[0] !== 1 && p[0] !== 3) return null;
  return { type: p[0], amount: BigInt(hex(p.subarray(1, 33))), token: p.subarray(33, 65), tokenChain: p.readUInt16BE(65), to: p.subarray(67, 99), toChain: p.readUInt16BE(99) };
}

// NTT: WormholeTransceiver message wrapping an NttManager message wrapping a NativeTokenTransfer.
function parseNtt(p, emitterChain) {
  if (p.length < 70 || hex(p.subarray(0, 4)) !== "0x9945ff10") return null;
  const len = p.readUInt16BE(68), m = p.subarray(70, 70 + len), t = m.subarray(66);
  if (hex(t.subarray(0, 4)) !== "0x994e5454") return null;
  const u16 = Buffer.alloc(2); u16.writeUInt16BE(emitterChain);
  return {
    srcManager: hex(p.subarray(4, 36)), dstManager: hex(p.subarray(36, 68)), manager: evmAddr(p.subarray(36, 68)),
    message: { id: hex(m.subarray(0, 32)), sender: hex(m.subarray(32, 64)), payload: hex(m.subarray(66)) },
    digest: keccak256(concat([u16, m])), // NttManager: keccak256(abi.encodePacked(sourceChainId, managerMessage))
    decimals: t[4], amount: t.readBigUInt64BE(5), token: t.subarray(13, 45), to: t.subarray(45, 77), toChain: t.readUInt16BE(77),
  };
}

// ---------- shared checks ----------

// Guardian sets on Ethereum: a VAA signed by an expired set can no longer be redeemed anywhere.
const sets = memo(async () => {
  const cur = await l1().readContract({ address: ETH_CORE, abi: coreAbi, functionName: "getCurrentGuardianSetIndex" });
  return Promise.all(Array.from({ length: cur + 1 }, (_, j) => l1().readContract({ address: ETH_CORE, abi: coreAbi, functionName: "getGuardianSet", args: [j] }).then((g) => g.expirationTime)));
}, 60 * MIN);
async function guardianSetExpired(i) {
  const exp = (await sets())[i];
  return exp != null && exp !== 0 && exp < now();
}

// Solana: redeem state lives in program-derived accounts (off-curve sha256 of seeds, bump, program id).
function pda(seeds, pid) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = sha256(concat([...seeds, new Uint8Array([bump]), pid, new TextEncoder().encode("ProgramDerivedAddress")]), "bytes");
    try { ed25519.ExtendedPoint.fromHex(h); } catch { return base58.encode(h); }
  }
}
async function solanaAccount(address) {
  const r = await fetch(rpcUrl("solana-mainnet"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [address, { encoding: "base64" }] }), signal: AbortSignal.timeout(30_000) }).then((x) => x.json());
  if (r.error) throw new Error(r.error.message);
  return r.result.value ? Buffer.from(r.result.value.data[0], "base64") : null;
}
// Token Bridge claim account, seeds [emitter, emitterChain u16 BE, sequence u64 BE]: it exists once redeemed.
async function solanaClaimed(v) {
  const c = Buffer.alloc(10); c.writeUInt16BE(v.emitterChain); c.writeBigUInt64BE(v.seq, 2);
  return (await solanaAccount(pda([v.emitter, c.subarray(0, 2), c.subarray(2)], base58.decode(SOL_TOKEN_BRIDGE)))) != null;
}
// NTT inbox item, seeds ["inbox_item", digest] under the manager program. Layout: 8 discriminator, init, bump,
// amount u64, recipient, votes u128, then release_status (0 not approved, 1 release after i64, 2 released).
async function solanaInbox(n, programHex) {
  const d = await solanaAccount(pda([new TextEncoder().encode("inbox_item"), Buffer.from(n.digest.slice(2), "hex")], Buffer.from(programHex.slice(2), "hex")));
  if (!d) return null;
  return { status: d[66], releaseAfter: d[66] === 1 ? Number(d.readBigInt64LE(67)) : null };
}

// Operations sometimes come without the VAA although the guardians signed it: ask the guardian VAA endpoint.
async function signedVaa(id) {
  const r = await fetchJson(`${API}/v1/signed_vaa/${id}`);
  return r?.vaaBytes ? parseVaa(r.vaaBytes) : null;
}

// Decimals of the 8-decimal-capped amount: match the API's human amount, else read the token.
function apiDecimals(raw, human) {
  const want = Number(human);
  if (!human || !(want > 0)) return null;
  for (let d = 8; d >= 0; d--) if (Math.abs(Number(formatUnits(raw, d)) - want) <= want * 1e-9) return d;
  return null;
}
const tokenInfo = new Map();
function readToken(net, chain, address) {
  const k = `${net}:${address}`;
  if (!tokenInfo.has(k)) tokenInfo.set(k, (async () => {
    const c = client(chain, net);
    const [decimals, symbol] = await Promise.all([
      c.readContract({ address, abi: ercAbi, functionName: "decimals" }).catch(() => null),
      c.readContract({ address, abi: ercAbi, functionName: "symbol" }).catch(() => null),
    ]);
    return { decimals, symbol };
  })());
  return tokenInfo.get(k);
}

// Price on the origin chain when it is EVM, else on a chain where the bridge holds a wrapped copy.
// `units` is the decimals of `amount`; wrapped copies made by the Token Bridge also cap at 8.
async function asset({ tokenChain, token, units, symbol, wrapped }) {
  let net, address, info;
  if (WH[tokenChain]) {
    [, net] = WH[tokenChain]; address = evmAddr(token);
    if (units == null || !symbol) info = await readToken(net, WH[tokenChain][0], address);
    if (units == null && info?.decimals != null) units = Math.min(8, info.decimals);
  } else {
    for (const [cid, a] of wrapped ?? []) {
      const w = await a().catch(() => zeroAddress);
      if (w && w !== zeroAddress) { net = WH[cid][1]; address = w; info = await readToken(net, WH[cid][0], w); break; }
    }
    if (units == null && info?.decimals != null) units = info.decimals;
  }
  return { kind: "erc20", network: net ?? "eth-mainnet", address: address ?? "0x000000000000000000000000000000000000dEaD", symbol: symbol || info?.symbol || "?", decimals: units ?? 8 };
}

function base(o, v) {
  const sp = o.content?.standarizedProperties ?? {};
  return {
    tx: o.sourceChain?.transaction?.txHash ?? o.id, block: 0n, time: Math.floor(Date.parse(o.sourceChain?.timestamp ?? 0) / 1000) || 0,
    owner: sp.toAddress || o.targetChain?.to, toChain: Number(sp.toChain), id: o.id, op: o, vaa: v,
  };
}

// No signed VAA yet: held by the Governor (24h), still finalizing, or never observed.
async function unsigned(it) {
  const [c, e, s] = it.id.split("/");
  const q = await fetchJson(`${API}/v1/governor/is_vaa_enqueued/${c}/${e}/${s}`);
  if (q?.isEnqueued) return Object.assign(it, { status: "waiting", detail: "held by the Wormhole Governor (up to 24h)" });
  const old = now() - it.time > 3 * DAY;
  return Object.assign(it, { status: old ? "blocked" : "waiting", detail: old ? "never signed by the guardians: needs re-observation" : "awaiting guardian signatures" });
}

// Short revert reason from a viem error text: require() string, else decoded custom error, else first line.
const reason = (m) => {
  const r = m.match(/reverted with the following reason:\s*(.+)/)?.[1] ?? m.match(/Error: (\w+)\(.*\)\s*\((.*)\)/)?.slice(1).join(": ");
  return (r ?? m.trim().split("\n")[0]).trim().slice(0, 160);
};

// Drop the working fields (raw operation, VAA) whatever the outcome, so --json stays small.
const tidy = (fn) => async (it) => { try { return await fn(it); } finally { for (const k of ["op", "vaa", "toChain", "id"]) delete it[k]; } };

// ---------- Token Bridge ----------

const wormhole = {
  key: "wormhole", name: "Wormhole", scan: false,
  async find(user) {
    const ops = (await operations(user)).filter((o) => o.content?.standarizedProperties?.appIds?.includes("PORTAL_TOKEN_BRIDGE") && o.content?.payload?.payloadType != null);
    return (await pool(ops, 6, async (o) => {
      const v = o.vaa?.raw ? parseVaa(o.vaa.raw) : null;
      const t = v ? parseTransfer(v.payload) : null;
      const p = o.content.payload;
      if (v && !t) return null;
      const tokenChain = t?.tokenChain ?? Number(p.tokenChain), token = t?.token ?? Buffer.from(String(p.tokenAddress).slice(2).padStart(64, "0"), "hex");
      const amount = t?.amount ?? BigInt(p.amount || 0), toChain = t?.toChain ?? Number(p.toChain);
      const wrapped = [toChain, 2].filter((c, i, a) => WH[c]?.[2] && c !== tokenChain && a.indexOf(c) === i)
        .map((c) => [c, () => client(WH[c][0], WH[c][1]).readContract({ address: WH[c][2], abi: tbAbi, functionName: "wrappedAsset", args: [tokenChain, hex(token)] })]);
      const units = apiDecimals(amount, o.data?.tokenAmount);
      return { ...base(o, v), asset: await asset({ tokenChain, token, units, symbol: o.data?.symbol, wrapped }), amount };
    })).filter((i) => i && i.amount > 0n);
  },
  status: tidy(async (it) => {
    const { op, toChain } = it;
    const where = chainName(toChain);
    it.action = `portalbridge.com > Advanced Tools > Redeem (source tx ${it.tx}), or TokenBridge.completeTransfer(vaa) on ${where}`;
    if (op.targetChain?.status === "completed") return Object.assign(it, { status: "claimed" });
    const v = it.vaa ?? await signedVaa(it.id), t = v && parseTransfer(v.payload);
    if (!t) return unsigned(it);
    it.detail = `to ${where}, seq ${v.seq}`;
    if (t.type === 3) it.action = `redeem through the app that sent it (Wormhole Connect / relayer), or TokenBridge.completeTransferWithPayload(vaa) from ${evmAddr(t.to)} on ${where}`;
    const dest = WH[toChain];
    if (dest?.[2]) {
      const c = client(dest[0], dest[1]);
      if (await c.readContract({ address: dest[2], abi: tbAbi, functionName: "isTransferCompleted", args: [v.hash] })) return Object.assign(it, { status: "claimed" });
      // Ground truth: simulate the redeem. Payload-3 transfers can only be redeemed by their recipient contract.
      const fn = t.type === 3 ? "completeTransferWithPayload" : "completeTransfer";
      try {
        await c.simulateContract({ address: dest[2], abi: tbAbi, functionName: fn, args: [v.raw], account: evmAddr(t.to) });
        it.status = "claimable";
      } catch (e) {
        const m = revertText(e);
        if (/already completed/i.test(m)) it.status = "claimed";
        else if (/guardian set has expired/i.test(m)) Object.assign(it, { status: "blocked", detail: `${it.detail}; VAA signed by expired guardian set ${v.gsi}, needs re-observation` });
        else if (/no wrapper/i.test(m)) Object.assign(it, { status: "claimable", detail: `${it.detail}; token not attested on ${where} yet, attest it first` });
        else Object.assign(it, { status: "unknown", detail: `${it.detail}; redeem reverts: ${reason(m)}` });
      }
      return it;
    }
    if (toChain === 1) {
      if (await solanaClaimed(v)) return Object.assign(it, { status: "claimed" });
      if (await guardianSetExpired(v.gsi)) return Object.assign(it, { status: "blocked", detail: `${it.detail}; VAA signed by expired guardian set ${v.gsi}, needs re-observation` });
      return Object.assign(it, { status: "claimable", action: `portalbridge.com > Advanced Tools > Redeem (source tx ${it.tx}), or token bridge complete_transfer on Solana` });
    }
    // Other destinations: only the guardian set is checked onchain; a missing redeem may be an indexing gap.
    if (await guardianSetExpired(v.gsi)) return Object.assign(it, { status: "blocked", detail: `${it.detail}; VAA signed by expired guardian set ${v.gsi}, needs re-observation` });
    return Object.assign(it, { status: "unknown", detail: `${it.detail}; Wormholescan shows no redeem, not verified onchain` });
  }),
};

// ---------- NTT ----------

const ntt = {
  key: "wormhole-ntt", name: "Wormhole NTT", scan: false,
  async find(user) {
    const ops = (await operations(user)).filter((o) => o.content?.standarizedProperties?.appIds?.includes("NATIVE_TOKEN_TRANSFER"));
    return (await pool(ops, 6, async (o) => {
      const v = o.vaa?.raw ? parseVaa(o.vaa.raw) : null;
      const n = v ? parseNtt(v.payload, v.emitterChain) : null;
      const pm = o.content?.payload?.nttMessage;
      if (v && !n) return null;
      if (!n && !pm) return null;
      const tokenChain = Number(o.content.standarizedProperties.tokenChain ?? o.emitterChain);
      const token = n?.token ?? Buffer.from(String(pm.sourceToken).slice(2), "hex");
      const amount = n?.amount ?? BigInt(pm.trimmedAmount?.amount ?? 0), units = n?.decimals ?? Number(pm.trimmedAmount?.decimals ?? 8);
      const toChain = n?.toChain ?? Number(pm.toChain);
      // A non-EVM source token prices through the destination NttManager's token instead.
      const wrapped = n && WH[toChain] ? [[toChain, () => client(WH[toChain][0], WH[toChain][1]).readContract({ address: n.manager, abi: nttAbi, functionName: "token" })]] : [];
      return { ...base(o, v), asset: await asset({ tokenChain, token, units, symbol: o.data?.symbol, wrapped }), amount };
    })).filter((i) => i && i.amount > 0n);
  },
  status: tidy(async (it) => {
    const { op, toChain } = it;
    const where = chainName(toChain), dest = WH[toChain];
    it.action = `the token's NTT bridge app or Wormhole Connect (resume with source tx ${it.tx}), or WormholeTransceiver.receiveMessage(vaa) on ${where}`;
    const tc = op.targetChain;
    const v = it.vaa ?? (tc?.status === "completed" ? null : await signedVaa(it.id)), n = v && parseNtt(v.payload, v.emitterChain);
    if (!n) return tc?.status === "completed" ? Object.assign(it, { status: "claimed" }) : unsigned(it);
    it.detail = `to ${where}, seq ${v.seq}`;
    // A redeemed message credited the recipient unless the inbound rate limit queued it: skip the RPC when the
    // API saw the token arrive.
    const credited = (tc?.balanceChanges ?? []).some((b) => b.tokenAddress !== "native" && BigInt(b.amount) > 0n);
    if (tc?.status === "completed" && credited) return Object.assign(it, { status: "claimed" });
    if (toChain === 1) {
      const inbox = await solanaInbox(n, n.dstManager);
      if (inbox?.status === 2) return Object.assign(it, { status: "claimed" });
      if (inbox?.status === 1) {
        it.action = `the token's NTT bridge app or Wormhole Connect, or release_inbound_unlock on NTT program ${base58.encode(Buffer.from(n.dstManager.slice(2), "hex"))} (anyone can call)`;
        return Object.assign(it, inbox.releaseAfter <= now()
          ? { status: "claimable", detail: `${it.detail}; inbound rate-limit queue elapsed` }
          : { status: "waiting", detail: `${it.detail}; queued by the inbound rate limit until ${new Date(inbox.releaseAfter * 1000).toISOString().slice(0, 16)}Z` });
      }
      if (inbox) return Object.assign(it, { status: now() - it.time > 7 * DAY ? "blocked" : "waiting", detail: `${it.detail}; delivered, awaiting attestations from other transceivers` });
      if (await guardianSetExpired(v.gsi)) return Object.assign(it, { status: "blocked", detail: `${it.detail}; VAA signed by expired guardian set ${v.gsi}, needs re-observation` });
      return Object.assign(it, { status: "claimable", action: `the token's NTT bridge app or Wormhole Connect (resume with source tx ${it.tx}): posts the VAA, redeems and releases on Solana` });
    }
    if (!dest) {
      if (tc?.status === "completed") return Object.assign(it, { status: "claimed" });
      if (await guardianSetExpired(v.gsi)) return Object.assign(it, { status: "blocked", detail: `${it.detail}; VAA signed by expired guardian set ${v.gsi}, needs re-observation` });
      return Object.assign(it, { status: "unknown", detail: `${it.detail}; Wormholescan shows no redeem, not verified onchain` });
    }
    const c = client(dest[0], dest[1]);
    const read = (functionName, args) => c.readContract({ address: n.manager, abi: nttAbi, functionName, args });
    if (await read("isMessageExecuted", [n.digest])) {
      // Older managers encode TrimmedAmount as a (uint64,uint8) struct, so read txTimestamp off the raw words;
      // some versions revert instead of returning zeros when nothing is queued.
      const r = await c.call({ to: n.manager, data: encodeFunctionData({ abi: nttAbi, functionName: "getInboundQueuedTransfer", args: [n.digest] }) }).catch((e) => { if (/revert/i.test(revertText(e))) return {}; throw e; });
      const words = (r.data ?? "0x").slice(2).match(/.{64}/g) ?? [];
      const ts = Number(BigInt(`0x${words[words.length === 4 ? 2 : 1] ?? "0"}`));
      if (!ts) return Object.assign(it, { status: "claimed" });
      const ready = ts + Number(await read("rateLimitDuration"));
      it.action = `NttManager(${n.manager}).completeInboundQueuedTransfer(${n.digest}) on ${where} (anyone can call)`;
      return Object.assign(it, ready <= now()
        ? { status: "claimable", detail: `${it.detail}; inbound rate-limit queue elapsed` }
        : { status: "waiting", detail: `${it.detail}; queued by the inbound rate limit until ${new Date(ready * 1000).toISOString().slice(0, 16)}Z` });
    }
    const sim = async (args) => { try { await c.simulateContract({ account: evmAddr(n.to), ...args }); return null; } catch (e) { return revertText(e); } };
    if (await read("isMessageApproved", [n.digest]).catch(() => false)) {
      const m = await sim({ address: n.manager, abi: nttAbi, functionName: "executeMsg", args: [v.emitterChain, n.srcManager, n.message] });
      if (!m) return Object.assign(it, { status: "claimable", action: `NttManager(${n.manager}).executeMsg(...) on ${where} (attested, never executed)` });
    }
    // Ground truth: simulate delivering the VAA to each of the manager's transceivers.
    const reasons = [];
    for (const t of await read("getTransceivers").catch(() => [])) {
      const m = await sim({ address: t, abi: nttAbi, functionName: "receiveMessage", args: [v.raw] });
      if (!m) return Object.assign(it, { status: "claimable" });
      reasons.push(m);
    }
    const all = reasons.join(" ");
    if (/guardian set has expired/i.test(all)) Object.assign(it, { status: "blocked", detail: `${it.detail}; VAA signed by expired guardian set ${v.gsi}, needs re-observation` });
    else if (/RequireContractIsNotPaused|paused/i.test(all)) Object.assign(it, { status: "blocked", detail: `${it.detail}; NTT manager is paused` });
    else if (/TransferAlreadyCompleted/.test(all)) Object.assign(it, { status: now() - it.time > 7 * DAY ? "blocked" : "waiting", detail: `${it.detail}; delivered, awaiting attestations from other transceivers` });
    else Object.assign(it, { status: "unknown", detail: `${it.detail}; redeem reverts: ${reasons.length ? reason(reasons[0]) : "no transceivers"}` });
    return it;
  }),
};

export default [wormhole, ntt];
