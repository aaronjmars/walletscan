// lists.mjs - what we know about each eligibility list, on top of what its source says.
//
// rotki/data (airdrops/index_v4.json) names its lists, files, token (CAIP id), claim page and cutoff; META below adds
// the claim contract(s) and fixes. A rotki list missing from META still gets indexed (status unknown until its
// cutoff passes). lissstern/airdrop-db has no index, so its lists are spelled out in full in LISS.
//
// Per list:
//   from     contracts the claimed tokens came from (0x0 = the claim mints): a transfer from one of them to the
//            wallet = claimed (Alchemy alchemy_getAssetTransfers). Found by matching list amounts to transfers.
//   raw      amounts in the file are in base units of this many decimals (else already in tokens)
//   until    claim window end (unix s); after it an unclaimed hit is expired
//   closed   window known to be over with no date in the source
//   open     still pays whatever the source cutoff says (no time check in the claim; only the funded check applies)
//   vesting  the claim went into a vesting contract, not the wallet: claimed = a vesting found in VESTING
//   share    the amount column is a share, not tokens (shown as null)
//   skip     not indexed (duplicate of another list, sent without a claim, or not EVM)
// Addresses lowercase. Dates checked onchain 2026-10-15 (claimPeriodEnds, redeemDeadline) or from rotki.

export const ROTKI = "https://raw.githubusercontent.com/rotki/data/develop/";
// lissstern/airdrop-db stopped in Feb 2024: pinned to its last commit, so the files never change under us
export const LISS = "https://raw.githubusercontent.com/lissstern/airdrop-db/6eb596e9cd47eaed50b82004078b40f79601dccc/";
const ZERO = "0x0000000000000000000000000000000000000000";

const OLD_UI = "the old claim page may be gone; the claim contract still pays: claim(index, account, amount, proof) with the proof from the project's published merkle tree";
export const META = {
  uniswap: { symbol: "UNI", note: OLD_UI, from: ["0x090d4613473dee047c3f2706764f49e0821d256e"] },
  "1inch": { symbol: "1INCH", note: OLD_UI, from: ["0xe295ad71242373c37c5fda7b57f26f9ea1088afe", "0x26aad2da94c59524ac0d93f6d6cbf9071d7086f2"] },
  tornado: { symbol: "TORN", raw: 18, from: ["0x3efa30704d2b8bbac821307230376556cf8cc39e"], until: 1639353600 }, // vTORN voucher expiresAt
  cornichon: { symbol: "CORN", raw: 18, from: ["0x8896c47cf854644cdc4dd949a11048a57bdba9bc"] },
  grain: { symbol: "GRAIN", raw: 18, from: ["0xee24de972295c20177e82bde34f64ca5c11958eb"] },
  furucombo: { symbol: "COMBO", from: ["0x4de2696924b430b601c6c84ecdc275729cd68825", "0x040bef6a2984ba28d8af8a24ddb51d61fbf08a81"] },
  lido: { symbol: "LDO", raw: 18, note: OLD_UI, from: ["0x4b3edb22952fb4a70140e39fb1add05a6b49622b"] },
  // shares of the 2020 early-user CRV, which vests in Curve's VestingEscrow: the real amount is read there (VESTING)
  curve: { symbol: "CRV", share: true, from: ["0x575ccd8e2d300e2377b43478339e364000318e2c"] },
  convex: { symbol: "CVX", note: OLD_UI, from: ["0x2e088a0a19dda628b4304301d1ea70b114e4accd"] },
  shapeshift: { symbol: "FOX", from: ["0x164d113f46676ca92d54537ac5af10ac20940b94"] },
  ens: { symbol: "ENS", from: ["0xc18360217d8f7ab5e7c516566761ea12ce7f9d72"], until: 1651622400 },
  psp: { symbol: "PSP", note: OLD_UI, from: ["0x090e53c44e8a9b6b1bca800e881455b921aec420"] },
  sdl: { symbol: "SDL", raw: 18, note: "vests in RetroactiveVesting: verifyAndClaimReward(account, totalAmount, proof) once, then claimReward(account)", from: ["0x5dca270671935cf3df78bd8373c22be250198a03"] },
  // vCOW claims closed 2022-03-25; a claimed vCOW not swapped to COW yet is checked in VESTING
  cow_mainnet: { symbol: "vCOW", raw: 18, from: [ZERO], until: 1648166400 },
  cow_gnosis: { symbol: "vCOW", raw: 18, from: [ZERO], until: 1648166400 },
  diva: { symbol: "DIVA", from: ["0x777e2b2cc7980a6bac92910b95269895eef0d2e8"] },
  shutter: { symbol: "SHU", vesting: "shutter" },
  starknet: { symbol: "STRK", note: "claimed on Starknet: status not checked" },
  optimism_4: { symbol: "OP", from: ["0xfb4d5a94b516df77fbdbcf3cfeb262baaf7d4db7"] },
  // rotki cutoff 2025-10-09, but clawBack() was never called and claim() has no time check: open until someone calls it
  optimism_5: { symbol: "OP", open: true, from: ["0x9a69d97a451643a0bb4462476942d2bc844431ce"] },
  degen2_season1: { symbol: "DEGEN", from: ["0x88d42b6dbc10d2494a0c6c189cefc7573a6dce62"] },
  degen2_season2: { symbol: "DEGEN", from: ["0xa2a5c549a454a1631ff226e0cf8dc4af03a61a75"] },
  degen2_season3: { symbol: "DEGEN", from: ["0x0bf676823f958d0ae6af9860880fc7a327a0c582"] },
  degen2_season4: { symbol: "DEGEN", from: ["0xf4c9fc64ed902b08c3397c48dca0342bdfd49a32"] },
  omni: { symbol: "OMNI", from: ["0xd0c155595929fd6be034c3848c00daebc6d330f6", "0xd2639676da3dea5491d27da19340556b3a7d58b8"] },
  myso: { symbol: "MYT", from: ["0x52528d0e3f50d4c3ee90de38f3d5ac5a402cbb83", "0x1cbd398c697b5461608195cc8413433504f39c7c"] },
  zk: { symbol: "ZK", from: [ZERO] },
  debridge_1: { symbol: "DBR", chain: "solana", closed: true, note: "claimed on Solana: status not checked" },
  // claims need a fresh signature from the Odos backend; the DAO set the last retro claim day to 2025-07-20
  odos: { symbol: "ODOS", from: ["0x4c8f8055d88705f52c9994969dde61ab574895a3"], until: 1753056000 },
  superfluid_s1: { symbol: "SUP", note: "SUP was streamed into a per-user FluidLocker, not the wallet: check claim.superfluid.org" },
  squill_airdrop_1: { symbol: "SQUILL", from: ["0x17a81c3c7fd664911f00415c4f72b4dfd552053f"] },
  squill_airdrop_2: { symbol: "SQUILL", from: ["0x4c3675ba47c8da8af5742dbb55635ed22c0d7617"] },
  squill_airdrop_3: { symbol: "SQUILL", from: ["0x812e75dc969369c23eff643c38ecfe43e48e2c36"] },
};

// lissstern lists worth indexing (skipped: uniswap, op4 and shutter-genesis repeat rotki; op3 was sent without a
// claim; starknet_* are Starknet-side; granary and odg have no claim contract we could pin)
export const LISS_LISTS = {
  arbitrum: { name: "Arbitrum", file: "arbitrum.csv", hash: "3b11a17a08503f380cdf173ee3627ad5a2012939", chainId: 42161, token: "0x912ce59144191c1204e64559fe8253a0e49e6548", symbol: "ARB", amountCol: "_claimableAmount", from: ["0x67a24ce4321ab3af51c2d0a4801c3e111d88c9d9"], until: 1695513600, url: "https://arbitrum.foundation" },
  connext: { name: "Connext", file: "connext.csv", hash: "3cf2deb205c08579a9b3f4124ad7e966d54459b7", chainId: 42161, token: "0x58b9cb810a68a7f3e1e4f8cb45d1b9b3c79705e8", symbol: "NEXT", from: ["0xe6b7ab9ebcfbf1a72e489ff00cdf9c6473ff6224", "0xee9dec2712cce65174b561151701bf54b99c24c8"], closed: true, url: "https://airdrop.connext.network" },
  hop: { name: "Hop", file: "hop-airdrop.txt", hash: "d4e52cf238a76388ca8daec50fe7c4b01e823e95", chainId: 1, token: "0xc5102fe9359fd9a28f877a67e36b0f050d81a3cc", symbol: "HOP", from: ["0xc5102fe9359fd9a28f877a67e36b0f050d81a3cc"], open: true, note: "claimPeriodEnds (2022-12-09) only gates sweep(): claimTokens still pays while the token holds HOP", url: "https://app.hop.exchange/#/airdrop" },
  optimism_1: { name: "Optimism airdrop 1", file: "op_1.csv", hash: "6ebf4aa28a7677f7859d852d714aa05c7d98dbfd", chainId: 10, token: "0x4200000000000000000000000000000000000042", symbol: "OP", amountCol: "total_op_eligible_to_claim", raw: 18, from: ["0xfedfaf1a10335448b7fa0268f56d2b44dbd357de", "0x2501c477d0a35545a387aa4a3eee4292a9a8b3f0"], closed: true, note: "unclaimed amounts were sent to wallets by the OP Foundation in Sept 2023", url: "https://app.optimism.io/airdrops/1" },
  safe: { name: "Safe", file: "safe.txt", hash: "51afe1b0ad1216439eed85e6cfa93381112c6b64", chainId: 1, token: "0x5afe3855358e112b5647b952709e6165e1c1eeee", symbol: "SAFE", vesting: "safe", until: 1672135200, url: "https://app.safe.global" },
};

// Other open lists of airdrops that still pay (code has no deadline, tokens still in the distributor, 2026-10-15),
// pinned to a commit. format "pairs": "address": "0x..", then "earnings": "0x<hex wei>" | ether(n) (JSON lines or a
// .ts array). Both distributors are plain Uniswap MerkleDistributors.
export const EXTRA_LISTS = {
  pooltogether: { name: "PoolTogether POOL", url: "https://raw.githubusercontent.com/pooltogether/merkle-distributor/b76e34344ae1ce8065e37461ec3f537e7ce065b1/bq-results-20210202-094742-fvr9ifm390n3.json", hash: "b76e343", format: "pairs", license: "GPL-3.0", chainId: 1, token: "0x0cec1a9154ff802e7934fc916ed7ca50bde6844e", symbol: "POOL", from: ["0xbe1a33519f586a4c8aa37525163df8d67997016f"], note: OLD_UI, link: "https://github.com/pooltogether/merkle-distributor" },
  // dYdX retroactive mining + trading/LP rewards: the final tree (epoch 31) is the IPFS file whose CID getActiveRoot()
  // returns. Amounts are cumulative; the claim pays amount - getClaimed(wallet), out of the rewards treasury.
  dydx: { name: "dYdX rewards (retroactive + trading, final epoch 31)", source: "dydx onchain", url: "https://gateway.pinata.cloud/ipfs/bafybeigjgruvsgkgjvotsqwotfltqmmezzzbvsrm6gslxoqsv4xbh2ajrm", hash: "bafybeigjgruvsgkgjvotsqwotfltqmmezzzbvsrm6gslxoqsv4xbh2ajrm", format: "array", raw: 18, chainId: 1, token: "0x92d6c1e31e14520e676a687f0a93788b716beff5", symbol: "DYDX", cumulative: "0x01d3348601968ab85b4bb028979006eac235a588", funds: "0x639192d54431f8c816368d3fb4107bc168d0e871", note: "claimRewards(cumulativeAmount, merkleProof) on the MerkleDistributorV1 0x01d33486...; the proof comes from the published tree (IPFS bafybeigjgru...); no deadline", link: "https://etherscan.io/address/0x01d3348601968ab85b4bb028979006eac235a588#writeProxyContract" },
  index_coop: { name: "Index Coop INDEX", url: "https://raw.githubusercontent.com/SetProtocol/index-coop/d3267e84723f1c57dff64ed8ae0b01d0f350f147/utils/deploys/merkleDistribution.ts", hash: "d3267e8", format: "pairs", license: "Apache-2.0", chainId: 1, token: "0x0954906da0bf32d5479e25f46056d22f08464cab", symbol: "INDEX", from: ["0xdd111f0fc07f4d89ed6ff96dbab19a61450b8435"], note: OLD_UI, link: "https://github.com/SetProtocol/index-coop" },
};

// Sablier Merkle campaigns (airdrops and vesting claims made with Sablier's app): listed from its indexer at each
// warm(), one list per campaign still open (not clawed back, not expired) with real claims, built from the IPFS
// file (immutable, so the CID is the hash). Claimed = a Claim action by the wallet in the indexer.
export const SABLIER = {
  indexer: "https://indexer.hyperindex.xyz/508d217/v1/graphql",
  ipfs: "https://gateway.pinata.cloud/ipfs/",
  minClaims: 10, // fewer real claims than this = a test or a dead campaign
  testnets: [11155111, 84532, 421614, 11155420, 80002, 17000, 97, 43113, 10143],
  app: (id) => `https://app.sablier.com/airdrops/campaign/${id}`,
};

// Airdrops paid into a vesting contract the wallet owns: checked for every wallet (one log query each), since
// a claim made long ago can leave vested tokens nobody withdrew.
//   safe-style: the airdrop contract is the vesting pool; AddedVesting(id, account) names the wallet's vesting
//   shutter-style: RedeemedVesting(id, user) on the airdrop; the vesting sits in a per-user VestingPool created
//     in the same tx (its AddedVesting(id) log says which); both pools answer calculateVestedAmount(id)
//   escrow: Curve VestingEscrow, balanceOf(wallet) = vested and not claimed
//   vcow: CoW's vCOW (vested 4 years from 2022-02-11), swappableBalanceOf(wallet) = vCOW that swapAll() turns into COW now
//     (priced as COW: `price` is the token to price)
export const VESTING = {
  safe: { name: "Safe (SAFE) airdrop vesting", chainId: 1, token: "0x5afe3855358e112b5647b952709e6165e1c1eeee", symbol: "SAFE", decimals: 18, kind: "safe", contracts: ["0xa0b937d5c8e32a80e3a8ed4227cd020221544ee6", "0x29067f28306419923bcff96e37f95e0f58abdbbe"], url: "https://app.safe.global", how: "claimVestedTokens(vestingId, beneficiary, amount) on the airdrop contract, sent by the vesting account (claimVestedTokensViaModule from a Safe; Safe{Wallet} shows it)" },
  shutter: { name: "Shutter (SHU) airdrop vesting", chainId: 1, token: "0xe485e2f1bab389c08721b291f6b59780fec83fd7", symbol: "SHU", decimals: 18, kind: "shutter", contracts: ["0x024574c4c42c72dfaaa3cca80f73521a4ef5ca94"], url: "https://claim.shutter.network", how: "claimVestedTokens(vestingId, beneficiary, amount) on your VestingPool, sent by its owner" },
  curve: { name: "Curve (CRV) early-user vesting", chainId: 1, token: "0xd533a949740bb3306d119cc777fa900ba034cd52", symbol: "CRV", decimals: 18, kind: "escrow", contracts: ["0x575ccd8e2d300e2377b43478339e364000318e2c"], url: "https://etherscan.io/address/0x575ccd8e2d300e2377b43478339e364000318e2c#writeContract", how: "claim(addr) on the VestingEscrow (anyone can send it, tokens go to addr)" },
  cow: { name: "CoW (vCOW) airdrop, not swapped to COW", chainId: 1, token: "0xd057b63f5e69cf1b929b356b579cba08d7688048", price: "0xdef1ca1fb7fbcdc777520aa7f396b4e015f497ab", symbol: "vCOW", decimals: 18, kind: "vcow", contracts: ["0xd057b63f5e69cf1b929b356b579cba08d7688048"], url: "https://swap.cow.fi/#/1/account", how: "swapAll() on the vCOW contract turns it into COW 1:1" },
  cow_gnosis: { name: "CoW (vCOW, Gnosis) airdrop, not swapped to COW", chainId: 100, token: "0xc20c9c13e853fc64d054b73ff21d3636b2d97eab", price: "0x177127622c4a00f3d409b75571e12cb3c8973d3c", symbol: "vCOW", decimals: 18, kind: "vcow", contracts: ["0xc20c9c13e853fc64d054b73ff21d3636b2d97eab"], url: "https://swap.cow.fi/#/100/account", how: "swapAll() on the vCOW contract (Gnosis) turns it into COW 1:1" },
};

// Alchemy network, DefiLlama chain key and walletscan chain name per chain id
export const NETS = {
  1: { net: "eth-mainnet", llama: "ethereum", name: "ethereum" }, 10: { net: "opt-mainnet", llama: "optimism", name: "optimism" },
  100: { net: "gnosis-mainnet", llama: "xdai", name: "gnosis" }, 137: { net: "polygon-mainnet", llama: "polygon", name: "polygon" },
  324: { net: "zksync-mainnet", llama: "era", name: "zksync" }, 8453: { net: "base-mainnet", llama: "base", name: "base" },
  42161: { net: "arb-mainnet", llama: "arbitrum", name: "arbitrum" },
  // no Alchemy reads needed (Sablier campaigns: claims come from its indexer), only prices and names
  56: { llama: "bsc", name: "bsc" }, 130: { llama: "unichain", name: "unichain" }, 146: { llama: "sonic", name: "sonic" }, 999: { llama: "hyperliquid", name: "hyperevm" },
  1868: { llama: "soneium", name: "soneium" }, 5000: { llama: "mantle", name: "mantle" }, 43114: { llama: "avax", name: "avalanche" }, 59144: { llama: "linea", name: "linea" },
  80094: { llama: "berachain", name: "berachain" }, 534352: { llama: "scroll", name: "scroll" }, 2741: { llama: "abstract", name: "abstract" }, 252: { llama: "fraxtal", name: "fraxtal" },
  480: { llama: "wc", name: "worldchain" },
};
