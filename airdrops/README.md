# airdrops: our own airdrop eligibility index

Finds airdrops a wallet can still claim without drops.bot: open-source eligibility lists, downloaded once into compact files on disk (`~/.cache/walletscan/airdrops` for the CLI), and each hit checked onchain (claimed, unclaimed, expired). Also finds airdropped tokens that were "claimed" into a vesting contract the wallet owns, vested since, and were never withdrawn. Route: `airdrop.index` (also a source in `scan.evm`).

## Files

- `lists.mjs`: what we add to each list: claim contracts, decimals, claim window, vesting kind. Plus `LISS_LISTS` (lissstern lists, spelled out), `EXTRA_LISTS` (PoolTogether, Index Coop) and `VESTING` (Safe, Shutter, Curve, vCOW). Contracts, windows and claim paths checked onchain, in rotki's decoders, Dune spellbook and verified sources on 2026-10-15.
- `index.mjs`: the library (`warm`, `checkWallet`, `lookup`, `status`). Importing it runs nothing.
- `build.mjs`: one list file to one index file. `warm()` runs it in a child process (`node build.mjs <jobs>`), so the scan process never keeps the build's memory.

## Sources

| Source | Lists | License | Updates |
|---|---|---|---|
| [rotki/data](https://github.com/rotki/data) `airdrops/index_v4.json` + 33 csv.gz | 33 (token, cutoff, claim page in the index) | no license file: used as reference data, downloaded at run time, not vendored | sha256 per file in the index: a changed file is rebuilt at the next `warm()` |
| [lissstern/airdrop-db](https://github.com/lissstern/airdrop-db) | 5 used (arbitrum, connext, hop, op_1, safe) | GPL-3.0 (data, downloaded at run time, not vendored) | frozen since Feb 2024: pinned to commit `6eb596e` |
| [pooltogether/merkle-distributor](https://github.com/pooltogether/merkle-distributor) | POOL retro airdrop (2021): 385k POOL still in the distributor, no deadline | GPL-3.0 | pinned to `b76e343` |
| [SetProtocol/index-coop](https://github.com/SetProtocol/index-coop) `merkleDistribution.ts` | INDEX initial airdrop (2020): 36.7k INDEX left, no deadline | Apache-2.0 | pinned to `d3267e8` |
| dYdX MerkleDistributorV1 `0x01d33486...` (its `getActiveRoot()` names the IPFS file) | DYDX retroactive mining + trading/LP rewards, final epoch 31: 73,638 addresses, cumulative amounts; the treasury still pays (6.46M DYDX), no deadline | onchain data | pinned by CID (immutable) |
| [Sablier](https://app.sablier.com/airdrops) Merkle campaigns: Envio indexer + the campaign's IPFS file | every campaign still open (not clawed back, not expired) with more than 10 real claims, on a chain we price: ~42 lists (Ethena ENA rewards to 2027-06, OP Season 6 epochs, Velvet, Stabull, LDY, WDD...) | the creators' data | listed again at each `warm()`, built once per CID (immutable) |

Not indexed: rotki's 16 POAP lists (free NFTs, no money), lissstern `uniswap`/`op4`/`shutter-genesis` (same as rotki), `op3` (sent without a claim), `starknet_*` (Starknet side), `granary`/`odg` (closed 2023-09 and 2024-04, nothing left to claim). Seen with tokens left but no list found: FPIS (Convex cvxFXS holders), 88mph MPH. A new rotki list shows up by itself; until `lists.mjs` names its claim contract its hits come back `unknown` (a low-confidence hint) and `expired` after its cutoff.

## How a hit is judged

- **claimed** (cumulative lists, dYdX): `getClaimed(wallet)` on the distributor; the claim pays the list amount minus that, out of the rewards treasury (`funds`, balance checked).
- **claimed** (Sablier campaigns): a `Claim` action by the wallet in Sablier's indexer (one query for all of a wallet's campaigns, which also catches a clawback since the last build). An unclaimed hit with no DefiLlama price stays `unknown` (presale and test tokens are common).
- **claimed**: a transfer of the list's token from one of its claim contracts (`from` in `lists.mjs`, `0x0` when the claim mints) to the wallet, via Alchemy `alchemy_getAssetTransfers` (one call per contract, `maxCount 1`). Claim contracts were found by matching list amounts to the transfers of sample addresses (2026-10-15).
- **expired**: not claimed and past the window (`until` from rotki's cutoff or the contract's own `claimPeriodEnds()` / `redeemDeadline()`, or `closed`), or no end date but the claim contract no longer holds the amount (`balanceOf`).
- `open` lists ignore the source cutoff because the claim has no time check and nobody swept it: Optimism airdrop 5 (rotki cutoff 2025-10-09, but `clawBack()` was never called, 779k OP left) and Hop (`claimPeriodEnds` only gates `sweep()`, 8.17M HOP left). They stay claimable until someone sweeps, which the funded check catches.
- Still paying with no deadline (2026-10-15): Uniswap, 1inch, Cornichon, Grain, Lido, Convex, ParaSwap, Saddle (vesting), Squill 1-3, PoolTogether, Index Coop, plus the two `open` lists above.
- **unclaimed**: not claimed, window open, contract still funded. Only these become findings with `confidence: high`.
- **unknown**: no claim contract known (or not EVM). A `low` hint while its window is open, else `expired`.
- Lists whose claim went into a vesting contract (Shutter, Safe) count as claimed when that vesting is found.

Vesting leftovers (checked for every wallet, whether or not it is on a list):

| Kind | Contracts | How the vesting is found | Read |
|---|---|---|---|
| Safe | user airdrop `0xa0b937d5...`, ecosystem `0x29067f28...` | `AddedVesting(id, account)` logs with account = wallet | `calculateVestedAmount(id)` - vested minus claimed |
| Shutter | airdrop `0x024574c4...` | `RedeemedVesting(id, user)` log, then the per-user VestingPool from the `AddedVesting(id)` log in the same tx | same, on the pool |
| Curve | VestingEscrow `0x575ccd8e...` | `initial_locked(wallet) > 0` | `balanceOf(wallet)` = vested and not claimed |
| CoW | vCOW on Ethereum `0xd057b63f...` and Gnosis `0xc20c9c13...` | vCOW `balanceOf(wallet) > 0` | `swappableBalanceOf(wallet)`: vCOW (fully vested 2026-02-12) that `swapAll()` turns into COW now, priced as COW |

Prices: DefiLlama `coins.llama.fi` for unclaimed items only; a confidence under 0.9 is noted as a thin market.

## API (`import ... from "./airdrops/index.mjs"`)

- `warm({ dir, lists } = {})` -> `{ lists, built, kept, records, disk_mb, errors, ms, total_ms }`. Fetches rotki's index, builds the files that changed (child process, two at a time), keeps the last good file when a download fails, and remembers rotki's lists in `manifest.json` so a rotki outage does not drop them. One run at a time. `checkWallet` warms on first use and refreshes in the background once a day.
- `checkWallet(address)` -> `{ items, errors, lists_checked, index_built }`. Items: `{ kind: airdrop | vesting, id, source, name, chain, token, symbol, amount, usd, status, deadline, claim_url, claimed_tx, claimed_at, distributor, detail }`; vesting items add `contract, vesting_id, vested, claimed, total, vesting_end`. A failed read lands in `errors` and that item falls back to `expired`/`unknown`, never `unclaimed`. Throws `{status:400, ...}` for a bad address or no `ALCHEMY_API_KEY`, `{status:503}` when no list could be built.
- `lookup(address)` -> the list hits from the files only, no network.
- `status()` -> `{ ready, building, lists, built, dir, open_files }`.

## Env

- `ALCHEMY_API_KEY` (or `ALCHEMY_KEY`): needs Ethereum, Optimism, Arbitrum, Base, Gnosis, zkSync enabled (all are, for `stuck`).
- `AIRDROP_CACHE_DIR`: default `airdrops` next to `STUCK_CACHE_DIR` (`/x/stuck` -> `/x/airdrops`), else `airdrops/.cache/`; the CLI sets it to `~/.cache/walletscan/airdrops`. Needs ~140 MB.

## File format

Per list `<id>.idx`: 16-byte header (`ADX1`, record count, bucket count), a table of 4097 uint32 record offsets by the address's first 12 bits, then 28-byte records (20-byte address + float64 amount, NaN = no amount) sorted by address, repeats merged. A lookup reads one bucket per list (one `pread` of at most a few KB) and binary-searches it. Only the bucket tables (16 KB a list, 0.6 MB total) stay in memory. `FORMAT` in `build.mjs` forces a rebuild when it changes.

## Measured (2026-10-15, this Mac, Node 26)

| Case | Result |
|---|---|
| `warm()`, empty dir (download + build 38 lists, 5,070,242 addresses) | 17.1 s (largest: shapeshift 6.5 s, zk 4.8 s, arbitrum 3.8 s, odos 3.5 s) |
| Adding the 2 extra lists to that dir (40 lists, 5,088,465 addresses, 143.1 MB) | 0.74 s: only the new files are built |
| `warm()`, files current, new process | 0.12-0.16 s (one request for rotki's index) |
| Disk | 142.6 MB (shapeshift 31 MB, zk 19 MB, arbitrum 18 MB, odos 14 MB) |
| RSS of the calling process after a cold `warm()` | 80 MB (Node alone: 59 MB). The build child peaks at ~290 MB and exits |
| RSS at rest after 6 `checkWallet` calls | 90 MB, so ~30 MB on top of Node |
| Same, building in-process (first version, for comparison) | 264-269 MB, never given back: why the build moved to a child |
| `lookup` (38 lists) | 30-40 us |
| `checkWallet`, wallet on 13 lists | 1.0-1.2 s first call, 0.4-0.8 s after |
| `checkWallet`, wallet on 1-2 lists | 0.2-0.5 s |

## Checked on real wallets (2026-10-15)

- `0x76f901ad93dcf595dbe13a70136194e194542385` (a Safe user airdrop vesting): **520.01 SAFE vested and not withdrawn**, ~$60.
- `0x31ea0d97cd822e3a4efc27646729581060f46c4c` (on the Uniswap and 1inch lists): **400 UNI (~$3,003) and 621.76 1INCH (~$59) never claimed**, both distributors still funded and with no deadline.
- `0x0003440b0f7edb40c1c089b743a07a56bff72af0` (first row of the PoolTogether list): 44.42 POOL, claimed 2021-02-19 (the JSON-lines parser and claim check agree). The vCOW check ran on two big vCOW claimers: both already swapped (0 vCOW), no error; no wallet still holding vCOW was found to show a positive case.
