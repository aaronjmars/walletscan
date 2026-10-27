// Starknet (StarkGate): Starknet -> Ethereum withdrawals whose L1 message was never consumed.
// The L1 recipient only appears inside the (unindexed) LogMessageToL1 payload, so every message to a
// StarkGate bridge is indexed once on disk (cachePath), synced incrementally, and only unconsumed ones are kept.
// Completed withdrawals come straight from the bridges' indexed LogWithdrawal / Withdrawal events.
import { parseAbi, encodeFunctionData, keccak256, pad, getAddress, toHex } from "viem";
import * as chains from "viem/chains";
import { readFileSync } from "node:fs";
import { MIN, l1, pool, blockTime, memo, cachePath, saveJson, revertText, ETH, erc20 } from "../lib.mjs";
import { logsCapped, needKey, ALCHEMY_PAID } from "../../keyless.mjs";

const CORE = "0xc662c410C0ECf747543f5bA90660f6ABeBD9C8c4";
const START = 13627224n; // first LogMessageToL1 (2021-11)
const SENT = "0x4264ac208b5fde633ccdd42e0f12c3d6d443a4f3779bbf886925b94665b63a22"; // LogMessageToL1(uint256 indexed fromAddress, address indexed toAddress, uint256[] payload)
const CONSUMED = "0x7a06c571aa77f34d9706c51e5d8122b5595aebeaa34233bfe866f22befb973b1"; // ConsumedMessageToL1(same fields)
const LOG_WITHDRAWAL = "0xb4214c8c54fc7442f36d3682f59aebaf09358a4431835b30efb29d52cf9e1e91"; // LogWithdrawal(address indexed recipient, uint256 amount), legacy
const WITHDRAWAL = "0x2717ead6b9200dd235aad468c9809ea400fe33ac69b5bfaa6d3e90fc922b6398"; // Withdrawal(address indexed recipient, address indexed token, uint256 amount), 2.0
const ETH_TOKEN = "0x0000000000000000000000000000000000455448"; // StarkGate 2.0 stands in "ETH" for ether
const MULTI = "0xF5b6Ee2CAEb6769659f6C091D209DfdCaF3F69Eb"; // StarkGate 2.0 multi-token bridge: token is always in the payload
const MAKER_DAI = "0x659a00c33263d9254Fed382dE81349426C795BB6"; // MakerDAO L1DAIBridge, closed
const DUMMY = "0x000000000000000000000000000000000000dEaD";
const CACHE = "starknet-pending.json";

// L1 bridge -> L1 token, from starknet-io/starknet-addresses bridged_tokens/mainnet.json plus the two
// pre-StarkGate bridges the StarkGate app also served (Maker DAI, LORDS). Legacy-format messages
// ([0|1, recipient, low, high]) carry no token, so the bridge decides it; 2.0 ones add it after the recipient.
const BRIDGES = {
  "0xae0Ee0A63A2cE6BaeEFFE56e7714FB4EFE48D419": ETH_TOKEN, // ETH
  [MULTI]: null,
  "0xcE5485Cfb26914C5dcE00B9BAF0580364daFC7a4": "0xCa14007Eff0dB1f8135f4C25B34De49AB0d42766", // STRK
  "0x283751A21eafBFcD52297820D27C1f1963D9b5b4": "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
  "0xF6080D9fbEEbcd44D89aFfBFd42F098cbFf92816": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
  "0xbb3400F107804DFB482565FF1Ec8D8aE66747605": "0xdAC17F958D2ee523a2206206994597C13D831ec7", // USDT
  "0xCA14057f85F2662257fd2637FdEc558626bCe554": "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI
  "0x9F96fE0633eE838D0298E8b8980E6716bE81388d": "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI (v0)
  [MAKER_DAI]: "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI (Maker)
  "0x023A2aAc5d0fa69E3243994672822BA43E34E5C9": "0x686f2404e77Ab0d9070a46cdfb0B7feCDD2318b0", // LORDS
  "0xBf67F59D2988A46FBFF7ed79A621778a3Cd3985B": "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", // wstETH
  "0xcf58536D6Fab5E59B654228a5a4ed89b13A876C2": "0xae78736Cd615f374D3085123A210448E74Fc6393", // rETH
  "0xb27d0dCAFd63db302C155c8864886f33BD2a41E5": "0x183015a9bA6fF60230fdEaDc3F43b3D788b13e21", // R
  "0xDc687e1E0B85CB589b2da3C47c933De9Db3d1ebb": "0x853d955aCEf822Db058eb8505911ED77F175b99e", // FRAX
  "0x66ba83ba3D3AD296424a2258145d9910E9E40B7C": "0x3432B6A60D23Ca0dFCa7761B7ab56459D9C964D0", // FXS
  "0xd8E8531fdD446DF5298819d3Bc9189a5D8948Ee8": "0xac3E018457B222d93114458476f3E3416Abbe38F", // sfrxETH
  "0xF3F62F23dF9C1D2C7C63D9ea6B90E8d24c7E3DF5": "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0", // LUSD
  "0xf76e6bF9e2df09D0f854F045A3B724074dA1236B": "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", // UNI
  "0x2111A49ebb717959059693a3698872a0aE9866b9": "0x18084fbA666a33d37592fA2633fD49a74DD93a88", // tBTC
  "0x3cDe3eE221aD64d096C92e0F750Feb8A750519A8": "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", // AAVE
  "0xEa90D8aE0Fe18a8aF72E57EFDDfE819aa96f244E": "0x57e114B691Db790C35207b2e685D4A43181e6061", // ENA
  "0x9FaDA9F29492Af64A852f35EAfd957b790B7ea7E": "0x514910771AF9Ca656af840dff83E8264EcF986CA", // LINK
  "0x9aAA37e5bf214E6446Bb7f1690876410C996860e": "0xF469fBD2abcd6B9de8E169d128226C0Fc90a012e", // pumpBTC
  "0x30A155a161f6b5f4C0226C3744C4d69eEfDbf483": "0x6A9A65B84843F5fD4aC9a0471C4fc11AFfFBce4a", // enzoBTC
  "0xA86b9b9c58d4f786F8ea89356c9c9Dde9432Ab10": "0x7A56E1C57C7475CCf742a1832B028F0456652F97", // SolvBTC
  "0x6F3229B9056bC42F147f309B10877cC5919EeFd5": "0x66a1E37c9b0eAddca17d3662D6c05F4DECf3e110", // USR
  "0x52c65B6795216c4D76fAcACdE8B5f4BAd2c9b9d7": "0x6985884C4392D348587B19cb9eAAf157F13271cd", // ZRO
  "0x4ea91eD5A1f5e2Be18791F210C52d0fe285744d5": "0x004E9C3EF86bc1ca1f0bB5C7662861Ee93350568", // uniBTC
  "0x1febb800fa36938Fdb6131c643C72dfAB91633bb": "0x2eC37d45FCAE65D9787ECf71dc85a444968f6646", // brBTC
  "0x96C8AE2AC9A5cd5fC354e375dB4d0ca75fc0685e": "0x8236a87084f8B84306f72007F36F2618A5634494", // LBTC
  "0x7a095101eF5c7a66056f801335F8605d3b2452a5": "0x9FB442d6B612a6dcD2acC67bb53771eF1D9F661A", // mRe7BTC
  "0x448Acb9F2e57a409a60Cf8901EA4123b6E2EC253": "0x76aAb5FD2243d99EAc92d4d9EBF23525d3ACe4Ec", // GGMT
  "0x00b0466f8dC04B0782DbF1A1DfdCe333F0Dd082B": "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c", // EURC
  "0x4c4eE256fFE216a23A39827bcd4C5CB0b6cf11F3": "0x888883b5F5D21fb10Dfeb70e8f9722B9FB0E5E51", // EUROP
};
const LIST = Object.keys(BRIDGES);
const INDEX = new Map(LIST.map((a, i) => [pad(a.toLowerCase()), i]));

const coreAbi = parseAbi(["function l2ToL1Messages(bytes32) view returns (uint256)"]);
const bridgeAbi = parseAbi(["function withdraw(uint256 amount, address recipient)", "function withdraw(address token, uint256 amount, address recipient)"]);

const asset = (token) => (token.toLowerCase() === ETH_TOKEN ? ETH : erc20("eth-mainnet", token));

// Raw eth_getLogs (topic ORs, no ABI decoding for ~1M logs), halving the range when Alchemy refuses it.
async function logs(c, filter, from, to) {
  try {
    return await c.request({ method: "eth_getLogs", params: [{ ...filter, fromBlock: toHex(from), toBlock: toHex(to) }] });
  } catch (e) {
    if (to <= from || !/exceed|range|limit|too many|10,?000/i.test(`${e.details ?? ""} ${e.message ?? ""}`)) throw e;
    const mid = (from + to) / 2n;
    return [...(await logs(c, filter, from, mid)), ...(await logs(c, filter, mid + 1n, to))];
  }
}

// One log -> [sent, hash, row] where row = [hash, block, tx, bridgeIndex, recipient, token|"" (legacy), amountHex].
// Message hash = keccak(fromAddress, toAddress, payload.length, payload...), i.e. both topics plus the data after its offset word.
function parse(l) {
  const hash = keccak256(`0x${l.topics[1].slice(2)}${l.topics[2].slice(2)}${l.data.slice(66)}`).slice(2);
  if (l.topics[0] === CONSUMED) return [false, hash];
  const w = l.data.slice(130).match(/.{64}/g) ?? [];
  if ((w.length !== 4 && w.length !== 5) || !/^0{24}/.test(w[1])) return [true, hash, null];
  const token = w.length === 5 ? w[2].slice(24) : "";
  const amount = (BigInt(`0x${w.at(-2)}`) + (BigInt(`0x${w.at(-1)}`) << 128n)).toString(16);
  return [true, hash, [hash, parseInt(l.blockNumber, 16), l.transactionHash.slice(2), INDEX.get(l.topics[2]), w[1].slice(24), token, amount]];
}

// Synced at most every few minutes; concurrent callers share one sync.
const sync = memo(async () => {
  const c = l1();
  const key = LIST.join(",").toLowerCase();
  let cache = { bridges: key, block: Number(START - 1n), rows: [] };
  try { const x = JSON.parse(readFileSync(cachePath(CACHE), "utf8")); if (x.bridges === key) cache = x; } catch {} // new bridge list = rebuild
  const head = (await c.getBlockNumber()) - 12n; // a few minutes behind the tip, so reorged state updates never reach the cache
  const from = BigInt(cache.block) + 1n;
  if (from > head) return cache.rows;
  const first = !cache.rows.length;
  // built from 200k-block log windows: an Alchemy Free plan key (10 blocks) cannot build it
  if (first && logsCapped()) throw needKey("message index (full-history logs)", ALCHEMY_PAID);
  if (first) console.error("starknet: first run, indexing every StarkGate L2 -> L1 message since 2021 (about a minute, cached after)...");
  const parts = [];
  for (let a = from; a <= head; a += 200_000n) parts.push([a, a + 199_999n > head ? head : a + 199_999n]);
  const filter = { address: CORE, topics: [[SENT, CONSUMED], null, [...INDEX.keys()]] };
  const got = await pool(parts, 8, async ([a, z]) => (await logs(c, filter, a, z)).map(parse));
  // Replay sends and consumptions in chain order; identical messages share a counter, so consume the oldest copy.
  const open = new Map();
  for (const r of cache.rows) open.has(r[0]) ? open.get(r[0]).push(r) : open.set(r[0], [r]);
  for (const [sent, hash, row] of got.flat()) {
    if (sent) { if (row) open.has(hash) ? open.get(hash).push(row) : open.set(hash, [row]); }
    else if (open.get(hash)?.shift() && !open.get(hash).length) open.delete(hash);
  }
  cache = { bridges: key, block: Number(head), rows: [...open.values()].flat().sort((x, y) => x[1] - y[1]) };
  saveJson(cachePath(CACHE), cache);
  if (first) console.error(`starknet: indexed, ${cache.rows.length} unconsumed messages`);
  return cache.rows;
}, 5 * MIN);

const starknet = {
  key: "starknet", name: "Starknet (StarkGate)", scan: true, scanChain: { chain: chains.mainnet, net: "eth-mainnet" },
  warm: () => sync(),
  async find(user, range) {
    const rows = await sync();
    const me = user?.slice(2).toLowerCase();
    const mine = user ? rows.filter((r) => r[4] === me) : rows.filter((r) => r[1] >= Number(range[0]) && r[1] <= Number(range[1]));
    const dupes = new Map();
    for (const r of rows) dupes.set(r[0], (dupes.get(r[0]) ?? 0) + 1);
    const seen = new Map();
    const items = mine.map(([hash, block, tx, bi, rcpt, token, amount]) => {
      const nth = seen.get(hash) ?? 0;
      seen.set(hash, nth + 1);
      const l1Token = token ? getAddress(`0x${token}`) : BRIDGES[LIST[bi]];
      return { tx: `0x${tx}`, block: BigInt(block), owner: getAddress(`0x${rcpt}`), asset: asset(l1Token), amount: BigInt(`0x${amount}`), hash: `0x${hash}`, l1Bridge: LIST[bi], l1Token, legacy: !token, nth, dupes: dupes.get(hash) };
    });
    if (!user) return items;
    // Completed withdrawals: every bridge emits one indexed by recipient when the message is consumed.
    const c = l1();
    const done = await logs(c, { address: LIST, topics: [[LOG_WITHDRAWAL, WITHDRAWAL], pad(user.toLowerCase())] }, START, await c.getBlockNumber());
    for (const l of done) {
      const bridge = LIST.find((a) => a.toLowerCase() === l.address.toLowerCase());
      const l1Token = l.topics[0] === WITHDRAWAL ? getAddress(`0x${l.topics[2].slice(26)}`) : BRIDGES[bridge];
      if (!l1Token) continue;
      items.push({ tx: l.transactionHash, block: BigInt(l.blockNumber), owner: user, asset: asset(l1Token), amount: BigInt(l.data.slice(0, 66)), l1Bridge: bridge, l1Token, claimed: true });
    }
    return items;
  },
  async status(it) {
    const c = l1();
    it.time = await blockTime(c, "eth-mainnet", it.block);
    const call = it.legacy ? `withdraw(${it.amount}, ${it.owner})` : `withdraw(${it.l1Token}, ${it.amount}, ${it.owner})`;
    it.action = `starkgate.starknet.io > Complete on L1, or ${call} on L1 bridge ${it.l1Bridge} (anyone can send it, funds go to the recipient)`;
    if (it.claimed) { it.status = "claimed"; it.detail = `withdrawn on L1 via ${it.l1Bridge}`; return it; }
    const n = await c.readContract({ address: CORE, abi: coreAbi, functionName: "l2ToL1Messages", args: [it.hash] });
    // Identical messages share one counter: the oldest copies count as the consumed ones.
    if (it.nth < it.dupes - Number(n)) { it.status = "claimed"; it.detail = `message ${it.hash} consumed`; return it; }
    it.detail = `message ${it.hash}`;
    const data = it.legacy
      ? encodeFunctionData({ abi: bridgeAbi, functionName: "withdraw", args: [it.amount, it.owner] })
      : encodeFunctionData({ abi: bridgeAbi, functionName: "withdraw", args: [it.l1Token, it.amount, it.owner] });
    // Simulate the L1 withdraw from a stranger. Maker-style DAI bridges put msg.sender in the message,
    // so a valid message that a stranger cannot consume is retried from the recipient.
    const sim = (account) => c.call({ account, to: it.l1Bridge, data }).then(() => null, (e) => e);
    let err = await sim(DUMMY);
    if (err && /INVALID_MESSAGE_TO_CONSUME/.test(revertText(err))) {
      err = await sim(it.owner);
      it.action = it.action.replace(" (anyone can send it, funds go to the recipient)", ", sent from the recipient wallet (this bridge only accepts the recipient as sender)");
    }
    if (!err) it.status = "claimable";
    else {
      const r = revertText(err);
      if (!/revert/i.test(r)) throw err;
      if (/LIMIT/i.test(r)) { it.status = "waiting"; it.detail += "; over the bridge's daily withdrawal limit, retry after it resets"; }
      else {
        // A bare revert on a legacy message = the upgraded bridge dropped withdraw(amount, recipient) (seen on WBTC).
        const reason = (err.details ?? err.shortMessage ?? "").split("\n")[0];
        it.status = "blocked";
        it.detail += it.l1Bridge === MAKER_DAI ? "; legacy Maker DAI bridge is closed"
          : it.legacy && /^execution reverted\.?$/i.test(reason.trim()) ? "; bridge no longer accepts legacy-format withdrawals" : `; withdraw reverts: ${reason}`;
      }
    }
    return it;
  },
};

export default starknet;
