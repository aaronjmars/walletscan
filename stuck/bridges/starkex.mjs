// StarkEx apps: pending withdrawal balances (LogWithdrawalAllowed credited, withdraw() never called).
// StarkEx events have no indexed fields, so Stark keys come from the user's own txs (registration,
// deposits, withdrawals), the L2BEAT dYdX explorer index, and the address itself (v4.5 eth-key vaults).
import { parseAbi, parseAbiItem, getAddress, encodeFunctionData, zeroAddress, slice } from "viem";
import { MIN, l1, getLogsAll, logsFromTxs, blockTime, pool, memo, warn, revertText, ETH, erc20, needsKeyOf } from "../lib.mjs";

const APPS = [
  { name: "dYdX v3", address: "0xD54f502e184B6B739d7D27a6410a67dc462D69c8", ui: "explorer.dydx.exchange (L2BEAT StarkEx Explorer) > your user page > Withdraw", explorer: "https://explorer.dydx.exchange" },
  { name: "Immutable X", address: "0x5FDCCA53617f4d2b9134B29090C87D01058e27e9", relayers: ["0x72a06bf2a1CE5e39cBA06c0CAb824960B587d64c"] }, // users register + withdraw through the Registration contract
  { name: "Sorare", address: "0xF5C9F957705bea56a7e806943f98F7777B995826" },
  { name: "rhino.fi", address: "0x5d22045DAcEAB03B158031eCB7D9d06Fad24609b" },
  { name: "edgeX", address: "0xfAaE2946e846133af314d1Df13684c89fA7d83DD" },
  { name: "ApeX USDC", address: "0xA1D5443F2FB80A5A55ac804C948B45ce4C52DCbb" },
  { name: "ApeX USDT", address: "0xe53A6eD882Eb3f90cCe0390DDB04c876C5482E6b" },
  { name: "Myria", address: "0x3071BE11F9e92a9eb28F305e1Fa033cd102714e7" },
  { name: "tanX", address: "0x1390f521A79BaBE99b69B37154D63D431da27A07" },
  { name: "Reddio", address: "0xB62BcD40A24985f560b5a9745d478791d8F1945C" },
  { name: "L2.Finance", address: "0x82123571C8a5e0910280C066bc634c4945FFcbC8" },
  // Unlabeled StarkWare-deployed instances with real withdrawals (perpetual USDC, perpetual USDT, spot).
  { name: "StarkEx 1ce5", address: "0x1cE5D7f52A8aBd23551e91248151CA5A13353C65" },
  { name: "StarkEx 5847", address: "0x584725Bb23E76DA3567c0C80EaDAE892cF910A1b" },
  { name: "StarkEx c3b2", address: "0xC3b2eC1D107DF4E3cCD761CbDc20182Db300ddC0" },
].map((a) => ({ ...a, address: getAddress(a.address.toLowerCase()) }));

const evTokenRegistered = [parseAbiItem("event LogTokenRegistered(uint256 assetType, bytes assetInfo, uint256 quantum)"), parseAbiItem("event LogTokenRegistered(uint256 assetType, bytes assetInfo)")];
const evUser = [
  parseAbiItem("event LogUserRegistered(address ethKey, uint256 starkKey, address sender)"),
  parseAbiItem("event LogDeposit(address depositorEthKey, uint256 starkKey, uint256 vaultId, uint256 assetType, uint256 nonQuantizedAmount, uint256 quantizedAmount)"),
  parseAbiItem("event LogWithdrawalPerformed(uint256 ownerKey, uint256 assetType, uint256 nonQuantizedAmount, uint256 quantizedAmount, address recipient)"),
];
const appAbi = parseAbi([
  "function getWithdrawalBalance(uint256 ownerKey, uint256 assetId) view returns (uint256)",
  "function getEthKey(uint256 ownerKey) view returns (address)",
  "function isFrozen() view returns (bool)",
  "function withdraw(uint256 ownerKey, uint256 assetType)",
]);
const SEL = { ETH: "0x8322fff2", ERC20: "0xf47261b0" }; // bytes4(keccak("ETH()")), bytes4(keccak("ERC20Token(address)"))
const hex = (n) => `0x${n.toString(16)}`;

// Fungible asset types each app ever registered (ETH + ERC20), fetched once per run (hourly in a server).
const assets = memo(async (app) => {
  const c = l1();
  const to = await c.getBlockNumber();
  const logs = (await Promise.all(evTokenRegistered.map((event) => getLogsAll(c, { address: app.address, event }, 0n, to)))).flat();
  return logs.flatMap(({ args: { assetType, assetInfo } }) => {
    const sel = slice(assetInfo, 0, 4);
    if (sel === SEL.ETH) return [{ assetType, asset: ETH }];
    if (sel === SEL.ERC20 && assetInfo.length >= 74) return [{ assetType, asset: erc20("eth-mainnet", `0x${assetInfo.slice(-40)}`) }];
    return []; // NFTs and mintable assets: balances keyed by per-token asset ids, not covered
  });
}, 60 * MIN, (app) => app.address);

// All txs between the user and a contract, zero-value calls included (registerUser, withdraw).
async function txsBetween(c, params) {
  const out = [];
  let pageKey;
  do {
    const r = await c.request({ method: "alchemy_getAssetTransfers", params: [{ fromBlock: "0x0", toBlock: "latest", excludeZeroValue: false, withMetadata: true, maxCount: "0x3e8", ...params, ...(pageKey ? { pageKey } : {}) }] });
    out.push(...r.transfers);
    pageKey = r.pageKey;
  } while (pageKey);
  return out;
}

// Most dYdX users were registered by a relayer, so their own txs miss the link. The L2BEAT explorer
// indexes every registration (search redirects to /users/<starkKey>) but throttles after a short burst;
// then fall back to fetching all ~110k dYdX LogUserRegistered logs once (~15s) and reuse them.
// dYdX v3 is shut down, so the index never goes stale; a server builds it up front in warm().
let dydxIndex, dydxFail;
const dydxAll = (app) => (dydxIndex ??= (async () => {
  const c = l1();
  const logs = await getLogsAll(c, { address: app.address, event: evUser[0] }, 0n, await c.getBlockNumber());
  const idx = new Map();
  for (const { args: a } of logs) idx.set(getAddress(a.ethKey), [...(idx.get(getAddress(a.ethKey)) ?? []), a.starkKey]);
  return idx;
})().catch((e) => {
  // Empty for this caller only: drop it so the next one retries instead of reusing the failure.
  warn(`StarkEx apps: dYdX registration index failed (${e.shortMessage ?? e.message}), relayer-registered dYdX keys missed`, e);
  dydxIndex = null;
  dydxFail = e;
  return new Map();
}));
async function dydxKeys(app, user) {
  if (!dydxIndex) {
    for (let i = 0; i < 3; i++) {
      const r = await fetch(`${app.explorer}/search?query=${user}`, { redirect: "manual", signal: AbortSignal.timeout(10_000) }).catch(() => null);
      if (r?.status === 429) { await new Promise((ok) => setTimeout(ok, Math.min(3, Number(r.headers.get("retry-after")) || 2) * 1000)); continue; }
      if (!r || r.status >= 500) break;
      const m = r.headers.get("location")?.match(/\/users\/(0x[0-9a-fA-F]{50,64})$/);
      return m ? [BigInt(m[1])] : [];
    }
  }
  return (await dydxAll(app)).get(user) ?? [];
}

const isFrozen = memo((app) => l1().readContract({ address: app.address, abi: appAbi, functionName: "isFrozen" }).catch(() => false), 60 * MIN, (app) => app.address);

export default {
  key: "starkex", name: "StarkEx apps", scan: false,
  // no key: the index is too big for a keyless explorer, so warm throws the needs-key error (listed as skipped)
  warm: async () => { if ((await dydxAll(APPS[0])).size === 0) throw needsKeyOf(dydxFail) || new Error("dYdX registration index failed"); },
  async find(user) {
    const c = l1();
    const byAddr = new Map(APPS.map((a) => [a.address.toLowerCase(), a]));
    const queries = APPS.flatMap((a) => [
      { fromAddress: user, toAddress: a.address, category: ["external", "erc20"] },
      { fromAddress: a.address, toAddress: user, category: ["external", "internal", "erc20"] },
      ...(a.relayers ?? []).map((r) => ({ fromAddress: user, toAddress: r, category: ["external"] })),
    ]);
    const [transfers, dydx] = await Promise.all([pool(queries, 8, (q) => txsBetween(c, q)).then((x) => x.flat()), dydxKeys(APPS[0], user)]);
    const logs = (await logsFromTxs(c, transfers.map((t) => t.hash), evUser.map((event) => ({ event })))).filter((l) => byAddr.has(l.address.toLowerCase()));

    // Stark keys tied to this address, with the tx that best shows the link.
    const keys = new Map([[BigInt(user), null]]);
    for (const k of dydx) keys.set(k, null);
    const items = [];
    for (const l of logs) {
      const a = l.args;
      const key = l.eventName === "LogUserRegistered" ? (getAddress(a.ethKey) === user ? a.starkKey : null)
        : l.eventName === "LogDeposit" ? (getAddress(a.depositorEthKey) === user ? a.starkKey : null)
        : getAddress(a.recipient) === user ? a.ownerKey : null;
      if (key == null) continue;
      // Prefer the registration tx as the link, then a deposit, then a past withdrawal.
      const rank = ["LogUserRegistered", "LogDeposit", "LogWithdrawalPerformed"].indexOf(l.eventName);
      if (!keys.get(key) || rank < keys.get(key).rank) keys.set(key, { tx: l.transactionHash, rank, event: l.eventName });
      if (l.eventName === "LogWithdrawalPerformed" && a.nonQuantizedAmount > 0n) {
        const app = byAddr.get(l.address.toLowerCase());
        const known = (await assets(app)).find((x) => x.assetType === a.assetType);
        if (known) items.push({ bridge: app.name, tx: l.transactionHash, block: l.blockNumber, owner: user, asset: known.asset, amount: a.nonQuantizedAmount, starkKey: a.ownerKey, assetType: a.assetType, app: app.address, status: "claimed" });
      }
    }

    // Every key against every app's fungible assets: Stark keys are often reused across apps.
    await pool(APPS, 4, async (app) => {
      const list = await assets(app);
      const calls = [...keys.keys()].flatMap((k) => list.map((x) => ({ k, x })));
      if (!calls.length) return;
      const res = await c.multicall({ contracts: calls.map(({ k, x }) => ({ address: app.address, abi: appAbi, functionName: "getWithdrawalBalance", args: [k, x.assetType] })), batchSize: 4096 });
      res.forEach((r, i) => {
        if (r.status !== "success" || r.result === 0n) return;
        const { k, x } = calls[i];
        const seen = keys.get(k);
        // The crediting LogWithdrawalAllowed is not filterable by key, so tx is the key's link tx and age is unknown.
        items.push({ bridge: app.name, tx: seen?.tx ?? "-", link: seen?.event ?? (k === BigInt(user) ? "eth-key vault" : "dYdX registration index"), owner: user, asset: x.asset, amount: r.result, starkKey: k, assetType: x.assetType, app: app.address, pending: true });
      });
    });
    return items;
  },
  async status(it) {
    const c = l1();
    const app = APPS.find((a) => a.address === it.app);
    if (it.block) it.time = await blockTime(c, "eth-mainnet", it.block);
    it.detail = `stark key ${hex(it.starkKey)}, asset type ${hex(it.assetType)}`;
    if (!it.pending) return it;
    it.detail += `; key linked via ${it.link}`;
    delete it.pending; delete it.link;
    const read = (functionName, args) => c.readContract({ address: app.address, abi: appAbi, functionName, args });
    const ethKey = await read("getEthKey", [it.starkKey]).catch(() => zeroAddress);
    const manual = `withdraw(${hex(it.starkKey)}, ${hex(it.assetType)}) on ${app.address} via Etherscan Write as Proxy`;
    it.action = app.ui ? `${app.ui}, or ${manual}` : `${app.name} app Withdraw if it still exists, else ${manual}`;
    if (ethKey === zeroAddress) {
      // withdraw() pays the registered eth key; with none, the Stark key must sign registerEthAddress first.
      it.status = "blocked";
      it.detail += "; Stark key has no registered Ethereum address: registerEthAddress needs a Stark key signature first";
      return it;
    }
    it.owner = ethKey;
    try {
      await c.call({ account: ethKey, to: app.address, data: encodeFunctionData({ abi: appAbi, functionName: "withdraw", args: [it.starkKey, it.assetType] }) });
      it.status = "claimable";
    } catch (e) {
      it.status = "blocked";
      it.detail += `; withdraw reverts: ${revertText(e).match(/reverted with reason string '([^']+)'|reason:\s*([^\n]+)/)?.slice(1).find(Boolean) ?? "unknown reason"}`;
    }
    if (await isFrozen(app)) it.detail += "; app frozen (any L2 balance needs the escape hatch)";
    return it;
  },
};
