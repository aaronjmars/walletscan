# stuck as a library (port notes)

Started as `stuck`, a standalone bridge checker (MIT). The CLI still works the same (`node stuck/stuck.mjs check 0x...`, `scan ...`); `index.mjs` is the entry point walletscan calls (`bridge.stuck` in `compose.mjs`).

## What changed vs upstream

- `core.mjs` (new): the built-in bridges, the bridge registry, `enrich()` pricing, `runBridge()`, `checkAddress()` (one wallet on N bridges + the "recipient is" note), `toJson()` (the `--json` cleanup) and the scan helpers. Moved out of `stuck.mjs` with no logic changes.
- `stuck.mjs`: now a thin CLI over `core.mjs` (output formatting, args, `check`, `scan`). Same flags, same output.
- `index.mjs` (new): the library API below. Importing it runs nothing and never calls `process.exit`.
- `lib.mjs`:
  - `KEY` (read at import) became `alchemyKey()` (read at call time), and it accepts `ALCHEMY_API_KEY` too.
  - `memo(fn, ttl)`: one shared in-flight promise per key, kept for `ttl` ms after it settles, dropped on failure. Upstream cached with `??=` forever, which is fine for a CLI that exits but in a long-lived process it means indexes never update, Linea's finalized block never moves, and one network error is cached for good.
  - `cachePath(name)` / `saveJson(path, obj)`: on-disk indexes go to `STUCK_CACHE_DIR` (created if missing), else `stuck/.cache/` as before. The temp file name now includes the pid.
  - `warn(msg)` + an AsyncLocalStorage context: partial failures inside a bridge (one CCTP chain down, capped lists, dYdX index failure) go to the call's `errors` list. The CLI still prints them as `! ...` on stderr.
- Bridges:
  - starknet, sui, ronin: use `cachePath`/`saveJson`; index sync uses `memo` with a 5 min ttl (ronin legacy is frozen: kept forever); each one exports `warm()`.
  - starkex: the dYdX registration index has its own `dydxAll()`, used by `warm()`; a failed build is no longer cached.
  - cctp (Iris answers 5 min), wormhole (operations per wallet 5 min, guardian sets 1 h), gnosis (validators 1 h), sui (token config, signers 1 h), starkex (asset registry, frozen flag 1 h), polygon (token mapping 1 h), linea (L1 state 5 min): `memo` instead of forever-maps.
  - debridge: unchanged.
  - lisk (new here, not upstream): withdrawals indexed from Lisk's public RPC on disk (`lisk-withdrawals.json`, ~1.2 MB, ~35 s cold, `warm()`), status read on the portal and dispute game directly; frozen once the RPC is gone after the 2026-10-31 shutdown.
  - manta (new here): the same index for Manta Pacific from its public RPC (`manta-withdrawals.json`, `warm()`), status on the portal and L2OutputOracle.
  - mantle (new here): per wallet from Routescan's logs API (no index), status on the portal and L2OutputOracle with Mantle's own withdrawal hash; Mantle v1 withdrawals rebuilt as the version-0 withdrawals the 2024 upgrade migrated them to.
  - OP Stack in core: `mode` (was scan-only), `bob` and `dbk` read through their public RPCs (`rpc` in OP_CHAINS, `rpcClient` in lib.mjs); the three per-wallet log queries run in parallel.
  - opbnb (new here): per wallet from NodeReal's opBNB explorer API (no index), receipts on the public RPC, status on the BNB Chain portal and L2OutputOracle with the shared reader on a BNB Chain client; BNB as the native coin (`enrich` prices a native coin by its symbol).
  - taiko (new here): per wallet from Taiko's relayer API (no index), messages decoded from the raw log it returns; `messageStatus` on the L1 Bridge, then the claim simulated with a storage proof against the newest L1 checkpoint (`CheckpointSaved`, 5 min memo).
  - morph (new here): per wallet from Morph's bridge indexer (no index); message rebuilt from the L2 receipt, proof from the indexer, `proveAndRelayMessage` simulated.
- `lib.mjs` also has `rpcClient(chain, url)` and the shared L2OutputOracle reader (`l2ooSettings`, `l2ooFacts`, `classifyL2oo`, with an optional L1 client) used by mantle, manta and opbnb.

## API (`import ... from "./stuck/index.mjs"`)

- `checkWallet(address, { bridges, includeAll } = {})` -> `{ items, errors, bridges_checked }`
  - `items`: plain JSON objects, exactly what `stuck.mjs check <addr> --json` prints (BigInts as strings; payload/verify/needMessage/emitter/logIndex dropped). Fields: bridge (display name), status, owner, tx, block, time, amount (raw units, string), symbol, value, usd, action, detail, asset, plus claim data per bridge (e.g. arbitrum `position`, linea `nonce`/`hash`, starknet `l1Bridge`/`l1Token`, ronin/sui/cctp/wormhole claim fields).
  - Default: only `STUCK_STATUSES`. `includeAll: true`: also waiting, claimed, unknown.
  - `bridges`: optional array of keys from `BRIDGE_KEYS`; empty or missing = all.
  - `errors`: `[{ bridge: <key>, error }]`, one per failed bridge or partial failure. Never throws for a bridge failure.
  - `bridges_checked`: the keys that ran.
  - Throws plain objects: `{status:400, error:"route not configured (unset env)", detail:["ALCHEMY_API_KEY"]}`, `{status:400, error:"unknown bridge", detail:key}`, `{status:400, error:"invalid address", detail}`.
  - At most 2 calls run at once (the CLI's 2-wallets-at-a-time cap, for Iris, DLN and Wormholescan rate limits); the rest wait.
  - Not ported: `--min-usd` (the caller can filter on `usd`) and `scan` (CLI only).
- `warm()` -> `{ warmed, errors, ms, total_ms }`: builds or updates the starknet, ronin, sui, lisk and manta indexes on disk and the dYdX registration index in memory. `walletscan` calls it before a scan when the index dir is empty, and `walletscan update` forces it.
- `BRIDGE_KEYS`: the 32 keys (base, optimism, zora, ink, unichain, soneium, mode, worldchain, shape, blast, bob, dbk, arbitrum, polygon, linea, zksync, scroll, cctp, debridge, gnosis, lisk, manta, mantle, morph, opbnb, ronin, starkex, starknet, sui, taiko, wormhole, wormhole-ntt).
- `STUCK_STATUSES`: `["claimable", "ready-to-prove", "ready-to-finalize", "blocked"]`.

## Env

- `ALCHEMY_KEY` or `ALCHEMY_API_KEY` (read at call time; without it the bridges that need full-history logs are skipped, see `skipped`). The Alchemy app needs every chain above enabled, plus the Prices API.
- `STUCK_CACHE_DIR` (optional): index directory (the CLI uses `~/.cache/walletscan/stuck`). About 64 MB today (ronin-legacy 22.8 MB, starknet 19.5 MB, ronin-v3 18.3 MB, sui 3.2 MB), plus lisk and manta (5.4 MB).

## Measured (2026-10-15, this Mac, Node 26, viem 2.57.7)

| Case | Time |
|---|---|
| Upstream CLI, empty `.cache/`, vitalik.eth | 153 s |
| Upstream CLI, warm `.cache/` | 4 s |
| `checkWallet`, empty cache dir, first call (builds every index) | 146 s |
| same process, second call | 2.9 s |
| `warm()`, empty cache dir | 144 s (ronin 144 s, starkex/dYdX 50 s, starknet 45 s, sui 14 s, in parallel) |
| `checkWallet` right after that `warm()` | 3.0 s, then 1.5 s |
| `warm()`, warm disk cache, new process | 12.4 s (dYdX 12.3 s, disk indexes 0.25-0.3 s) |
| `checkWallet`, warm disk, after `warm()` | 1.5-2.1 s |
| Import of `index.mjs` | 0.14-0.3 s |

Before the dYdX index moved into `warm()`, about 1 call in 4 took 20-23 s: the L2BEAT dYdX explorer throttles (429), stuck waits on it, then builds the dYdX index (~15 s). Once built it stays for the life of the process.

Memory: peak RSS was 1.7 GB while building every index from scratch, and 550-580 MB with warm indexes. The cold build happens once per index dir; later runs only sync new blocks.

Manta index (2026-10-21, same Mac): 26,747 withdrawals, `manta-withdrawals.json` 5.4 MB, 13-24 s cold (245 MB peak RSS alone). It builds in parallel with the others, so a cold `warm()` stays ronin-bound: 165 s and 1.84 GB peak with it, against 179 s and 1.86 GB for main run just before (the difference is network noise). Warm disk, new process: 13.6 s (dYdX-bound, manta 0.35 s). Mantle, Mode, BOB and DBK keep no index: about 0.6-1.5 s per wallet each.

## Checked against the CLI

Same wallets, same cache: upstream CLI `--json`, new CLI `--json` and `checkWallet` gave the same items (ignoring `usd`, which moves with prices between runs), in both default and `--all`/`includeAll` mode:

- 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 (vitalik.eth): nothing stuck; with all, 1 claimed CCTP item (100k USDC).
- 0xD9b311B20934C723304F8C3FcdeFE08AF29bBe63: Base, ready-to-prove, 0.0931 ETH (~$228). Found with `scan base --days 30`.
- 0x96e53CD969741FdBf09F718557D0979d652C5c80: Arbitrum, claimable, 1.0999 ETH (~$2,699). Found with `scan arbitrum --days 30`.

No bridge errored in any of these runs (`errors: []`). `scan base` and `scan arbitrum` (30 days) also ran on the new CLI: 1181 and 1051 withdrawals checked, 56 and 51 stuck.
