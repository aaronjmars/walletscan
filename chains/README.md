# chains/ - balances on every EVM chain

`holdings.chains` reads one wallet on every EVM chain that still has a public RPC, for the chains a portfolio API misses (new, small, halted or shut down ones), and flags money left on shut-down chains. Read-only, keyless (Etherscan v2 and Alchemy keys add more when set).

## How it works

| Step | What | Where |
|---|---|---|
| Chain list | chainlist.org `rpcs.json` (ethereum-lists + its extra RPCs; chainid.network as fallback), mainnets only, up to 8 http RPCs per chain | `sourceList()` |
| Metadata | DefiLlama chain id -> coins.llama.fi chain key + gecko id of the native coin (static snapshot, `llama-chains.json`: the live config is 8 MB), Zerion slugs (`zerion-chains.json`), Blockscout instances (chains.blockscout.com); `LLAMA_FIX` adds chains DefiLlama prices but lists without a chain id (HyperEVM, Sei, XDC), `NATIVE_GECKO` natives with no gecko id (Forma = TIA) | `llama-chains.json`, `zerion-chains.json` |
| Probe (`warm()`) | every host resolved first with c-ares (fetch's getaddrinfo runs on 4 threads and stalls on dead domains), then each RPC gets one batch `eth_chainId` + latest block: chain id must match, keep the best 2 by latency, note batch support and head age. Gateways listed for 50+ chains (thirdweb, routeme) only where a chain's own RPCs all fail | `build()` |
| Cache | `CHAINS_CACHE_DIR/live.json` (the CLI uses `~/.cache/walletscan/chains`; default: `chains/` next to `STUCK_CACHE_DIR`), loaded on first use, rebuilt when over a day old | `warm()` |
| Natives | `eth_getBalance` + `eth_getTransactionCount` (one batch) on every live chain, 48 at a time, max 8 per host, 4 s per call, ~18 s budget | `readNative()` |
| Tokens | Blockscout multichain index (~40 chains, one paged walk per chain: a single walk over all of them stopped at 8 pages while one wallet has 26) + Routescan `all` (1 paged call) + Alchemy Portfolio API (34 EVM networks in 4 calls, its price only as a last resort, `alchemy.mjs`); then, for chains the wallet used (balance or nonce) that none covers, the chain's own explorer from `explorers.json` (Blockscout `/api/v2/addresses/<a>/tokens`, or a keyless Etherscan-style `tokentx`), else Etherscan v2 `tokentx` (key set) | `blockscoutCluster`, `routescan`, `alchemyTokens`, `blockscoutOne`, `etherscanOne` |
| Explorers | `explorers.json`: 385 chains' token APIs found by probing every chainlist.org explorer on 2026-10-15 (real API host from each Blockscout site's `envs.js`; chain id checked through `/api/eth-rpc` where it answers, 21 wrong links dropped). It is a snapshot: re-probe when coverage drops | `EXPLORERS` |
| Locked | a priced token worth $10+ that answers `maxWithdraw(owner) = 0` is a vault share that cannot be redeemed now (`locked: true`, a `locked` holding in the scan): Katana's kpdUSDC on the example wallet | `checkWallet()` |
| Prices | DefiLlama coins: `coingecko:<id>` for natives, `<chain key>:<address>` for tokens. Missing prices increment `unpriced`. ERC-20 balances with known decimals are retained with `usd: null` and `verified: false`; unpriced natives are left out. Explorer-only or thin-market (confidence < 0.9) prices are also unverified | `prices()`, `checkWallet()` |
| On-chain re-read | every priced token worth $0.50+ is re-read with `balanceOf` on the chain's RPC (10 per batch, next RPC on failure): indexes lag (Blockscout's index had a month-old USDC balance on the example wallet). A token whose balance equals the native balance is the native coin's ERC-20 face (CELO, Metis) and is dropped | `checkWallet()` |
| Shut-down chains | `data/sunset-chains.json` (101 chains: 92 shut down, 9 closing; sourced from L2BEAT archived projects and announcements). Balances on them come back under `sunset` (not `balances`); where no RPC or explorer answers, past deposits from the wallet to the chain's L1 bridge contracts (Alchemy transfers on the parent chain, shared contracts like the Agglayer bridge left out) are the hint | `deposits()` |

In `scan.evm`: after a complete Zerion response, rows on a chain Zerion answered for are dropped unless Zerion missed that token (no row, or a row with no price) and our read is verified, so nothing is counted twice; sunset balances become `bridge_stuck` findings (deadline = the exit window; a closed window = low confidence); a chain with no block for 30 days keeps its balance as an unverified holding with a warning. Sunset chains Zerion has a slug for also become deadline rows, so a Zerion balance on Blast, Abstract, Lisk, Redstone... is an exit finding too.

`scan.evm` can apply the public DEX Screener / GeckoTerminal fallback after joining the chain balances with the other readers. A usable market estimate fills a missing USD value while keeping the holding unverified. Fallback budgets and unchecked counts are described in the [main README](../README.md#reading-the-json-result).

## Numbers (2026-10-15, MacBook, residential network)

| | |
|---|---|
| Chains listed (mainnets with an http RPC) | 1,760 |
| RPC hosts / resolving in DNS | 3,604 / 2,816 |
| RPCs probed | 2,822 |
| Chains live after the probe | 774 (758 take batches; 27 with no block for 30 days) |
| Natives with a price | 218 chains |
| Chains with a Blockscout instance | 183 (+ ~40 in the multichain index, + Routescan) |
| Probe time | 39 s (76 s on a cold DNS cache; 127 to 185 s and many false failures with plain fetch, before the c-ares fix) |
| Scan time, one wallet | 6 to 10 s keyless, 12 to 15 s with Etherscan + Alchemy keys |
| Chains answered per scan | ~716 of 774 (~58 time out or fail) |
| RSS, library alone | 70 MB after loading the cache; plateaus ~175 MB after repeated scans (heap 20 to 40 MB, the rest TLS + allocator); 260 MB peak during the daily probe |
| Full `scan.evm`, example wallet | 13.5 to 14.8 s with the sweep (2.1 to 2.4 s without), every source ok |

## Gaps

Not covered: chains with no public RPC left (Redstone and most of the 92 shut-down chains: deposits hint only), non-EVM dead L2s (zkSync Lite, Loopring, StarkEx apps), tokens on chains with neither Blockscout nor Etherscan, DeFi positions on the extra chains (plain balances only).
