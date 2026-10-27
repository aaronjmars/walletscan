// ens.mjs - ENS names (vitalik.eth, nick.base.eth, x.cb.id...) -> the 0x address they point to, for the CLI: a name
// is anything with a dot that is not already an address a scan takes (NEAR's alice.near stays a NEAR account).
// Read on Ethereum through viem's Universal Resolver (offchain names via CCIP-read too): Alchemy with the key, else
// the keyless public RPC. Nothing is cached; a name with no ETH address set is a bad address (exit 2).
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import { normalize } from "viem/ens";
import { PUBLIC_RPC } from "./keyless.mjs";

export const looksLikeName = (s) => /^[^\s/:@]+\.[^\s/:@.]+$/u.test(s) && !/^0x/i.test(s);

let client;
function ensClient() {
  const key = process.env.ALCHEMY_API_KEY || process.env.ALCHEMY_KEY;
  client ||= createPublicClient({ chain: mainnet, transport: http(key ? `https://eth-mainnet.g.alchemy.com/v2/${key}` : PUBLIC_RPC["eth-mainnet"], { timeout: 15_000, retryCount: 2 }) });
  return client;
}
const viemResolve = (name) => ensClient().getEnsAddress({ name });

// items -> { list (names swapped for their address), names: { lowercase address -> name } }; isAddress(s) = a scan takes it.
// Throws { status: 400, error, detail } for a name that does not resolve, { status: 502 } when the read fails.
export async function resolveNames(items, isAddress, resolve = viemResolve) {
  const names = {};
  const list = await Promise.all(items.map(async (s) => {
    if (isAddress(s) || !looksLikeName(s)) return s;
    let name;
    try { name = normalize(s); } catch (e) { throw { status: 400, error: `${s} is not a valid ENS name`, detail: String(e?.shortMessage || e?.message || e).split("\n")[0] }; }
    let address;
    try { address = await resolve(name); } catch (e) { throw { status: 502, error: `could not read the ENS name ${name}`, detail: String(e?.shortMessage || e?.message || e).split("\n")[0].slice(0, 200) }; }
    if (!address || /^0x0{40}$/i.test(address)) throw { status: 400, error: `${name} has no ETH address set in ENS` };
    names[address.toLowerCase()] = name;
    return address;
  }));
  return { list, names };
}
