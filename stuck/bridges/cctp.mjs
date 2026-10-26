// Circle CCTP (v1 + v2): USDC burned on a source chain but never minted on the destination.
// Burns come from DepositForBurn logs (depositor = user), or from the Transfers API on chains that
// cap log ranges (USDC goes user -> TokenMinter before the burn). Circle's Iris API gives the
// message + attestation; the destination MessageTransmitter's used nonces say claimed or not.
import { createPublicClient, http, parseAbi, parseAbiItem, decodeEventLog, encodePacked, encodeFunctionData, keccak256, getAddress, slice, hexToBytes, bytesToHex, hexToBigInt } from "viem";
import * as chains from "viem/chains";
import { createHash } from "node:crypto";
import { MIN, now, rpcUrl, client, RangeCapError, getLogsAll, transferTxs, logsFromTxs, blockTime, pool, memo, warn, revertText, fetchJson } from "../lib.mjs";

const V2 = { messenger: "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d", transmitter: "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64", minter: "0xfd78EE919681417d192449715b2594ab58f5D002" };
// domain -> chain. src = we can find a user's burns there (uncapped logs or Transfers API); v1 = legacy contracts.
const DOMAINS = {
  0: { name: "Ethereum", chain: chains.mainnet, net: "eth-mainnet", src: true, v1: { messenger: "0xBd3fa81B58Ba92a82136038B25aDec7066af3155", transmitter: "0x0a992d191DEeC32aFe36203Ad87D7d289a738F81", minter: "0xc4922d64a24675E16e1586e3e3Aa56C06fABe907" } },
  1: { name: "Avalanche", chain: chains.avalanche, net: "avax-mainnet", src: true, v1: { messenger: "0x6B25532e1060CE10cc3B0A99e5683b91BFDe6982", transmitter: "0x8186359aF5F57FbB40c6b14A588d2A59C0C29880", minter: "0x420F5035fd5dC62a167E7e7f08B604335aE272b8" } },
  2: { name: "OP Mainnet", chain: chains.optimism, net: "opt-mainnet", src: true, v1: { messenger: "0x2B4069517957735bE00ceE0fadAE88a26365528f", transmitter: "0x4D41f22c5a0e5c74090899E5a8Fb597a8842b3e8", minter: "0x33E76C5C31cb928dc6FE6487AB3b2C0769B1A1e3" } },
  3: { name: "Arbitrum", chain: chains.arbitrum, net: "arb-mainnet", src: true, v1: { messenger: "0x19330d10D9Cc8751218eaf51E8885D058642E08A", transmitter: "0xC30362313FBBA5cf9163F0bb16a0e01f01A896ca", minter: "0xE7Ed1fa7f45D05C508232aa32649D89b73b8bA48" } },
  4: { name: "Noble" },
  5: { name: "Solana" },
  6: { name: "Base", chain: chains.base, net: "base-mainnet", src: true, v1: { messenger: "0x1682Ae6375C4E4A97e4B583BC394c861A46D8962", transmitter: "0xAD09780d193884d503182aD4588450C416D6F9D4", minter: "0xe45B133ddc64bE80252b0e9c75A8E74EF280eEd6" } },
  7: { name: "Polygon PoS", chain: chains.polygon, net: "polygon-mainnet", src: true, v1: { messenger: "0x9daF8c91AEFAE50b9c0E69629D3F6Ca40cA3B3FE", transmitter: "0xF3be9355363857F3e001be68856A2f96b4C39Ba9", minter: "0x10f7835F827D6Cf035115E10c50A853d7FB2D2EC" } },
  8: { name: "Sui" },
  9: { name: "Aptos" },
  10: { name: "Unichain", chain: chains.unichain, net: "unichain-mainnet", src: true, v1: { messenger: "0x4e744b28E787c3aD0e810eD65A24461D4ac5a762", transmitter: "0x353bE9E2E38AB1D19104534e4edC21c643Df86f4", minter: "0x726bFEF3cBb3f8AF7d8CB141E78F86Ae43C34163" } },
  11: { name: "Linea", chain: chains.linea, net: "linea-mainnet", src: true },
  12: { name: "Codex", chain: chains.codex },
  13: { name: "Sonic", chain: chains.sonic, net: "sonic-mainnet" }, // capped logs, no Transfers API: destination only
  14: { name: "World Chain", chain: chains.worldchain, net: "worldchain-mainnet", src: true },
  15: { name: "Monad", chain: chains.monad, net: "monad-mainnet", src: true },
  16: { name: "Sei", chain: chains.sei, net: "sei-mainnet", src: true },
  17: { name: "BNB Chain", chain: chains.bsc, net: "bnb-mainnet", src: true },
  18: { name: "XDC", chain: chains.xdc },
  19: { name: "HyperEVM", chain: chains.hyperEvm, net: "hyperliquid-mainnet", src: true },
  21: { name: "Ink", chain: chains.ink, net: "ink-mainnet", src: true },
  22: { name: "Plume", chain: chains.plumeMainnet },
  25: { name: "Starknet" },
  26: { name: "Arc", chain: chains.arc, net: "arc-mainnet", src: true },
  27: { name: "Stellar" },
  28: { name: "EDGE", evm: true }, // own contract addresses, no Alchemy RPC: mint not checked
  29: { name: "Injective", chain: chains.injective, net: "injective-mainnet" },
  30: { name: "Morph", chain: chains.morph },
  31: { name: "Pharos", net: "pharos-mainnet" },
  32: { name: "Cronos", chain: chains.cronos, net: "cronos-mainnet" },
  33: { name: "Plasma", chain: chains.plasma, net: "plasma-mainnet" },
  37: { name: "X Layer", chain: chains.xLayer, net: "xlayer-mainnet" },
};
const evBurnV1 = parseAbiItem("event DepositForBurn(uint64 indexed nonce, address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller)");
const evBurnV2 = parseAbiItem("event DepositForBurn(address indexed burnToken, uint256 amount, address indexed depositor, bytes32 mintRecipient, uint32 destinationDomain, bytes32 destinationTokenMessenger, bytes32 destinationCaller, uint256 maxFee, uint32 indexed minFinalityThreshold, bytes hookData)");
const evMessageSent = parseAbiItem("event MessageSent(bytes message)");
const transmitterAbi = parseAbi(["function usedNonces(bytes32) view returns (uint256)", "function receiveMessage(bytes message, bytes attestation) returns (bool)"]);
const erc20Abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const USDC = { kind: "erc20", network: "eth-mainnet", address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 };
const SOL = { v1: "CCTPmbSD7gX1bxKPAmg77w8oFzNFpaQiQUWD43TKaecd", v2: "CCTPV2Sm4AdWt5296sk4P66VBZ7bEhcARwFaaS9YPbeC" };

// Alchemy where served, else the chain's public RPC (destination checks only).
const dstClient = (d) => d.net ? client(d.chain, d.net) : d.chain && (d.pub ??= createPublicClient({ chain: d.chain, transport: http(undefined, { timeout: 20_000, retryCount: 2 }) }));

// Price as Ethereum USDC when the burned token is the chain's USDC (CCTP burns native USDC only).
const assets = new Map();
const assetOf = (d, token) => {
  const k = `${d.net}:${token}`;
  if (!assets.has(k)) {
    const c = client(d.chain, d.net);
    const read = (functionName) => c.readContract({ address: token, abi: erc20Abi, functionName });
    assets.set(k, Promise.all([read("symbol"), read("decimals")]).then(([symbol, decimals]) => symbol === "USDC" ? USDC : { kind: "erc20", network: d.net, address: getAddress(token), symbol, decimals }).catch(() => USDC));
  }
  return assets.get(k);
};

// Bots and relayers can have tens of thousands of burns: only check the newest ones per chain.
const MAX_PER_CHAIN = 1000;
const capped = (d, xs, total) => {
  if (total > MAX_PER_CHAIN) warn(`Circle CCTP (${d.name}): ${total} burns, checking the newest ${MAX_PER_CHAIN}`);
  return xs.slice(-MAX_PER_CHAIN);
};

async function findOn(domain, d, user) {
  const c = client(d.chain, d.net);
  const contracts = [...(d.v1 ? [{ v: 1, event: evBurnV1, ...d.v1 }] : []), { v: 2, event: evBurnV2, ...V2 }];
  let logs, total = 0;
  try {
    const to = await c.getBlockNumber();
    logs = (await pool(contracts, 2, (k) => getLogsAll(c, { address: k.messenger, event: k.event, args: { depositor: user } }, 0n, to, { chunk: false }).then((ls) => ls.map((l) => ({ ...l, v: k.v }))))).flat();
  } catch (e) {
    if (!(e instanceof RangeCapError)) throw e;
    // Capped chain: depositForBurn pulls the USDC from the depositor into the TokenMinter, then burns it.
    logs = [];
    for (const k of contracts) {
      const all = (await transferTxs(c, user, k.minter, ["erc20"])).map((t) => t.hash);
      total += all.length;
      const txs = all.slice(-MAX_PER_CHAIN);
      logs.push(...(await logsFromTxs(c, txs, [{ address: k.messenger, event: k.event }])).filter((l) => getAddress(l.args.depositor) === user).map((l) => ({ ...l, v: k.v })));
    }
  }
  logs.sort((a, b) => Number(a.blockNumber - b.blockNumber) || a.logIndex - b.logIndex);
  logs = capped(d, logs, Math.max(total, logs.length));
  const perTx = new Map();
  return Promise.all(logs.map(async (l) => {
    const k = `${l.transactionHash}:${l.v}`;
    const ord = perTx.get(k) ?? 0;
    perTx.set(k, ord + 1);
    const dst = Number(l.args.destinationDomain);
    return {
      tx: l.transactionHash, block: l.blockNumber, owner: recipientOf(dst, l.args.mintRecipient), from: user,
      asset: await assetOf(d, l.args.burnToken), amount: l.args.amount,
      version: l.v, route: `${d.name} -> ${DOMAINS[dst]?.name ?? `domain ${dst}`}`, src: domain, dst, ord,
      ...(l.v === 1 ? { nonce: l.args.nonce } : {}), depositor: l.args.depositor,
    };
  }));
}

// ---------- Solana (used-nonce PDAs, no SDK) ----------

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const b58enc = (bytes) => {
  let n = BigInt(bytesToHex(bytes)), s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b) break; s = `1${s}`; }
  return s;
};
const b58dec = (s) => {
  let n = 0n;
  for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
  return hexToBytes(`0x${n.toString(16).padStart(64, "0")}`);
};
// ed25519 point decompression test: a PDA must be off the curve.
const P = 2n ** 255n - 19n, D = (-121665n * modpow(121666n, P - 2n)) % P + P;
function modpow(b, e) { let r = 1n; b %= P; for (; e > 0n; e >>= 1n) { if (e & 1n) r = (r * b) % P; b = (b * b) % P; } return r; }
function onCurve(bytes) {
  const y = BigInt(bytesToHex(Uint8Array.from(bytes).reverse())) & ((1n << 255n) - 1n);
  const y2 = (y * y) % P, u = (y2 - 1n + P) % P, v = (D * y2 + 1n) % P;
  const x2 = (u * modpow(v, P - 2n)) % P;
  return x2 === 0n || modpow(x2, (P - 1n) / 2n) === 1n;
}
function pda(seeds, program) {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash("sha256");
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump)).update(b58dec(program)).update("ProgramDerivedAddress");
    const out = h.digest();
    if (!onCurve(out)) return b58enc(out);
  }
}
async function solRpc(method, params) {
  const r = await fetch(rpcUrl("solana-mainnet"), { method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(30_000), body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json());
  if (r.error) throw new Error(`solana rpc: ${r.error.message}`);
  return r.result;
}
const solAccount = async (address) => {
  const v = (await solRpc("getAccountInfo", [address, { encoding: "base64" }])).value;
  return v && Buffer.from(v.data[0], "base64");
};
async function solanaUsed(it, m) {
  if (it.version === 2) return !!(await solAccount(pda([Buffer.from("used_nonce"), hexToBytes(m.decodedMessage.nonce)], SOL.v2)));
  // v1 packs 6400 nonces per account as a bitmap; seeds use decimal strings, "-" delimiter from domain 11.
  const nonce = BigInt(m.eventNonce), first = ((nonce - 1n) / 6400n) * 6400n + 1n;
  const acct = await solAccount(pda([Buffer.from("used_nonces"), Buffer.from(String(it.src)), Buffer.from(it.src < 11 ? "" : "-"), Buffer.from(String(first))], SOL.v1));
  if (!acct) return false;
  const pos = nonce - first;
  return ((acct.readBigUInt64LE(20 + Number(pos / 64n) * 8) >> (pos % 64n)) & 1n) === 1n;
}

// EVM destinations: the last 20 bytes. Solana: base58 token account. Others: raw bytes32.
function recipientOf(dst, b32) {
  const d = DOMAINS[dst];
  if (d?.evm || d?.chain || d?.net) return getAddress(slice(b32, 12));
  if (dst === 5) return b58enc(hexToBytes(b32));
  return b32;
}

// ---------- status ----------

// Iris allows 35 req/s and locks callers out for 5 minutes beyond that: stay near 12/s.
let irisNext = 0;
const irisMessages = memo((src, tx) => {
  const at = Math.max(irisNext, Date.now());
  irisNext = at + 80;
  return new Promise((r) => setTimeout(r, Math.max(0, at - Date.now()))).then(() => fetchJson(`https://iris-api.circle.com/v2/messages/${src}?transactionHash=${tx}`));
}, 5 * MIN);
const used = (c, transmitter, key) => c.readContract({ address: transmitter, abi: transmitterAbi, functionName: "usedNonces", args: [key] }).then((x) => x !== 0n);
const destCallerOf = (version, message) => slice(message, version === 1 ? 96 : 120, version === 1 ? 116 : 140); // last 20 bytes of the bytes32

export default {
  key: "cctp", name: "Circle CCTP", scan: false,
  async find(user) {
    const srcs = Object.entries(DOMAINS).filter(([, d]) => d.src);
    return (await pool(srcs, 5, ([domain, d]) => findOn(Number(domain), d, user).catch((e) => {
      warn(`Circle CCTP (${d.name}): ${(e.shortMessage ?? e.message).split("\n")[0]}`, e);
      return [];
    }))).flat();
  },
  async status(it) {
    const src = DOMAINS[it.src], dst = DOMAINS[it.dst] ?? { name: `domain ${it.dst}` };
    const { ord, depositor } = it; // matching hints only, keep them out of the output
    delete it.ord; delete it.depositor;
    it.time = await blockTime(client(src.chain, src.net), src.net, it.block);
    it.detail = `${it.route}, CCTP v${it.version}`;
    const transmitter = it.version === 1 ? dst.v1?.transmitter : dst.chain || dst.net ? V2.transmitter : null;
    it.action = `Resume in the app you bridged with, or receiveMessage(message, attestation) on ${dst.name}${transmitter ? ` MessageTransmitter${it.version === 2 ? "V2" : ""} ${transmitter}` : it.dst === 5 ? ` (program ${SOL[`v${it.version}`]})` : ""} (message + attestation are in --json output, or from iris-api.circle.com)`;
    const rpc = !!(dst.chain || dst.net);
    // v1 nonces are known from the burn log, so most claimed transfers settle without Iris.
    const v1Key = it.version === 1 && keccak256(encodePacked(["uint32", "uint64"], [it.src, it.nonce]));
    if (v1Key && rpc && transmitter && (await used(dstClient(dst), transmitter, v1Key))) { it.status = "claimed"; return it; }
    const res = await irisMessages(it.src, it.tx);
    if (!res) { it.status = "unknown"; it.detail += "; Iris API unavailable"; return it; }
    const list = (res.messages ?? []).filter((m) => m.cctpVersion === it.version);
    const body = (m) => m.decodedMessage?.decodedMessageBody;
    const m = it.version === 1
      ? list.find((x) => BigInt(x.eventNonce || -1) === it.nonce)
      : list.filter((x) => !body(x) || (BigInt(body(x).amount) === it.amount && getAddress(body(x).messageSender) === getAddress(depositor)))[ord] ?? list[ord];
    if (!m) {
      // Iris indexes a burn once its source block is final; give it a few hours before calling it lost.
      it.status = now() - it.time < 3 * 3600 ? "waiting" : "unknown";
      it.detail += "; no message in Circle Iris";
      return it;
    }
    if (m.status !== "complete" || !/^0x[0-9a-f]+$/i.test(m.attestation ?? "")) {
      it.status = "waiting";
      it.detail += `; attestation pending${m.delayReason ? ` (${m.delayReason})` : ""}`;
      return it;
    }
    // Iris drops the message body for old v1 burns: rebuild it from the source MessageSent log.
    if (!m.message && it.version === 1) {
      const r = await client(src.chain, src.net).getTransactionReceipt({ hash: it.tx });
      m.message = r.logs.filter((l) => l.address.toLowerCase() === src.v1.transmitter.toLowerCase()).map((l) => { try { return decodeEventLog({ abi: [evMessageSent], data: l.data, topics: l.topics }).args.message; } catch { return null; } })
        .find((x) => x && hexToBigInt(slice(x, 12, 20)) === it.nonce);
      if (!m.message) { it.status = "unknown"; it.detail += "; message not found"; return it; }
    }
    const fee = body(m)?.feeExecuted ? BigInt(body(m).feeExecuted) : 0n;
    if (fee > 0n) it.detail += `, fee ${fee}`;
    if (it.dst === 5) {
      it.status = (await solanaUsed(it, m)) ? "claimed" : "claimable";
      // v2 attestations expire at a destination slot; Solana cannot be simulated cheaply, so compare slots.
      const exp = BigInt(body(m)?.expirationBlock ?? 0);
      if (it.status === "claimable" && exp > 0n && BigInt(await solRpc("getSlot", [])) > exp) it.detail += `; attestation expired, re-attest first (POST iris-api.circle.com/v2/reattest/${m.decodedMessage.nonce})`;
    } else if (rpc) {
      if (!transmitter) { it.status = "unknown"; it.detail += "; no v1 contracts on destination"; return it; }
      const c = dstClient(dst);
      if (!v1Key && (await used(c, transmitter, m.decodedMessage.nonce))) { // v1 was checked above
        it.status = "claimed";
      } else {
        // Ground truth: simulate the mint from whoever is allowed to submit it.
        const caller = destCallerOf(it.version, m.message);
        const restricted = hexToBigInt(caller) !== 0n;
        try {
          await c.call({ to: transmitter, account: restricted ? getAddress(caller) : it.owner, data: encodeFunctionData({ abi: transmitterAbi, functionName: "receiveMessage", args: [m.message, m.attestation] }) });
          it.status = "claimable";
        } catch (e) {
          const t = revertText(e);
          if (/expired/i.test(t)) { it.status = "claimable"; it.detail += `; attestation expired, re-attest first (POST iris-api.circle.com/v2/reattest/${m.decodedMessage.nonce})`; }
          else if (/blacklist|paused/i.test(t)) { it.status = "blocked"; it.detail += `; ${t.match(/reason:\s*([^\n]+)/)?.[1] ?? "USDC blacklist or bridge paused"}`; }
          else { it.status = "unknown"; it.detail += `; mint reverts: ${(t.match(/reason:\s*([^\n]+)/)?.[1] ?? e.shortMessage ?? "").trim()}`; }
        }
        if (restricted) it.detail += `; only ${getAddress(caller)} can submit (app relayer contract)`;
      }
    } else {
      it.status = "unknown";
      it.detail += `; attested, mint on ${dst.name} not checked`;
    }
    if (it.status === "claimable") Object.assign(it, { message: m.message, attestation: m.attestation });
    return it;
  },
};
