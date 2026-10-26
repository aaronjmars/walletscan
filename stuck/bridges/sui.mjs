// Sui Bridge (native, committee-signed): Sui -> Ethereum transfers that were never claimed on Ethereum.
// Deposits come from Sui GraphQL (public JSON-RPC is gone), cached on disk (cachePath) and synced incrementally;
// approval and committee signatures come from the on-chain Sui bridge record, claimed state from SuiBridge.
import { parseAbi, encodeFunctionData, encodePacked, keccak256, recoverAddress, zeroAddress } from "viem";
import { readFileSync } from "node:fs";
import { DAY, MIN, now, l1, pool, memo, cachePath, saveJson, revertText, ETH, erc20 } from "../lib.mjs";

const GQL = "https://graphql.mainnet.sui.io/graphql";
const EVENT = "0xb::bridge::TokenDepositedEvent";
const RECORDS = "0xec526c0819f5d2183bc14cc444ea8777338eaabc9761eb5e6d21aa664ba86d69"; // BridgeInner.token_transfer_records
const START_CP = 61936165; // checkpoint of the first bridge deposit (seq 0, 2024-09-24)
const SUI = 0, ETHEREUM = 10; // bridge chain ids
const BRIDGE = "0xda3bD1fE1973470312db04551B65f401Bc8a92fD";
const CONFIG = "0x72D34Fe82c71Bf8120647518e5128e53106a1540";
const LIMITER = "0x12183B0796BBc4678999100e8c6C5715D5736767";
const COMMITTEE = "0xee2d52477a7c1A7Be0B0347dBe7e3b15185B416F";
const CACHE = "sui-bridge.json";

const bridgeAbi = parseAbi([
  "function isTransferProcessed(uint64) view returns (bool)",
  "struct Message { uint8 messageType; uint8 version; uint64 nonce; uint8 chainID; bytes payload; }",
  "function transferBridgedTokensWithSignatures(bytes[] signatures, Message message)",
]);
const configAbi = parseAbi(["function tokenAddressOf(uint8) view returns (address)", "function tokenSuiDecimalOf(uint8) view returns (uint8)"]);
const limiterAbi = parseAbi(["function chainLimits(uint8) view returns (uint64)", "function calculateAmountInUSD(uint8, uint256) view returns (uint256)"]);
const erc20Abi = parseAbi(["function decimals() view returns (uint8)"]);
const committeeAbi = parseAbi(["function blocklist(address) view returns (bool)", "function committeeStake(address) view returns (uint16)"]);

// Token ids the config no longer maps still need an Ethereum asset to price the stuck amount.
const LEGACY = { 3: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", eth: 6, sui: 6 } }; // USDC

async function gql(query, tries = 3) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(GQL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(30_000) }).then((x) => x.json());
      if (r.errors?.length) throw new Error(`Sui GraphQL: ${r.errors[0].message}`);
      return r.data;
    } catch (e) {
      if (i + 1 >= tries) throw e;
      await new Promise((ok) => setTimeout(ok, 800 * (i + 1)));
    }
  }
}

const b64hex = (s) => Buffer.from(s, "base64").toString("hex");

// One checkpoint slice [a, z], paged by cursor. Rows: [seq, target, token, amount, digest, checkpoint, time].
async function slice(a, z) {
  const rows = [];
  let after = null;
  for (let page = 0; page < 2000; page++) {
    const d = await gql(`{ events(first: 50${after ? `, after: "${after}"` : ""}, filter: {type: "${EVENT}", afterCheckpoint: ${a - 1}, beforeCheckpoint: ${z + 1}}) {
      pageInfo { hasNextPage endCursor } nodes { contents { json } timestamp transaction { digest effects { checkpoint { sequenceNumber } } } } } }`);
    for (const n of d.events.nodes) {
      const j = n.contents.json;
      if (j.target_chain !== ETHEREUM) continue;
      rows.push([Number(j.seq_num), b64hex(j.target_address), j.token_type, j.amount, n.transaction.digest, n.transaction.effects.checkpoint.sequenceNumber, Math.floor(Date.parse(n.timestamp) / 1000)]);
    }
    if (!d.events.pageInfo.hasNextPage) return rows;
    after = d.events.pageInfo.endCursor;
  }
  throw new Error(`Sui deposits: checkpoints ${a}..${z} exceed the page cap`);
}

// The whole bridge has ~25k deposits: cache them and only fetch checkpoints newer than the cache.
// Synced at most every few minutes; concurrent callers share one sync.
const sync = memo(async () => {
  let cache = { cp: START_CP - 1, rows: [] };
  try { cache = JSON.parse(readFileSync(cachePath(CACHE), "utf8")); } catch {}
  const latest = (await gql("{ checkpoint { sequenceNumber } }")).checkpoint.sequenceNumber;
  const from = cache.cp + 1, n = Math.min(32, Math.max(1, Math.ceil((latest - from + 1) / 2_000_000)));
  const step = Math.ceil((latest - from + 1) / n), parts = [];
  for (let a = from; a <= latest; a += step) parts.push([a, Math.min(latest, a + step - 1)]);
  const got = await pool(parts, 8, ([a, z]) => slice(a, z).catch((e) => e));
  // Keep every finished slice, but only advance the cursor through the unbroken prefix.
  const seen = new Set(cache.rows.map((r) => r[0]));
  let ok = true;
  got.forEach((g, i) => {
    if (g instanceof Error) { ok = false; return; }
    for (const r of g) if (!seen.has(r[0])) { seen.add(r[0]); cache.rows.push(r); }
    if (ok) cache.cp = parts[i][1];
  });
  if (parts.length) saveJson(cachePath(CACHE), cache);
  if (!ok) throw got.find((g) => g instanceof Error);
  return cache.rows;
}, 5 * MIN);

const token = memo(async (id) => {
  const c = l1();
  const address = await c.readContract({ address: CONFIG, abi: configAbi, functionName: "tokenAddressOf", args: [id] });
  if (address === zeroAddress) return LEGACY[id] ? { ...LEGACY[id], live: false } : null;
  const [eth, sui] = await Promise.all([
    c.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    c.readContract({ address: CONFIG, abi: configAbi, functionName: "tokenSuiDecimalOf", args: [id] }),
  ]);
  return { address, eth, sui, live: true };
}, 60 * MIN);

// Bridge record key = BCS BridgeMessageKey { source_chain: u8, message_type: u8 (0 = token), bridge_seq_num: u64 }.
const recordKey = (seq) => { const b = Buffer.alloc(10); b[0] = SUI; b.writeBigUInt64LE(BigInt(seq), 2); return b.toString("base64"); };
async function record(seq) {
  const d = await gql(`{ address(address: "${RECORDS}") { dynamicField(name: {type: "0xb::message::BridgeMessageKey", bcs: "${recordKey(seq)}"}) { value { ... on MoveValue { json } } } } }`);
  return d.address?.dynamicField?.value?.json?.value ?? null;
}

// SuiBridge reverts on any blocklisted or unstaked signer, and old records still hold such signatures:
// keep only signatures from signers the committee still accepts (the rest usually still meet the quorum).
const signerOk = memo((a) => Promise.all(["blocklist", "committeeStake"].map((functionName) => l1().readContract({ address: COMMITTEE, abi: committeeAbi, functionName, args: [a] }))).then(([bl, st]) => !bl && st > 0), 60 * MIN);
async function usableSigs(sigs, msg) {
  const hash = keccak256(encodePacked(["string", "uint8", "uint8", "uint64", "uint8", "bytes"], ["SUI_BRIDGE_MESSAGE", msg.messageType, msg.version, msg.nonce, msg.chainID, msg.payload]));
  const ok = await Promise.all(sigs.map(async (s) => signerOk(await recoverAddress({ hash, signature: s }))));
  return sigs.filter((_, i) => ok[i]);
}

const sui = {
  key: "sui", name: "Sui Bridge", scan: false,
  warm: () => sync(),
  async find(user) {
    const me = user.slice(2).toLowerCase();
    const mine = (await sync()).filter((r) => r[1] === me);
    return pool(mine, 4, async ([seq, , tokenId, amt, digest, cp, time]) => {
      const t = await token(tokenId);
      return {
        tx: digest, block: BigInt(cp), time, owner: user, nonce: seq, tokenId,
        asset: !t ? { kind: "erc20", network: "eth-mainnet", address: zeroAddress, symbol: `token#${tokenId}`, decimals: 8 } : tokenId === 2 ? ETH : erc20("eth-mainnet", t.address),
        amount: BigInt(amt) * 10n ** BigInt(t ? t.eth - t.sui : 0), // Sui side keeps fewer decimals (8 for ETH)
      };
    });
  },
  async status(it) {
    const c = l1();
    it.detail = `nonce ${it.nonce}`;
    it.action = "bridge.sui.io > Claim on Ethereum, or SuiBridge.transferBridgedTokensWithSignatures with the committee signatures from the Sui bridge record";
    if (await c.readContract({ address: BRIDGE, abi: bridgeAbi, functionName: "isTransferProcessed", args: [BigInt(it.nonce)] })) { it.status = "claimed"; return it; }
    const t = await token(it.tokenId);
    if (!t?.live) { it.status = "blocked"; it.detail += `; token id ${it.tokenId} is no longer supported on Ethereum`; return it; }
    const rec = await record(it.nonce);
    if (!rec) { it.status = "unknown"; it.detail += "; no Sui bridge record"; return it; }
    // The committee normally approves within minutes; a day without approval means something is wrong.
    if (!rec.verified_signatures) { it.status = now() - it.time > DAY ? "blocked" : "waiting"; it.detail += "; not approved by the bridge committee yet"; return it; }
    const m = rec.message;
    const msg = { messageType: m.message_type, version: m.message_version, nonce: BigInt(m.seq_num), chainID: m.source_chain, payload: `0x${b64hex(m.payload)}` };
    const sigs = await usableSigs(rec.verified_signatures.map((s) => `0x${b64hex(s)}`), msg);
    it.payload = encodeFunctionData({ abi: bridgeAbi, functionName: "transferBridgedTokensWithSignatures", args: [sigs, msg] });
    // Simulate the claim: success means anyone can submit it now.
    try {
      await c.call({ to: BRIDGE, account: it.owner, data: it.payload });
      it.status = "claimable";
    } catch (e) {
      const r = revertText(e);
      if (/already processed/i.test(r)) it.status = "claimed";
      else if (/EnforcedPause|paused/i.test(r)) { it.status = "blocked"; it.detail += "; SuiBridge is paused"; }
      else if (/exceeds bridge limit/i.test(r)) {
        // The limiter is a rolling 24h USD window: waiting unless this transfer alone is above the whole limit.
        const [usd, cap] = await Promise.all([
          c.readContract({ address: LIMITER, abi: limiterAbi, functionName: "calculateAmountInUSD", args: [it.tokenId, it.amount] }),
          c.readContract({ address: LIMITER, abi: limiterAbi, functionName: "chainLimits", args: [SUI] }),
        ]);
        it.status = usd > cap ? "blocked" : "waiting";
        it.detail += usd > cap ? "; larger than the whole 24h bridge limit" : "; 24h bridge limit is full, retry later";
      } else if (/Insufficient stake/i.test(r)) {
        // Early records lose quorum once a signer is blocklisted, and bridge nodes no longer re-sign txs that old.
        it.status = "blocked"; it.detail += "; stored committee signatures fall short of quorum (a signer was blocklisted), needs a re-sign";
      } else if (/ETH transfer failed/i.test(r)) {
        // The vault pays native ETH. An EIP-7702 account can clear its delegation and claim; a contract never can.
        const code = await c.getCode({ address: it.owner });
        const delegated = code?.startsWith("0xef0100");
        it.status = delegated ? "claimable" : "blocked";
        it.detail += delegated ? "; recipient's EIP-7702 delegate rejects ETH, clear the delegation first" : "; recipient contract rejects ETH";
      } else { it.status = "unknown"; it.detail += `; claim reverts: ${r.match(/reason:\s*([^\n]+)/)?.[1] ?? r.split("\n")[0]}`; }
    }
    return it;
  },
};

export default sui;
