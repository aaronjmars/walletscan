// Gnosis Chain -> Ethereum withdrawals: OmniBridge (tokens, over the AMB) and the xDai bridge (xDAI -> DAI/USDS).
// Both are claimed on Ethereum with executeSignatures(message, signatures) once the validators have signed on Gnosis.
import { parseAbi, parseAbiItem, decodeFunctionData, encodePacked, keccak256, encodeFunctionData, concat, slice, size, getAddress, zeroAddress, pad, toHex, recoverMessageAddress } from "viem";
import * as chains from "viem/chains";
import { DAY, MIN, now, client, l1, getLogsAll, transferTxs, logsFromTxs, blockTime, pool, memo, revertText, ETH, erc20, fetchJson } from "../lib.mjs";

const NET = "gnosis-mainnet";
const G = {
  amb: "0x75Df5AF045d91108662D8080fD1FEFAd6aA0bb59", // home AMB
  omni: "0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d", // home OmniBridge mediator
  xdai: "0x7301CFA0e1756B71869E93d4e4Dca5c7d0eb0AA6", // home xDai bridge
};
const E = {
  amb: "0x4C36d2919e407f0Cc2Ee3c993ccF8ac26d9CE64e",
  omni: "0x88ad09518695c6c3712AC10a214bE5109a655671",
  xdai: "0x4aa42145Aa6Ebf72e164C9bBC74fbD3788045016",
  wethRouter: "0xa6439Ca0FCbA1d0F80df0bE6A17220feD9c9038a", // unwraps bridged WETH to ETH for the address in the call data
};
const DAI = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
const SIGN_GRACE = DAY; // validators normally sign within minutes; unsigned after a day = stuck on their side

const evAmbRequest = parseAbiItem("event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)");
const evOmniInit = parseAbiItem("event TokensBridgingInitiated(address indexed token, address indexed sender, uint256 value, bytes32 indexed messageId)");
// xDai bridge event versions: tx hash as nonce (until 2025), then a counter nonce, then the counter plus the L1 token.
const evXdai = [
  parseAbiItem("event UserRequestForSignature(address recipient, uint256 value)"),
  parseAbiItem("event UserRequestForSignature(address recipient, uint256 value, bytes32 nonce)"),
  parseAbiItem("event UserRequestForSignature(address recipient, uint256 value, bytes32 nonce, address token)"),
];
const homeAbi = parseAbi([
  "function numMessagesSigned(bytes32) view returns (uint256)",
  "function signature(bytes32, uint256) view returns (bytes)",
  "function requiredSignatures() view returns (uint256)",
  "function messageFixed(bytes32) view returns (bool)",
]);
const foreignAbi = parseAbi([
  "function relayedMessages(bytes32) view returns (bool)",
  "function messageCallStatus(bytes32) view returns (bool)",
  "function executeSignatures(bytes message, bytes signatures)",
  "function withinExecutionLimit(uint256) view returns (bool)",
  "function bridgedTokenAddress(address) view returns (address)",
  "function validatorContract() view returns (address)",
  "function validatorList() view returns (address[])",
]);
const mediatorAbi = parseAbi([
  "function handleNativeTokens(address token, address receiver, uint256 value)",
  "function handleNativeTokensAndCall(address token, address receiver, uint256 value, bytes data)",
  "function handleBridgedTokens(address token, address receiver, uint256 value)",
  "function handleBridgedTokensAndCall(address token, address receiver, uint256 value, bytes data)",
  "function deployAndHandleBridgedTokens(address token, string name, string symbol, uint8 decimals, address receiver, uint256 value)",
  "function deployAndHandleBridgedTokensAndCall(address token, string name, string symbol, uint8 decimals, address receiver, uint256 value, bytes data)",
]);

const gc = () => client(chains.gnosis, NET);
const readG = (address, functionName, args) => gc().readContract({ address, abi: homeAbi, functionName, args });
const readE = (address, functionName, args) => l1().readContract({ address, abi: foreignAbi, functionName, args });
const requiredSigs = memo(() => readG(G.amb, "requiredSignatures"), 60 * MIN);
const validatorSet = memo((foreign) => readE(foreign, "validatorContract").then((v) => readE(v, "validatorList")).then((xs) => new Set(xs.map(getAddress))), 60 * MIN);

// AMB message: messageId(32) sender(20) executor(20) gasLimit(4) srcLen(1) dstLen(1) dataType(1) srcId dstId data.
async function ambItem(l) {
  const m = l.args.encodedData;
  if (size(m) < 79 || getAddress(slice(m, 32, 52)) !== G.omni) return null; // other AMB users carry no tokens
  const call = slice(m, 79 + Number(BigInt(slice(m, 76, 77))) + Number(BigInt(slice(m, 77, 78))));
  const it = { kind: "amb", tx: l.transactionHash, block: l.blockNumber, messageId: l.args.messageId, payload: m };
  try {
    const { functionName: fn, args } = decodeFunctionData({ abi: mediatorAbi, data: call });
    const deploy = fn.startsWith("deploy");
    const [token, receiver, value, data] = deploy ? [args[0], args[4], args[5], args[6]] : args;
    Object.assign(it, { owner: receiver, amount: value });
    if (fn.startsWith("handleNative")) it.asset = erc20("eth-mainnet", token); // Ethereum-native token, burned on Gnosis
    else {
      // Gnosis-native token locked in the mediator: priced as its Ethereum copy when that exists.
      const l1Token = deploy ? zeroAddress : await readE(E.omni, "bridgedTokenAddress", [token]).catch(() => zeroAddress);
      it.asset = l1Token === zeroAddress ? erc20(NET, token) : erc20("eth-mainnet", l1Token);
    }
    if (getAddress(receiver) === E.wethRouter && data && size(data) >= 20) Object.assign(it, { owner: getAddress(slice(data, 0, 20)), asset: ETH });
  } catch {
    return null; // not a token transfer (e.g. fixFailedMessage)
  }
  return it;
}

function xdaiItem(l) {
  const { recipient, value, nonce, token } = l.args;
  return {
    kind: "xdai", tx: l.transactionHash, block: l.blockNumber, owner: recipient, amount: value,
    nonce: nonce ?? l.transactionHash, token: token ?? null, asset: erc20("eth-mainnet", token ?? DAI),
  };
}

// Envio indexer behind bridge.gnosischain.com (its allowlist only accepts the app's own query text).
const INDEXER = "https://bridge.gnosischain.com/api/graphql";
const INDEXER_QUERY = `query EnvioTransactions($where: Transaction_bool_exp, $order_by: [Transaction_order_by!], $limit: Int, $offset: Int) {     Transaction(where: $where, order_by: $order_by, limit: $limit, offset: $offset) {       id       messageId       bridgeType       transactionHash       timestamp       initiatorNetwork       initiator       initiatorToken       initiatorAmount       receiverNetwork       receiver       receiverToken       receiverAmount       transactionStatus       execution {         id         transactionHash         timestamp         executorAddress       }       validations {         id         transactionHash         timestamp         validatorAddress       }     }   } `;
async function indexerTxs(user) {
  const u = user.toLowerCase(), out = [];
  // Unfinished Gnosis -> Ethereum transfers only: finished ones are not stuck and can be many.
  const where = { _or: [{ receiver: { _eq: u } }, { initiator: { _eq: u } }], receiverNetwork: { _eq: 1 }, transactionStatus: { _neq: "COMPLETED" } };
  for (let offset = 0; offset < 5000; offset += 500) {
    const body = JSON.stringify({ operationName: "EnvioTransactions", query: INDEXER_QUERY, variables: { where, limit: 500, offset, order_by: [{ timestamp: "asc" }] } });
    const r = await fetch(INDEXER, { method: "POST", headers: { "content-type": "application/json" }, body, signal: AbortSignal.timeout(20_000) }).then((x) => x.json()).catch(() => null);
    const rows = r?.data?.Transaction ?? [];
    out.push(...rows.map((t) => t.transactionHash).filter(Boolean));
    if (rows.length < 500) break;
  }
  return out;
}

async function find(user, range) {
  const c = gc();
  if (user) {
    // Gnosis caps eth_getLogs at 10k blocks: find the user's bridge txs with the Transfers API instead.
    // Tokens always move user -> mediator first (relayTokens or transferAndCall); xDAI is sent to the bridge.
    // Alchemy has no internal transfers on Gnosis: Safes and other contracts come from Blockscout (best effort).
    // Withdrawals someone else sent to this user (aggregators, routers, relayers) only show up in the
    // official bridge indexer, which starts in April 2025.
    const [omni, xdai, internal, indexed] = await Promise.all([
      transferTxs(c, user, G.omni, ["erc20"]), transferTxs(c, user, G.xdai, ["external"]),
      fetchJson(`https://gnosis.blockscout.com/api?module=account&action=txlistinternal&address=${user}&offset=10000&page=1`, 1), indexerTxs(user),
    ]);
    const omniTxs = omni.map((t) => t.hash), xdaiTxs = xdai.map((t) => t.hash);
    for (const t of Array.isArray(internal?.result) ? internal.result : []) {
      if (t.from?.toLowerCase() === user.toLowerCase() && t.to?.toLowerCase() === G.xdai.toLowerCase() && t.value !== "0" && t.isError === "0") xdaiTxs.push(t.transactionHash);
    }
    const own = new Set([...omniTxs, ...xdaiTxs]);
    const logs = await logsFromTxs(c, [...own, ...indexed], [
      { address: G.omni, event: evOmniInit }, { address: G.amb, event: evAmbRequest }, ...evXdai.map((event) => ({ address: G.xdai, event })),
    ]);
    const mine = new Set(logs.filter((l) => l.eventName === "TokensBridgingInitiated" && getAddress(l.args.sender) === user).map((l) => l.args.messageId));
    const ambLogs = logs.filter((l) => l.address.toLowerCase() === G.amb.toLowerCase());
    const xdaiLogs = logs.filter((l) => l.address.toLowerCase() === G.xdai.toLowerCase() && (own.has(l.transactionHash) || getAddress(l.args.recipient) === user));
    const seen = new Set();
    const uniq = (l) => { const k = `${l.transactionHash}:${l.logIndex}`; return !seen.has(k) && seen.add(k); };
    const items = [...(await pool(ambLogs.filter(uniq), 6, ambItem)), ...xdaiLogs.filter(uniq).map(xdaiItem)];
    return items.filter((i) => i && i.amount > 0n && (i.kind === "xdai" || mine.has(i.messageId) || getAddress(i.owner) === user));
  }
  const [from, to] = range;
  const ambLogs = await getLogsAll(c, { address: G.amb, event: evAmbRequest }, from, to);
  const xdaiLogs = await getLogsAll(c, { address: G.xdai, events: evXdai }, from, to);
  const items = [...(await pool(ambLogs, 6, ambItem)), ...xdaiLogs.map(xdaiItem)];
  return items.filter((i) => i && i.amount > 0n);
}

async function status(it) {
  it.time ??= await blockTime(gc(), NET, it.block);
  const home = it.kind === "amb" ? G.amb : G.xdai, foreign = it.kind === "amb" ? E.amb : E.xdai;
  it.action = `bridge.gnosischain.com > Claim, or executeSignatures(message, signatures) on ${it.kind === "amb" ? "the AMB" : "the xDai bridge"} ${foreign} on Ethereum`;
  let msg;
  if (it.kind === "amb") {
    msg = it.payload;
    it.detail = `AMB message ${it.messageId}`;
    if (await readE(E.amb, "relayedMessages", [it.messageId])) {
      if (await readE(E.amb, "messageCallStatus", [it.messageId])) return done(it, "claimed");
      // Relayed but the token release reverted on Ethereum: the mediator can refund it on Gnosis.
      if (await readG(G.omni, "messageFixed", [it.messageId])) return done(it, "claimed", "release failed on Ethereum, refunded on Gnosis");
      it.action = `requestFailedMessageFix(${it.messageId}) on the Omnibridge mediator ${E.omni} on Ethereum refunds it on Gnosis`;
      return done(it, "claimable", "release failed on Ethereum, refundable on Gnosis");
    }
  } else {
    it.detail = `xDai nonce ${it.nonce.length === 66 && BigInt(it.nonce) < 2n ** 64n ? BigInt(it.nonce) : it.nonce}`;
    if (await readE(E.xdai, "relayedMessages", [pad(it.nonce, { size: 32 })])) return done(it, "claimed");
    // The signed message is recipient|value|nonce|foreign bridge, with the L1 token appended since the token event.
    const base = encodePacked(["address", "uint256", "bytes32", "address"], [it.owner, it.amount, pad(it.nonce, { size: 32 }), E.xdai]);
    const cands = it.token ? [concat([base, it.token]), base] : [base];
    const counts = await Promise.all(cands.map((m) => readG(G.xdai, "numMessagesSigned", [keccak256(m)])));
    msg = cands[Math.max(0, counts.findIndex((n) => n > 0n))];
    if (!(await readE(E.xdai, "withinExecutionLimit", [it.amount]))) return done(it, "waiting", `${it.detail}; above the Ethereum daily limit, claim another day`);
  }
  const hash = keccak256(msg);
  const n = await readG(home, "numMessagesSigned", [hash]);
  const count = Number(n & (2n ** 255n - 1n));
  if (n >> 255n === 0n) {
    // Not enough validator signatures yet: only the Gnosis validators can move it forward.
    const st = now() - it.time < SIGN_GRACE ? "waiting" : "blocked";
    return done(it, st, `${it.detail}; ${count}/${await requiredSigs()} validator signatures`);
  }
  // Signatures packed as count | v[] | r[] | s[], then simulate the claim on Ethereum.
  const sigs = await pool([...Array(count).keys()], 4, (i) => readG(home, "signature", [hash, BigInt(i)]));
  const packed = concat([toHex(count, { size: 1 }), ...sigs.map((s) => slice(s, 64, 65)), ...sigs.map((s) => slice(s, 0, 32)), ...sigs.map((s) => slice(s, 32, 64))]);
  it.payload = { message: msg, signatures: packed };
  try {
    await l1().call({ to: foreign, account: it.owner, data: encodeFunctionData({ abi: foreignAbi, functionName: "executeSignatures", args: [msg, packed] }) });
    return done(it, "claimable");
  } catch (e) {
    // Usually signed by a validator set that has since rotated out on Ethereum: only the bridge team can fix it.
    const vs = await validatorSet(foreign);
    const live = (await Promise.all(sigs.map((s) => recoverMessageAddress({ message: { raw: msg }, signature: s })))).filter((a) => vs.has(a)).length;
    const why = live < count ? `signed by an old validator set, ${live}/${count} signers still validators` : `claim reverts: ${revertText(e).match(/reason:\s*([^\n]+)/)?.[1] ?? "unknown"}`;
    return done(it, "blocked", `${it.detail}; ${why}`);
  }
}

function done(it, st, detail) {
  it.status = st;
  if (detail) it.detail = detail;
  delete it.token;
  if (st !== "claimable") delete it.payload;
  return it;
}

export default { key: "gnosis", name: "Gnosis Chain", scan: true, scanChain: { chain: chains.gnosis, net: NET }, find, status };
