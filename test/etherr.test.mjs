// etherr.test.mjs - rewards.etherr_old_tokens: balanceOf over Etherr's 2015-2017 token list, hints only
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAbi, decodeFunctionData, encodeFunctionResult, toFunctionSelector } from "viem";
import { etherrOldTokens, TOKENS } from "../forgotten/etherr.mjs";
import * as F from "../findings.mjs";

const mc = parseAbi(["struct Call3 { address target; bool allowFailure; bytes callData; }", "struct Result { bool success; bytes returnData; }", "function aggregate3(Call3[] calls) payable returns (Result[] returnData)"]);
const OWNER = "0x1111111111111111111111111111111111111111";
const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
const sel = (s) => toFunctionSelector(s);
const [HELD, NAMELESS, ODD] = [TOKENS[0].address, TOKENS[1].address, TOKENS[2].address];
const enc = (fn, v) => encodeFunctionResult({ abi: ERC20, functionName: fn, result: v });

function chain() {
  return {
    live: () => true, local: () => [],
    call: async (id, p, { body } = {}) => {
      assert.equal(id, "evm.rpc");
      const { args: [calls] } = decodeFunctionData({ abi: mc, data: body.params[0].data });
      const result = calls.map((c) => {
        const s = c.callData.slice(0, 10), t = c.target.toLowerCase();
        if (s === sel("balanceOf(address)")) return t === HELD ? { success: true, returnData: enc("balanceOf", 2500000n) } : t === NAMELESS ? { success: true, returnData: enc("balanceOf", 3n) } : t === ODD ? { success: false, returnData: "0x" } : { success: true, returnData: enc("balanceOf", 0n) };
        if (s === sel("decimals()")) return t === HELD ? { success: true, returnData: enc("decimals", 6) } : { success: false, returnData: "0x" };
        if (s === sel("symbol()")) return t === HELD ? { success: true, returnData: enc("symbol", "OLD") } : { success: false, returnData: "0x" };
        return { success: false, returnData: "0x" };
      });
      return { status: 200, ok: true, data: { jsonrpc: "2.0", id: 1, result: encodeFunctionResult({ abi: mc, functionName: "aggregate3", result }) } };
    },
  };
}

test("etherr list: 1,185 tokens + 3 NFTs, lowercase unique addresses", () => {
  assert.equal(TOKENS.length, 1188);
  assert.equal(TOKENS.filter((t) => t.nft).length, 3);
  assert.equal(new Set(TOKENS.map((t) => t.address)).size, TOKENS.length);
  assert.ok(TOKENS.every((t) => /^0x[0-9a-f]{40}$/.test(t.address) && /^201[567]-/.test(t.created)));
});

test("etherr: held tokens come back, empty and reverting ones do not; amounts use the token's decimals", async () => {
  const d = await etherrOldTokens({ address: OWNER }, chain());
  assert.deepEqual(d.errors, []);
  assert.equal(d.items.length, 2);
  const held = d.items.find((i) => i.token === HELD), bare = d.items.find((i) => i.token === NAMELESS);
  assert.equal(held.amount, 2.5);
  assert.equal(held.asset, "OLD");
  assert.equal(bare.amount, 3e-18); // no decimals() answer: 18 assumed
  assert.ok(d.items.every((i) => i.confidence === "low" && i.usd === null && i.how_to_claim === "https://etherr.eth.limo/"));
});

test("etherr findings: low-confidence hints, source set, nothing priced", async () => {
  const f = F.oldEthereum(await etherrOldTokens({ address: OWNER }, chain()), { source: "rewards.etherr_old_tokens" });
  assert.equal(f.length, 2);
  assert.ok(f.every((x) => x.confidence === "low" && x.usd === null && x.chain === "ethereum" && x.source === "rewards.etherr_old_tokens" && x.deadline === null));
});

test("etherr: rejects a non-EVM address", async () => {
  await assert.rejects(etherrOldTokens({ address: "CuieVDEDtLo7FypA9SbLM9saXFdb1dsshEkyErMqkRQq" }, chain()), (e) => e.status === 400);
});

test("etherr: a contract that runs eth_call out of gas is isolated, the rest of its batch is still read", async () => {
  const bad = TOKENS[5].address, inner = chain();
  const ctx = { ...inner, call: async (id, p, { body } = {}) => {
    const { args: [calls] } = decodeFunctionData({ abi: mc, data: body.params[0].data });
    if (calls.some((c) => c.target.toLowerCase() === bad)) return { status: 200, ok: true, data: { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "out of gas" } } };
    return inner.call(id, p, { body });
  } };
  const d = await etherrOldTokens({ address: OWNER }, ctx);
  assert.equal(d.items.length, 2); // HELD and NAMELESS sit in the same first batch as the bad one
  assert.equal(d.errors.length, 1);
  assert.match(d.errors[0], /1 of 1188 contracts could not be read/);
});
