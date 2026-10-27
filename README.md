# walletscan

[![npm](https://img.shields.io/npm/v/walletscan-cli)](https://www.npmjs.com/package/walletscan-cli) [![ci](https://github.com/aaronjmars/walletscan/actions/workflows/ci.yml/badge.svg)](https://github.com/aaronjmars/walletscan/actions/workflows/ci.yml) [![license: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Paste a wallet, find the money it forgot: rent, rewards, stuck bridge withdrawals, airdrops, unredeemed bets, old tokens whose swap still pays. A command line tool that runs every check on your machine. Read-only: nothing signs, sends or connects a wallet.

Chains: EVM (every chain with a public RPC), Solana, Bitcoin, TRON, NEAR, Sui, Polkadot / Kusama, TON.

## What it finds

| Category | What |
|---|---|
| `solana_rent` | rent locked in empty token accounts, and the extra rent old accounts hold since the Sept 2026 rent cut |
| `solana_stake` | deactivated SOL stake never withdrawn |
| `reward` | uncollected LP fees (Uniswap v3 + v4, Orca, Raydium, Meteora), Merkl, Aave and Compound incentives, Zora and 0xSplits earnings, veNFT fees and bribes, other protocol rewards |
| `creator_fees` | pump.fun, PumpSwap, Flaunch, Bankr, Klik and Pons v2 creator fees never collected |
| `airdrop` | unclaimed airdrops from 40+ open eligibility lists (each hit checked onchain), Parcl, the 2017 DOT sale |
| `vesting` | Pons buybacks vested and never released, plus vesting and payment streams unlocked and never withdrawn (Sablier, Hedgey, LlamaPay, Streamflow, UNCX, Team Finance) |
| `unstake_ready` | finished unstakes and withdrawals never claimed (Lido, EigenLayer, liquid restaking queues, expired vote locks, Babylon BTC, TRON, NEAR, DOT, Sui) and money left in old Ethereum contracts |
| `token_migration` | old tokens whose official swap still pays (KNCL to KNC, RNDR, NU / KEEP, dead DeFi tokens, LP of dead DEXes) |
| `bridge_stuck` / `bridge_blocked` | bridge withdrawals that need a last step (32 bridges via `stuck/`, plus LayerZero, CCIP, Wormhole, Across...) and money left on ~100 shut-down chains |
| `prediction_winnings` | resolved Polymarket bets never redeemed |
| `exchange_balance` | money left on perp exchanges that closed or went withdraw-only (Drift, GMX v1, Alpaca...) |
| holdings | plain balances and DeFi positions on every chain, kept apart from the findings |

Missing token prices are checked against public DEX Screener pools, with GeckoTerminal as a fallback. These are spot estimates: a token needs an active, sufficiently deep pool, and market prices never make an unverified holding count as verified. Rugcheck adds Solana risk flags alongside GoPlus. Price and risk checks have small per-scan budgets; JSON reports how many tokens remain unchecked.

EVM scans also inspect current token approvals on Ethereum, Avalanche, Mantle and Blast using public history. Historical permissions are rechecked onchain, so revoked allowances and transferred NFTs do not appear as active. Approvals are reported separately from money found, with Revoke.cash links. Other networks' approval history is not checked.

Each finding has an amount, a USD value, how to claim it, a deadline when there is one, a confidence (high = the source says it is claimable now, medium = check in the app first, low = a hint) and a bucket: `you_can_claim`, `team_must_release` (the protocol must act first) or `may_not_work`.

## Install

Node 24 or newer. The package is [`walletscan-cli` on npm](https://www.npmjs.com/package/walletscan-cli); the command it installs is `walletscan`.

```bash
npm i -g walletscan-cli
walletscan 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
walletscan vitalik.eth              # ENS names work too
```

Start scanning without keys. Run `walletscan setup` when you want to add Alchemy and Zerion; the first terminal scan may also offer this optional setup.

Latest main from GitHub: `npm i -g --allow-git=root github:aaronjmars/walletscan` (`--allow-git=root` is needed from npm 12, which blocks installs from git by default; older npm accepts it too). From a clone: `npm ci`, then `node cli.mjs <address>`.

## Keys

Provider keys are optional. `walletscan setup` asks for the two that find the most, Alchemy and Zerion: what each unlocks, where to get one, a hidden prompt (Enter skips), and a live check before the key is saved. The others are set with `walletscan keys set <provider>`.

| Provider | Env | Unlocks |
|---|---|---|
| `alchemy` | `ALCHEMY_API_KEY` | full history on every EVM network for stuck bridges, airdrops, smart wallets and other log-based checks; tokens on 34 networks. In the Alchemy app, turn on every network. The Free plan caps `eth_getLogs` at 10 blocks, so with a Free key those log reads go through the keyless path (listed as "needs a paid Alchemy plan") |
| `zerion` | `ZERION_API_KEY` | portfolio, DeFi positions and rewards on every chain Zerion covers |
| `helius` | `HELIUS_API_KEY` | Solana: Helius holdings and prices, Serum leftovers, faster scans |
| `etherscan` | `ETHERSCAN_API_KEY` | more tokens on small EVM chains |
| `proxy` | `PROXY_URL` | your own `http://user:pass@host:port` proxy for the upstreams that block some regions (Reya, Babylon) |

```bash
walletscan keys                     # which keys are set, from where, what each unlocks
walletscan keys set helius          # hidden prompt, or pipe the key on stdin
walletscan keys rm helius
```

Env vars win over the keys file. Give Zerion the raw key: it is stored base64 encoded, as its API expects.

### Without keys

A scan with no key still runs almost every source: the Alchemy routes are answered by public RPCs and keyless explorers, the Helius routes by the public Solana RPC. What is skipped is listed under "Skipped for a missing key" with the key that unlocks it:

- no Alchemy: full-history logs only on Ethereum, Avalanche, Mantle and Blast, so parts of stuck bridges, airdrops, smart wallets, LlamaPay and Uniswap fees on other networks are skipped
- no Zerion: Zerion DeFi positions and rewards (holdings on every chain are still read onchain)
- no Helius: Helius holdings (compressed tokens, Helius prices) and Serum leftovers; other Solana reads go slower, paced for the public RPC
- no Etherscan: a few small-chain tokens
- no proxy: Reya and Babylon are called directly and may answer 403 in some regions

These sources run without adding any keys:

| Source | Adds | Coverage |
|---|---|---|
| [Pons v2](https://docs.ponsfamily.com/v2) | unwithdrawn fee escrow balances and vested buyback tokens | Robinhood Chain, active and archived v2 escrows; registered quote assets and launch tokens discovered from the wallet's public profile |
| [DEX Screener](https://docs.dexscreener.com/api/reference) + [GeckoTerminal](https://apiguide.geckoterminal.com/) | missing token prices and pool liquidity | supported EVM networks and Solana; bounded fallback checks, with estimates kept below high confidence |
| [Rugcheck](https://api.rugcheck.xyz/swagger/doc.json) | explicit Solana token risk flags alongside GoPlus | selected uncertain findings and unverified holdings with a USD value; an unavailable report stays unchecked |
| Routescan + public RPCs | current ERC-20, NFT and operator approvals, with [Revoke.cash](https://revoke.cash) links | Ethereum, Avalanche, Mantle and Blast; historical candidates are rechecked against current contract state |

Jupiter remains the primary Solana token information source. Requests use its canonical `api.jup.ag` endpoint with shared keyless pacing. The public sources have rate limits, so a scan may leave some prices or risk reports unchecked; their check counts are included in `--json`.

## Usage

```bash
walletscan <address...> [--json] [--min-usd N] [--all] [--no-color] [--quiet]
walletscan vitalik.eth nick.base.eth  # ENS names resolve to their ETH address on Ethereum first
walletscan                          # in a terminal: asks for the address(es)
walletscan update                   # rebuild the local indexes now
```

| Flag | |
|---|---|
| `--json` | the raw scan answer on stdout |
| `--min-usd N` | hide findings worth less than N USD (default 1) |
| `--all` | include low-confidence hints |
| `--no-color` | plain text (`NO_COLOR` works too) |
| `--quiet`, `-q` | no progress on stderr |

Several addresses (any kinds, mixed) give one merged answer: totals across wallets, every row tagged with its address, 3 wallets scanned at a time. The report shows totals per bucket, how much is sure or likely, findings biggest first with how to claim, a holdings line, the sources that failed (not checked, not "nothing there") and the ones skipped for a key. Exit codes: 0 ok, 1 error, 2 bad address. Progress goes to stderr, results to stdout.

A scan follows Zerion and Helius portfolio pages and queries Jupiter in batches of 100 mints. Orca and Raydium position discovery checks NFT candidates in chunks, including Orca position bundles. If a page, NFT check or nested source stops early, earlier results remain available. Multi-wallet scans preserve these details for each wallet.

### Reading the JSON result

| Field | Meaning |
|---|---|
| `partial`, `totals.partial` | a balance or claim source failed or stopped early, so the totals may be incomplete |
| `coverage` | each source's `complete`, `truncated`, `failed`, `not_configured` or `skipped` status; paged readers also include check counts and a reason when incomplete |
| `failed_sources` | sources that could not finish because of an error |
| `truncated_sources` | sources that stopped at a page or time limit, retaining the results already read |
| `skipped_for_keys` | sources, or parts of them, that need an optional key |
| `market_quotes` | fallback price candidates, checked and priced counts, unchecked tokens and request errors |
| `rugcheck`, `goplus` | provider-specific risk check counts; Rugcheck flags also appear as `risk_flags` on checked rows |
| `security.approvals`, `security.coverage` | active permissions and per-chain approval check coverage, separate from findings and USD totals |

`partial: false` describes the balance and claim readers. Price fallbacks, risk checks and approval history can still have gaps; check their own counts, errors and coverage. A `complete` source means that reader finished its supported checks, not that every protocol or token was covered. In multi-wallet results, `wallets[]` retains each wallet's coverage, price and risk summaries, while truncated sources and approvals are tagged with the wallet address.

ERC-20 approvals keep `allowance_raw`, `balance_raw` and `exposed_raw` as decimal integer strings in the token's smallest unit. Apply `decimals` to display them; `exposed_raw` is the smaller of the current allowance and balance, or `null` when the balance could not be read. NFT `token_id` values are strings too. An active or unlimited permission alone does not mean its spender is malicious.

Pons v2 checks active and archived fee escrows, registered quote assets and launch tokens discovered from the public wallet profile. Vested buybacks use the vault's current beneficiaries and snapshotted split. Already-credited fees and unreleased vested tokens are separate. Unswept trading fees and Pons v1 locker fees are outside this reader's coverage.

## Where things live

- Keys: `~/.config/walletscan/keys.json` (mode 600; `XDG_CONFIG_HOME` respected).
- Indexes: `~/.cache/walletscan/` (`XDG_CACHE_HOME` respected; `STUCK_CACHE_DIR`, `AIRDROP_CACHE_DIR`, `OLDETH_CACHE_DIR`, `CHAINS_CACHE_DIR` move each one): `chains` (probed public EVM RPC list, under 1 MB, ~40 s to build), `forgotteneth` (Forgotten ETH index mirror, ~140 MB), `airdrops` (eligibility lists, ~140 MB, 1 to 3 min), `stuck` (bridge withdrawal indexes, ~10 MB keyless, ~70 MB with Alchemy, up to a few minutes cold). An EVM scan builds the ones it reads when missing or over a day old; later runs reuse them.
- Other env: `CALL_TIMEOUT` (seconds per upstream call, default 20), `RETRY_MAX` (default 2), `CACHE=off` (no in-memory response cache), `WALLETS_MAX` (addresses per run, default 50), `WALLETS_BUDGET_S` (time limit of a multi-wallet run, default 1800). `NAME_2` ... `NAME_9` next to a key (e.g. `HELIUS_API_KEY_2`) are spare keys used when the first one runs out of credits.

## Privacy

Addresses go only to the upstream data APIs a scan reads: public RPCs and explorers (including Routescan approval history), price APIs (DefiLlama, Jupiter, DEX Screener, GeckoTerminal), Rugcheck, protocol APIs (including Pons wallet profiles), and Alchemy, Zerion, Helius or Etherscan when their key is set. There is no telemetry and no server of ours. Keys stay on your machine and are blanked out of anything printed.

## How it works

| File | What |
|---|---|
| `cli.mjs` | the `walletscan` CLI: keys, setup, index warm-up, the report |
| `engine.mjs` | `callRoute`: runs one route with per-host pacing, retries, time limits, spare keys and a short response cache; the on-disk index list |
| `apis.mjs` | the route list, one object per upstream API (shape documented in `registry.mjs`) |
| `registry.mjs` | templating and request building, keyless stand-ins, which routes are live with the keys set |
| `compose.mjs` | multi-step routes: `scan.all` (picks the scan for the address kind), `scan.wallets` (many addresses), `scan.evm`, `scan.sol` and the sources that read several APIs |
| `findings.mjs` | pure normalizers: raw answers in, findings, buckets and totals out |
| `keyless.mjs` | the stand-ins when a key is unset (Alchemy JSON-RPC from public RPCs and keyless explorers) and the notes behind "skipped for a missing key" |
| `market.mjs`, `pagination.mjs`, `approvals.mjs` | public price and risk evidence, bounded wallet pagination, current approval exposure |
| `cache.mjs`, `solana.mjs` | the response cache; Solana PDA and token account math |
| `stuck/` | the `stuck` bridge checker as a library (vendored, MIT), see `stuck/PORT.md` |
| `airdrops/` | the airdrop eligibility index, see `airdrops/README.md` |
| `chains/` | balances on every EVM chain with a public RPC, and shut-down chains, see `chains/README.md` |
| `oldeth/` | money left in old Ethereum contracts (Forgotten ETH index + onchain readers) |
| `forgotten/`, `unclaimed/`, `perps/` | the forgotten-money sources: contracts read directly, dead apps, perp venues |
| `nonevm/` | Bitcoin, TRON, NEAR, Polkadot, Sui and TON: address kinds, routes and scans |
| `data/` | hand-kept lists: claim deadlines, shut-down chains, dead DEXes, embedded-wallet guide |

Add a source: one entry in `apis.mjs`, a normalizer in `findings.mjs`, a line in the scan's source list in `compose.mjs`, and a fixture test.

## Tests

```bash
npm test
```

`node --test` over `test/*.test.mjs`: fixtures and a stubbed `fetch`, so the suite needs no keys and almost no network. CI runs it on every push and pull request.

## Releases

Each version goes to [npm](https://www.npmjs.com/package/walletscan-cli), [GitHub Packages](https://github.com/aaronjmars/walletscan/pkgs/npm/walletscan-cli) (as `@aaronjmars/walletscan-cli`) and [GitHub Releases](https://github.com/aaronjmars/walletscan/releases). To cut one, bump the version on main (`npm version patch --no-git-tag-version`, commit, push). The [publish workflow](.github/workflows/publish.yml) sees a version with no `vX.Y.Z` tag yet, runs the tests, publishes to npm through trusted publishing with provenance (no token stored) and to GitHub Packages, then tags the commit and writes the release notes.

## Credits

`stuck/` started as `stuck`, a standalone bridge checker (MIT). Airdrop lists come from rotki/data, lissstern/airdrop-db and the projects named in `airdrops/README.md`, downloaded at run time; some contract addresses were read from rotki's decoders. The old-contract index is Forgotten ETH's.

## License

MIT, see `LICENSE`.
