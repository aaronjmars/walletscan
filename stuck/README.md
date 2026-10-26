# stuck

Find bridge withdrawals that were never claimed. Many bridges need one last step on the destination chain (prove, finalize, claim, redeem). If nobody does it, the funds just sit there.

`stuck` checks a wallet across 32 bridges and tells you what is still waiting, how much it is worth, and how to claim it. It is read-only: no wallet connection, no signing, no transactions. Where possible the claim itself is simulated with `eth_call`, so "claimable" means the claim would actually go through right now.

## Setup

Needs Node 20+ and an [Alchemy](https://www.alchemy.com) key with the chains below enabled.

```sh
npm install
echo "ALCHEMY_KEY=..." > .env     # or ALCHEMY_PASS_ENTRY=<entry> to read it from pass; .env is gitignored
```

## Usage

Check one or more wallets on every bridge (a few seconds per wallet):

```sh
./stuck check 0xWALLET
./stuck check 0xWALLET1 0xWALLET2 --file wallets.txt
./stuck check 0xWALLET --bridges base,cctp,wormhole   # only some bridges
./stuck check 0xWALLET --min-usd 5                    # hide priced dust
./stuck check 0xWALLET --all                          # also show claimed and still-waiting items
./stuck check 0xWALLET --json                         # machine output (includes claim data where available)
```

Scan a whole bridge for anyone's stuck withdrawals in a block window:

```sh
./stuck scan base --days 30
./stuck scan zksync --from 72000000 --to 72300000
./stuck scan ronin --days 365 --min-usd 100 --min-age 7
```

`scan` works on the OP Stack chains, Arbitrum, Linea, zkSync, Gnosis, Ronin and Starknet.

## Statuses

| Status | Meaning |
|---|---|
| `claimable`, `ready-to-prove`, `ready-to-finalize` | The owner can claim it now. The output says where and how. |
| `blocked` | Stuck until the bridge team acts (expired signatures, disabled exits, old validator set). |
| `waiting` | Still inside the normal bridge delay. |
| `claimed` | Done. Shown with `--all`. |
| `unknown` | Could not be verified on-chain; the detail line says why. |

USD values are estimates from Alchemy Prices. Tokens without a price show as `$?` and count as $0 in totals.

## Bridges

| Key | Bridge | How it checks |
|---|---|---|
| `base` `optimism` `zora` `ink` `unichain` `soneium` `worldchain` `shape` `blast` `mode` `bob` `dbk` | OP Stack | Withdrawal status via the OptimismPortal (viem op-stack). OP Mainnet includes pre-Bedrock withdrawals that bridge apps no longer show. Mode, BOB and DBK Chain are searched on their public RPCs (Alchemy caps their log ranges; DBK is not on Alchemy). |
| `arbitrum` | Arbitrum One (Nitro) | `Outbox.isSpent`; ready once past the challenge window. |
| `polygon` | Polygon PoS | Exit payload from Polygon's proof API, then `RootChainManager.exit` simulated. |
| `linea` | Linea | Message status on LineaRollup (legacy and merkle-proof messages). |
| `zksync` | ZKsync Era | L2 to L1 log proof, then `isWithdrawalFinalized` on L1. |
| `scroll` | Scroll | Scroll bridge API (unclaimed withdrawals). |
| `cctp` | Circle CCTP v1 and v2 | Iris attestation, destination used nonces, `receiveMessage` simulated (EVM and Solana). |
| `wormhole` `wormhole-ntt` | Wormhole Token Bridge and NTT | Wormholescan operations, redeem simulated on EVM, claim accounts read on Solana. |
| `debridge` | deBridge DLN | Unfilled or cancelled-but-unrefunded orders, confirmed on DlnSource / DlnDestination. |
| `gnosis` | Gnosis OmniBridge and xDai bridge | Validator signatures from Gnosis, `executeSignatures` simulated on Ethereum. |
| `starknet` | StarkGate (35 L1 bridges) | Unconsumed L2 to L1 messages, `withdraw` simulated on Ethereum. |
| `starkex` | StarkEx apps (dYdX v3, Immutable X, Sorare, rhino.fi, edgeX, ApeX, Myria, tanX, Reddio and more) | Pending withdrawal balances per Stark key, `withdraw` simulated. |
| `ronin` | Ronin Bridge | Operator signatures from Ronin, `submitWithdrawal` simulated on Ethereum. Includes pre-2022 withdrawals migrated to the new gateway. |
| `sui` | Sui Bridge | Committee approval from the Sui bridge record, claim simulated on Ethereum. |
| `mantle` | Mantle (OP Stack fork) | A wallet's bridge logs from Routescan's logs API (Etherscan v2 with `ETHERSCAN_API_KEY` as fallback); the portal read directly (Mantle's withdrawal hash adds MNT and ETH values). Includes Mantle v1 withdrawals from before the 2024-03-15 upgrade: the upgrade stored them in the new message passer, so they are proven and finalized on today's portal. |
| `manta` | Manta Pacific (OP Stack) | Every Manta Pacific withdrawal indexed from the public RPC (it caps log ranges at 100k blocks); prove / finalize checked on the portal and its L2OutputOracle. |
| `opbnb` | opBNB (OP Stack on BNB Chain) | A wallet's withdrawals from NodeReal's opBNB explorer API (what the opBNB bridge app lists, keyless), read back on the public RPC; prove / finalize checked on the BNB Chain portal and its L2OutputOracle. BNB withdrawals pay BNB; claimed on BNB Chain. |
| `taiko` | Taiko Alethia (Taiko's signal service bridge) | A wallet's messages from Taiko's relayer API (keyless), decoded from the raw L2 log (ETH and ERC20Vault tokens); `messageStatus` on the L1 Bridge, then a storage proof of the signal against the latest checkpoint the L1 SignalService holds, and `processMessage` simulated. A failed message is recalled on Taiko. |
| `morph` | Morph (Morph's rollup bridge) | A wallet's withdrawals from Morph's bridge indexer (keyless); the message rebuilt from the L2 receipt, `finalizedWithdrawals` on the L1 messenger, the indexer's Merkle proof checked against a finalized withdrawal root, and `proveAndRelayMessage` simulated. |
| `lisk` | Lisk (OP Stack) | Every Lisk withdrawal indexed from the public RPC; prove / finalize checked on the portal and its dispute game (Lisk's games predate the calls viem uses). Lisk shuts down on 2026-10-31: unproven withdrawals carry that deadline. |

Built-in bridges live in `core.mjs` (`stuck.mjs` is the CLI over it, `index.mjs` the library, see PORT.md). The others are modules in `bridges/`: each default-exports one bridge object (or an array) with `key`, `name`, `find(user, range)` and `status(item)`. Shared helpers are in `lib.mjs`. Drop a new file in `bridges/` and it is picked up automatically.

## Cache

`starknet`, `ronin`, `sui`, `lisk` and `manta` keep an index under `.cache/` (or `STUCK_CACHE_DIR`) because their recipients are not searchable on-chain. The first run builds it (15 seconds to about 2.5 minutes, with progress on stderr); later runs only fetch new blocks and take about a second. Delete `.cache/` to rebuild from scratch.

## Known gaps

- Only EVM (`0x`) wallets can be searched. Transfers from those wallets to Solana and other chains are still found.
- CCTP: burns that start on Sonic, Plasma, Cronos or X Layer are not found; mints on Noble, Sui and Aptos show `unknown`.
- deBridge: orders created from Solana or Tron are not found.
- Wormhole: Sui, Aptos and NEAR destinations fall back to Wormholescan's status (`unknown`).
- Mantle: a withdrawal sent to the wallet by someone else (e.g. a fee vault paying out) is not found, only those it started. Karak K2 is not covered: its portal now only pays by Merkle claim.
- Arbitrum: readiness uses the challenge window age, and pre-Nitro (classic) withdrawals are not covered. Polygon: Plasma (POL/MATIC) exits are not covered.

## Claiming safely

Always claim with your own wallet through the bridge's official app or contract, and check contract addresses against the bridge's docs or L2BEAT. Never share a seed phrase or private key, and never sign a token approval to "unlock" funds.

## License

MIT, Aaron Elijah Mars
