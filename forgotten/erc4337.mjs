// forgotten/erc4337.mjs - ERC-4337 smart accounts an EOA owns (factories read 2026-10-20 from permissionless 0.5,
// @zerodev/sdk 5.5, @account-kit/smart-contracts 4.88, @biconomy/sdk and viem, each checked onchain on the 6 chains;
// salts and init data checked 2026-10-22 against the creation calls of real accounts, see test/batch-g.test.mjs):
// embedded-wallet apps (Privy, Dynamic, thirdweb, Alchemy Account Kit...) keep the money in one of these, owned by the
// app's EOA. Two ways in, both keyed by the owner alone:
// 1. derived: each factory's own view (or CREATE2 here, for Safe) gives the counterfactual address for (owner, salt 0,
//    or the Safe SDK's default salt), one Multicall3 per chain. This is the only way to see an account that is
//    not deployed yet.
// 2. logs: many apps pick a random salt (most sampled LightAccount v2 and Kernel v3.3 accounts), so one eth_getLogs over
//    the whole chain (evm.alchemy_rpc) finds the setup events that name this owner: LightAccount / SimpleAccount
//    initialized, Kernel's ECDSA validator OwnerRegistered, and the account-created events of the Nexus, Modular
//    Account v2 and thirdweb factories. An event the account emits itself (or a validator that any contract can call)
//    counts only once the EntryPoint's AccountDeployed log names one of our factories for it.
// A second Multicall3 reads code, ownership, native balance and a few big tokens of every candidate.
// A deployed account counts only when its owner read names this address (owner(), isOwnerAddress, isAdmin, getOwners,
// the ECDSA validator's storage plus the account's own root validator, or the ECDSA signer of a Kernel permission root);
// a deployed one that names someone else is dropped, one we cannot read is a hint. An undeployed one with money is the
// owner's too: its address is the factory's CREATE2 of an init that sets this owner, so the first transaction from it
// deploys it with this owner.
import { encodeFunctionData, encodeAbiParameters, encodePacked, parseAbi, parseAbiParameters, pad, concatHex, keccak256, toHex, getContractAddress } from "viem";
import { multi, rpcCall, MULTICALL3, ZERO, topicAddr } from "./evm.mjs";

export const AA_CHAINS = ["ethereum", "base", "arbitrum", "optimism", "polygon", "bsc"];
const CHAIN_ID = { ethereum: 1, base: 8453, arbitrum: 42161, optimism: 10, polygon: 137, bsc: 56 };
const ALCHEMY_NET = { ethereum: "eth-mainnet", base: "base-mainnet", arbitrum: "arb-mainnet", optimism: "opt-mainnet", polygon: "polygon-mainnet", bsc: "bnb-mainnet" };
// salt 0 only: every sampled deploy used 0 or a random salt (78 of 80 Coinbase, 40 of 40 Biconomy v2, all SimpleAccount,
// Kernel and Modular Account v2 ones on Base, 2026-10-22), never 1; random salts come back through the logs
const SALTS = [0n];
// Kernel ECDSA validators: v2.0-2.1 accounts all use 0x417f... (every sampled one, 2026-10-22), v2.2+ 0xd9AB...
const K20_VALIDATOR = "0x417f5a41305DDc99D18B5E176521b468b2a31B86", K2_VALIDATOR = "0xd9AB5096a832b9ce79914329DAEE236f8Eea0390", K30_VALIDATOR = "0x8104e3Ad430EA6d354d013A6789fDFc71E671c43", K31_VALIDATOR = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57";
// ZeroDev's FactoryStaker deploys most Kernels (deployWithFactory on approved Kernel factories): AccountDeployed names it
const KERNEL_STAKER = "0xd703aaE79538628d27099B8c4f621bE4CCd142d5";
// a Kernel v3 root can be a permission (0x02 + id) whose signer is ZeroDev's ECDSASigner: 75 of 79 sampled Base v3.1
// accounts move their root there right after deploying, with the same owner as signer
const ECDSA_SIGNER = "0x6A6F069E2a08c2468e7724Ab3250CdBFBA14D4FF";
const BICO_MODULE = "0x0000001c5b32F37F5beA87BDD5374eB2aC54eA8e", NEXUS_K1 = "0x0000002D6DB27c52E3C11c1Cf24072004AC75cBa", NEXUS_FACTORY = "0x00000024115AA990F0bAE0B6b0D5B8F68b684cd6";
// attesters the Biconomy SDK passes to the Nexus K1 factory (seen on Arbitrum and Ethereum accounts, 2026-10-22)
const RHINESTONE_ATTESTER = "0x000000333034E9f539ce08819E12c1b8Cb29084d", BICO_ATTESTER_A = "0xDE8FD2dBcC0CA847d11599AF5964fe2AEa153699", BICO_ATTESTER_B = "0xF9ff902Cdde729b47A4cDB55EF16DF3683a04EAB";
// Biconomy MEE v2.1.0 (abstractjs DEFAULT_CONFIGURATIONS_BY_MEE_VERSION): the factory, its bootstrap and the default K1
// validator that holds the owner
const MEE21_FACTORY = "0x0000006648ED9B2B842552BE63Af870bC74af837", MEE21_BOOT = "0x0000003eDf18913c01cBc482C978bBD3D6E8ffA3", MEE21_K1 = "0x0000000031ef4155C978d48a8A7d4EDba03b04fE";
// Alchemy Modular Account v1 (MultiOwnerModularAccountFactory + MultiOwnerPlugin) and v2 (semi-modular accounts)
const MA1_PLUGIN = "0xcE0000007B008F50d762D155002600004cD6c647", MA2_FACTORY = "0x00000000000017c61b5bEe81050EC8eFc9c6fecd";
const THIRDWEB = ["0x85e23b94e7F5E9cC1fF78BCe78cfb15B81f0DF00", "0x4bE0ddfebcA9A5A4a617dee4DeCe99E7c862dceb"];
const EP = ["0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789", "0x0000000071727De22E5E9d8BAf0edAc6f37da032", "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108"];
const K2_INIT = parseAbi(["function initialize(address _defaultValidator, bytes _data)"]);
const K30_INIT = parseAbi(["function initialize(bytes21 _rootValidator, address hook, bytes validatorData, bytes hookData)"]);
const K31_INIT = parseAbi(["function initialize(bytes21 _rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)"]);
const BICO_SETUP = parseAbi(["function initForSmartAccount(address eoaOwner)"]);
const MEE_BOOT = parseAbi(["struct C { address module; bytes data; }", "struct P { uint256 hookType; address module; bytes data; }", "function initNexusWithDefaultValidatorAndOtherModulesNoRegistry(bytes defaultValidatorInitData, C[] validators, C[] executors, C hook, C[] fallbacks, P[] preValidationHooks)"]);
const OWNER = ["function owner() view returns (address)"];
const ECDSA_STORE = ["function ecdsaValidatorStorage(address) view returns (address)"];
const k3root = (v) => concatHex(["0x01", v]);
const same = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const ev = (sig) => keccak256(toHex(sig));
const LIGHT_INIT = ev("LightAccountInitialized(address,address)"), SIMPLE_INIT = ev("SimpleAccountInitialized(address,address)"), OWNER_REGISTERED = ev("OwnerRegistered(address,address)");
const NEXUS_CREATED = ev("AccountCreated(address,address,uint256)"), SMA_CREATED = ev("SemiModularAccountDeployed(address,address,uint256)"), THIRDWEB_CREATED = ev("AccountCreated(address,address)");
const ACCOUNT_DEPLOYED = ev("AccountDeployed(bytes32,address,address,address)");

// Safe 4337: SafeProxyFactory 1.4.1 CREATE2, keccak256(proxyCreationCode ++ uint256(singleton)) per singleton, and the
// Safe SDK's default salt (protocol-kit getChainSpecificDefaultSaltNonce); setups as sent by the Safe SDK's
// Safe4337Pack (SafeL2, SafeModuleSetup.enableModules, 4337 module 0.3.0) and permissionless (Safe, MultiSend)
const SAFE_FACTORY = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67", SAFE_L2 = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762", SAFE_L1 = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
const SAFE_CODE_HASH = { [SAFE_L2]: "0xe298282cefe913ab5d282047161268a8222e4bd4ed106300c547894bbefd31ee", [SAFE_L1]: "0x76733d705f71b79841c0ee960a0ca880f779cde7ef446c989e6d23efc0a4adfb" };
const SAFE_SDK_SALT = (chain) => BigInt(keccak256(toHex(`0xb1073742015cbcf5a3a4d9d1ae33ecf619439710b89475f92e2abd2117e90f90${CHAIN_ID[chain]}`)));
const SAFE_MODULE_SETUP_030 = "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47", SAFE_4337_030 = "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226";
const SAFE_MODULE_SETUP_020 = "0x8EcD4ec46D4D2a6B64fE960B3D64e8B94B2234eb", SAFE_4337_020 = "0xa581c4A4DB7175302464fF3C06380BC3270b4037";
const SAFE_MULTISEND = "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526";
const SAFE_SETUP = parseAbi(["function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)"]);
const enableModule = (m) => encodeFunctionData({ abi: parseAbi(["function enableModules(address[] modules)"]), functionName: "enableModules", args: [[m]] });
const viaMultiSend = (to, data) => encodeFunctionData({ abi: parseAbi(["function multiSend(bytes transactions)"]), functionName: "multiSend", args: [encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [1, to, 0n, BigInt((data.length - 2) / 2), data])] });
const safeAddress = (singleton, to, data, module) => (o, salt) => {
  const init = encodeFunctionData({ abi: SAFE_SETUP, functionName: "setup", args: [[o], 1n, to, data, module, ZERO, 0n, ZERO] });
  return getContractAddress({ opcode: "CREATE2", from: SAFE_FACTORY, salt: keccak256(encodePacked(["bytes32", "uint256"], [keccak256(init), salt])), bytecodeHash: SAFE_CODE_HASH[singleton] });
};
const meeInit = (boot, o) => encodeAbiParameters(parseAbiParameters("address, bytes"), [boot, encodeFunctionData({ abi: MEE_BOOT, functionName: "initNexusWithDefaultValidatorAndOtherModulesNoRegistry", args: [o, [], [], { module: ZERO, data: pad("0x0") }, [], []] })]);

// kind = what the user sees; app = where its owner usually manages it; probe = a view on the account itself (answers only
// when deployed) that also says whether this owner controls it; via = a second read on a validator / module (viaMine
// says whether it names this owner: true, false, or why it is only a hint); local = the address computed here instead
// of a factory view; log = the setup event that names the owner (from = its emitter when that is not the account)
export const ACCOUNTS = [
  ...[["v1", "0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a"], ["v1.1", "0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842"]].map(([version, factory]) => ({
    kind: "Coinbase Smart Wallet", version, factory, app: "https://wallet.coinbase.com",
    address: (o, s) => ({ abi: ["function getAddress(bytes[] owners, uint256 nonce) view returns (address)"], fn: "getAddress", args: [[pad(o)], s] }),
    probe: (o) => ({ abi: ["function isOwnerAddress(address) view returns (bool)"], fn: "isOwnerAddress", args: [o] }), mine: (r) => r === true,
  })),
  ...[["v1.0.1", "0x000000893A26168158fbeaDD9335Be5bC96592E2"], ["v1.0.2", "0x00000055C0b4fA41dde26A74435ff03692292FBD"], ["v1.1.0", "0x00004EC70002a32400f8ae005A26081065620D20"], ["v2.0.0", "0x0000000000400CdFef5E2714E63d8040b700BC24"]].map(([version, factory]) => ({
    kind: "Alchemy LightAccount", version, factory, log: { topic: LIGHT_INIT },
    address: (o, s) => ({ abi: ["function getAddress(address owner, uint256 salt) view returns (address)"], fn: "getAddress", args: [o, s] }),
    probe: () => ({ abi: OWNER, fn: "owner" }), mine: (r, o) => same(r, o),
  })),
  ...[["v0.6", "0x9406Cc6185a346906296840746125a0E44976454"], ["v0.7", "0x91E60e0613810449d098b0b5Ec8b51A0FE8c8985"], ["v0.8", "0x13E9ed32155810FDbd067D4522C492D6f68E5944"]].map(([version, factory]) => ({
    kind: "SimpleAccount", version, factory, log: { topic: SIMPLE_INIT },
    address: (o, s) => ({ abi: ["function getAddress(address owner, uint256 salt) view returns (address)"], fn: "getAddress", args: [o, s] }),
    probe: () => ({ abi: OWNER, fn: "owner" }), mine: (r, o) => same(r, o),
  })),
  // thirdweb's SDK passes the account salt as bytes, empty by default: one address per owner
  ...[["v0.6", THIRDWEB[0]], ["v0.7", THIRDWEB[1]]].map(([version, factory]) => ({
    kind: "thirdweb", version, factory, log: { topic: THIRDWEB_CREATED, from: factory },
    address: (o) => ({ abi: ["function getAddress(address _adminSigner, bytes _data) view returns (address)"], fn: "getAddress", args: [o, "0x"] }),
    probe: (o) => ({ abi: ["function isAdmin(address) view returns (bool)"], fn: "isAdmin", args: [o] }), mine: (r) => r === true,
  })),
  // Kernel v2: the ECDSA validator holds the owner, the account names its default validator
  ...[["v2.0-2.1", "0xaee9762ce625e0a8f7b184670fb57c37bfe1d0f1", K20_VALIDATOR], ["v2.2-2.4", "0x5de4839a76cf55d0c90e2061ef4386d962E15ae3", K2_VALIDATOR]].map(([version, factory, v]) => ({
    kind: "ZeroDev Kernel", version, factory, validator: v, log: { topic: OWNER_REGISTERED, from: v },
    address: version === "v2.0-2.1"
      ? (o, s) => ({ abi: ["function getAccountAddress(address _validator, bytes _data, uint256 _index) view returns (address)"], fn: "getAccountAddress", args: [v, o, s] })
      : (o, s) => ({ abi: ["function getAccountAddress(bytes _data, uint256 _index) view returns (address)"], fn: "getAccountAddress", args: [encodeFunctionData({ abi: K2_INIT, functionName: "initialize", args: [v, o] }), s] }),
    probe: () => ({ abi: ["function getDefaultValidator() view returns (address)"], fn: "getDefaultValidator" }), mine: (r) => same(r, v),
    via: (w) => ({ to: v, abi: ECDSA_STORE, fn: "ecdsaValidatorStorage", args: [w] }),
  })),
  // Kernel v3: the root validator is 0x01 + the ECDSA validator (or a permission, see ECDSA_SIGNER); v3.0 has its own
  // validator and a 4-argument initialize
  ...[["v3.0", "0x6723b44Abeec4E71eBE3232BD5B455805baDD22f", K30_VALIDATOR], ["v3.1", "0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419", K31_VALIDATOR], ["v3.2", "0x7a1dBAB750f12a90EB1B60D2Ae3aD17D4D81EfFe", K31_VALIDATOR], ["v3.3", "0x2577507b78c2008Ff367261CB6285d44ba5eF2E9", K31_VALIDATOR]].map(([version, factory, v]) => ({
    kind: "ZeroDev Kernel", version, factory, validator: v, staked: true, permission: true, log: { topic: OWNER_REGISTERED, from: v },
    address: (o, s) => ({ abi: ["function getAddress(bytes data, bytes32 salt) view returns (address)"], fn: "getAddress", args: [version === "v3.0"
      ? encodeFunctionData({ abi: K30_INIT, functionName: "initialize", args: [k3root(v), ZERO, o, "0x"] })
      : encodeFunctionData({ abi: K31_INIT, functionName: "initialize", args: [k3root(v), ZERO, o, "0x", []] }), pad(toHex(s))] }),
    probe: () => ({ abi: ["function rootValidator() view returns (bytes21)"], fn: "rootValidator" }), mine: (r) => same(r, k3root(v)),
    via: (w) => ({ to: v, abi: ECDSA_STORE, fn: "ecdsaValidatorStorage", args: [w] }),
  })),
  { kind: "Biconomy", version: "v2", factory: "0x000000a56Aaca3e9a4C479ea6b6CD0DbcB6634F5",
    address: (o, s) => ({ abi: ["function getAddressForCounterFactualAccount(address moduleSetupContract, bytes moduleSetupData, uint256 index) view returns (address)"], fn: "getAddressForCounterFactualAccount", args: [BICO_MODULE, encodeFunctionData({ abi: BICO_SETUP, functionName: "initForSmartAccount", args: [o] }), s] }),
    probe: () => ({ abi: ["function isModuleEnabled(address module) view returns (bool)"], fn: "isModuleEnabled", args: [BICO_MODULE] }), mine: (r) => r === true,
    via: (w) => ({ to: BICO_MODULE, abi: ["function getOwner(address smartAccount) view returns (address)"], fn: "getOwner", args: [w] }) },
  // Nexus through the K1 validator factory: Biconomy's SDK passes the Rhinestone attester, newer SDKs Rhinestone plus one
  // of Biconomy's (threshold 1). No attesters (permissionless) was dropped: none of the ~6,200 accounts this factory made
  // on the 6 chains uses it (2026-10-22). The factory's AccountCreated names the owner for any of them, at any index
  ...[["Nexus (attested)", [RHINESTONE_ATTESTER], 1], ["Nexus (attested)", [RHINESTONE_ATTESTER, BICO_ATTESTER_A], 1], ["Nexus (attested)", [RHINESTONE_ATTESTER, BICO_ATTESTER_B], 1]].map(([version, att, th]) => ({
    kind: "Biconomy", version, factory: NEXUS_FACTORY, log: { topic: NEXUS_CREATED, from: NEXUS_FACTORY },
    address: (o, s) => ({ abi: ["function computeAccountAddress(address eoaOwner, uint256 index, address[] attesters, uint8 threshold) view returns (address)"], fn: "computeAccountAddress", args: [o, s, att, th] }),
    probe: () => ({ abi: ["function isModuleInstalled(uint256 moduleTypeId, address module, bytes additionalContext) view returns (bool)"], fn: "isModuleInstalled", args: [1n, NEXUS_K1, "0x"] }), mine: (r) => r === true,
    via: (w) => ({ to: NEXUS_K1, abi: ["function smartAccountOwners(address) view returns (address)"], fn: "smartAccountOwners", args: [w] }),
  })),
  // Biconomy MEE v2.1.0 (Nexus 1.2.0): the bootstrap installs the owner on the account's default K1 validator; index 0
  { kind: "Biconomy", version: "Nexus MEE v2.1.0", factory: MEE21_FACTORY,
    address: (o, s) => ({ abi: ["function computeAccountAddress(bytes initData, bytes32 salt) view returns (address)"], fn: "computeAccountAddress", args: [meeInit(MEE21_BOOT, o), pad(toHex(s))] }),
    probe: () => ({ abi: ["function accountId() view returns (string)"], fn: "accountId" }), mine: (r) => typeof r === "string" && r.startsWith("biconomy.nexus."),
    via: (w) => ({ to: MEE21_K1, abi: ["function getOwner(address smartAccount) view returns (address)"], fn: "getOwner", args: [w] }) },
  { kind: "Alchemy Modular Account", version: "v1", factory: "0x000000e92D78D90000007F0082006FDA09BD5f11",
    address: (o, s) => ({ abi: ["function getAddress(uint256 salt, address[] owners) view returns (address)"], fn: "getAddress", args: [s, [o]] }),
    probe: () => ({ abi: ["function getInstalledPlugins() view returns (address[])"], fn: "getInstalledPlugins" }), mine: (r) => Array.isArray(r) && r.some((p) => same(p, MA1_PLUGIN)),
    via: (w) => ({ to: MA1_PLUGIN, abi: ["function ownersOf(address account) view returns (address[])"], fn: "ownersOf", args: [w] }),
    viaMine: (v, o) => (!Array.isArray(v) || !v.some((x) => same(x, o)) ? false : v.length === 1 ? true : "other owners can sign for it too"),
    moved: "its owner plugin names you, but the account no longer uses that plugin" },
  { kind: "Alchemy Modular Account", version: "v2", factory: MA2_FACTORY, log: { topic: SMA_CREATED, from: MA2_FACTORY },
    address: (o, s) => ({ abi: ["function getAddressSemiModular(address owner, uint256 salt) view returns (address)"], fn: "getAddressSemiModular", args: [o, s] }),
    probe: () => ({ abi: ["function getFallbackSignerData() view returns (address, bool)"], fn: "getFallbackSignerData" }), mine: (r, o) => Array.isArray(r) && same(r[0], o) && r[1] === false },
  // counterfactual Safes: deployed ones also come from the Safe owner list (holdings.safe_wallets)
  ...[["4337 (Safe SDK)", SAFE_L2, SAFE_MODULE_SETUP_030, enableModule(SAFE_4337_030), SAFE_4337_030, (chain) => [SAFE_SDK_SALT(chain)]],
    ["4337 (permissionless)", SAFE_L1, SAFE_MULTISEND, viaMultiSend(SAFE_MODULE_SETUP_030, enableModule(SAFE_4337_030)), SAFE_4337_030, () => [0n]],
    ["4337 v0.2.0", SAFE_L2, SAFE_MODULE_SETUP_020, enableModule(SAFE_4337_020), SAFE_4337_020, () => [0n]]].map(([version, singleton, to, data, module, salts]) => ({
    kind: "Safe", version, factory: SAFE_FACTORY, app: "https://app.safe.global", salts, local: safeAddress(singleton, to, data, module),
    probe: () => ({ abi: ["function getOwners() view returns (address[])"], fn: "getOwners" }), mine: (r, o) => Array.isArray(r) && r.length === 1 && same(r[0], o),
  })),
];

// tokens read on every candidate (an undeployed account only shows up through a balance): stables and wrapped native,
// then the next most held tokens per chain (BTC wrappers, staked ETH, the chain's own token)
export const BIG_TOKENS = {
  ethereum: ["0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", "0xdAC17F958D2ee523a2206206994597C13D831ec7", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", "0x4c9EDD5852cd905f086C759E8383e09bff1E68B3", "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf"],
  base: ["0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "0x4200000000000000000000000000000000000006", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2",
    "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", "0x940181a94A35A4569E4529A3CDfB74e38FD98631", "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22"],
  arbitrum: ["0xaf88d065e77c8cC2239327C5EDb3A432268e5831", "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
    "0x912CE59144191C1204E64559FE8253a0e49E6548", "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", "0x5979D7b546E38E414F7E9822514be443A4800529", "0xfc5A1A6EB076a2C7aD06eD22C90d7E710E35ad0a"],
  optimism: ["0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", "0x4200000000000000000000000000000000000006",
    "0x4200000000000000000000000000000000000042", "0x68f180fcCe6836688e9084f035309E29Bf0A2095", "0x1F32b1c2345538c0c6f582fCB022739c4A194Ebb", "0x9560e827aF36c94D2Ac33a39bCE1Fe78631088Db"],
  polygon: ["0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619",
    "0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6", "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", "0xD6DF932A45C0f255f85145f286eA0b292B21C90B", "0x53E0bca35eC356BD5ddDFebbD1Fc0fD03FaBad39"],
  bsc: ["0x55d398326f99059fF775485246999027B3197955", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", "0x2170Ed0880ac9A755fd29B2688956BD959F933F8",
    "0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c", "0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82", "0xc5f0f7b66764F6ec8C8Dff7BA683102295E16409", "0x8d0D000Ee44948FC98c9B98A4FA4921476f08B0d"],
};
const BAL = ["function balanceOf(address) view returns (uint256)"];
const ETH_BAL = ["function getEthBalance(address) view returns (uint256)"];
const PERMISSION = ["function permissionConfig(bytes4 pId) view returns ((bytes2 permissionFlag, address signer, bytes22[] policyData))"];
const SIGNER = ["function signer(bytes32 id, address wallet) view returns (address)"];
// log candidates checked per chain: an owner with hundreds (a relayer, an app's backend signer) gets the newest ones
export const LOG_CAP = 25;

const getLogs = async (ctx, chain, filter) => {
  const r = await ctx.call("evm.alchemy_rpc", { network: ALCHEMY_NET[chain] }, { body: { jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [{ fromBlock: "0x0", toBlock: "latest", ...filter }] } });
  // Alchemy caps a full-history answer at 10K logs: an owner that many accounts name is an app's backend signer
  if (/response size exceeded/i.test(r.data?.error?.message || "")) throw { error: "over 10,000 setup logs name this owner (an app's signer?), not read" };
  if (!r.ok || r.data?.error) throw { error: `eth_getLogs failed (upstream ${r.status})`, detail: r.data?.error };
  return r.data?.result || [];
};
const LOG_TOPICS = [...new Set(ACCOUNTS.filter((t) => t.log).map((t) => t.log.topic))];
const addrOf = (topic) => `0x${topic.slice(26)}`;

// accounts whose setup event (logs, read beside the factory views) names the owner, typed by the factory that made
// them: [{ t, wallet }]
async function fromLogs(ctx, chain, logs, known, errors) {
  const found = new Map();
  for (const l of [...logs].sort((a, b) => parseInt(b.blockNumber, 16) - parseInt(a.blockNumber, 16))) {
    const types = ACCOUNTS.filter((t) => t.log?.topic === l.topics[0] && (!t.log.from || same(t.log.from, l.address)));
    if (!types.length) continue; // an emitter we do not trust (anyone can emit these events)
    const wallet = types[0].log.from ? addrOf(l.topics[1]) : l.address;
    const k = wallet.toLowerCase();
    if (known.has(k) || found.has(k)) continue;
    // the factory's own event types the account (one factory, one type); a validator's or the account's own event
    // waits for the EntryPoint's AccountDeployed
    const byFactory = types.filter((t) => same(t.factory, l.address));
    found.set(k, { wallet, types, t: byFactory.length ? byFactory[0] : null });
  }
  const list = [...found.values()];
  if (list.length > LOG_CAP) errors.push(`4337 ${chain}: ${list.length - LOG_CAP} more accounts name this owner in their setup logs, not checked (the newest ${LOG_CAP} were)`);
  const keep = list.slice(0, LOG_CAP), wait = keep.filter((x) => !x.t);
  if (wait.length) {
    const deployed = await getLogs(ctx, chain, { address: EP, topics: [ACCOUNT_DEPLOYED, null, wait.map((x) => topicAddr(x.wallet))] });
    for (const d of deployed) {
      const x = wait.find((w) => same(w.wallet, addrOf(d.topics[2]))), factory = `0x${d.data.slice(26, 66)}`;
      if (!x || x.t) continue;
      const exact = x.types.filter((t) => same(t.factory, factory));
      // FactoryStaker: the Kernel factory behind it is not in the log, so the version is the range its validator covers
      const staked = same(factory, KERNEL_STAKER) ? x.types.filter((t) => t.staked) : [];
      if (exact.length) x.t = exact[0];
      else if (staked.length) x.t = staked.length === 1 ? staked[0] : { ...staked[0], version: `${staked[0].version}-${staked.at(-1).version.slice(1)}` };
    }
  }
  return keep.filter((x) => x.t).map((x) => ({ t: x.t, wallet: x.wallet, salt: null }));
}

// -> { accounts[] {chain, wallet, kind, version, salt, deployed}, hints[] (deployed, owner not readable), errors[] }
export async function ownedAccounts(ctx, owner, { chains = AA_CHAINS } = {}) {
  const accounts = [], hints = [], errors = [];
  const useLogs = !ctx.live || ctx.live("evm.alchemy_rpc");
  await Promise.all(chains.map(async (chain) => {
    try {
      const saltsOf = (t) => (typeof t.salts === "function" ? t.salts(chain) : t.salts || SALTS);
      const asks = ACCOUNTS.filter((t) => t.address).flatMap((t) => saltsOf(t).map((salt) => ({ t, salt, call: { to: t.factory, ...t.address(owner, salt) } })));
      // the owner's setup logs are read beside the factory views
      const logsAsk = useLogs ? getLogs(ctx, chain, { topics: [LOG_TOPICS, null, topicAddr(owner)] }).catch((e) => { errors.push(`4337 logs ${chain}: ${String(e?.error || e?.message || e).slice(0, 120)}`); return []; }) : [];
      const [got, logs] = await Promise.all([multi(ctx, chain, asks.map((x) => x.call)), logsAsk]);
      // one candidate per address (a factory missing on this chain answers null); Safes are computed here
      const seen = new Map();
      const add = (x, w) => { if (typeof w === "string" && !/^0x0{40}$/i.test(w) && !seen.has(w.toLowerCase())) seen.set(w.toLowerCase(), { ...x, wallet: w }); };
      asks.forEach((x, i) => add(x, got[i]));
      for (const t of ACCOUNTS.filter((x) => x.local)) for (const salt of saltsOf(t)) add({ t, salt }, t.local(owner, salt));
      if (logs.length) {
        const logged = await fromLogs(ctx, chain, logs, seen, errors).catch((e) => { errors.push(`4337 logs ${chain}: ${String(e?.error || e?.message || e).slice(0, 120)}`); return []; });
        for (const x of logged) add(x, x.wallet);
      }
      const cands = [...seen.values()];
      if (!cands.length) return;
      const toks = BIG_TOKENS[chain] || [];
      const reads = [], at = [];
      for (const c of cands) {
        at.push(reads.length);
        reads.push({ to: c.wallet, ...c.t.probe(owner) }, { to: MULTICALL3, abi: ETH_BAL, fn: "getEthBalance", args: [c.wallet] }, ...toks.map((tk) => ({ to: tk, abi: BAL, fn: "balanceOf", args: [c.wallet] })));
        if (c.t.via) reads.push(c.t.via(c.wallet));
      }
      const res = await multi(ctx, chain, reads);
      const perm = [];
      cands.forEach((c, i) => {
        const [probe, eth, ...rest] = res.slice(at[i], at[i] + 2 + toks.length + (c.t.via ? 1 : 0));
        const bals = rest.slice(0, toks.length), via = c.t.via ? rest[toks.length] : null;
        const funded = eth > 0n || bals.some((b) => b > 0n);
        const deployed = probe != null; // a call to an address without code answers nothing
        const row = { chain, wallet: c.wallet, kind: c.t.kind, version: c.t.version, salt: c.salt == null ? null : c.salt <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(c.salt) : c.salt.toString(), deployed, ...(c.t.app && { app: c.t.app }) };
        if (!deployed) { if (funded) accounts.push(row); return; }
        const viaOk = !c.t.via ? true : (c.t.viaMine || same)(via, owner);
        const mine = c.t.mine(probe, owner);
        if (mine && viaOk === true) accounts.push(row);
        else if (mine && typeof viaOk === "string") hints.push({ ...row, why: viaOk });
        // a Kernel v3 whose root is now a permission: its signer is read next
        else if (c.t.permission && typeof probe === "string" && probe.startsWith("0x02")) perm.push({ row, pid: probe.slice(0, 12).replace("0x02", "0x"), viaOk: viaOk === true });
        // the validator still names this owner but the account's root (or enabled) validator is another one: unclear
        else if (c.t.via && viaOk === true) hints.push({ ...row, why: c.t.moved || "its ECDSA validator names you, but the account now signs with another validator" });
      });
      if (perm.length) {
        const pr = await multi(ctx, chain, perm.flatMap((p) => [
          { to: p.row.wallet, abi: PERMISSION, fn: "permissionConfig", args: [p.pid] },
          { to: ECDSA_SIGNER, abi: SIGNER, fn: "signer", args: [pad(p.pid, { dir: "right" }), p.row.wallet] },
        ]));
        perm.forEach((p, i) => {
          const [cfg, signer] = [pr[i * 2], pr[i * 2 + 1]];
          if (same(cfg?.signer, ECDSA_SIGNER) && same(signer, owner)) accounts.push(p.row);
          else if (p.viaOk) hints.push({ ...p.row, why: "its ECDSA validator names you, but the account now signs with another validator" });
        });
      }
      // funded and silent: no code, or code that does not answer the probe (an upgraded account), which is only a hint
      const silent = accounts.filter((a) => a.chain === chain && !a.deployed);
      const codes = await Promise.all(silent.map((a) => rpcCall(ctx, chain, "eth_getCode", [a.wallet, "latest"]).catch(() => null)));
      silent.forEach((a, i) => {
        if (codes[i] === "0x") return;
        accounts.splice(accounts.indexOf(a), 1);
        hints.push({ ...a, deployed: codes[i] != null, why: codes[i] == null ? "its code could not be read" : "it has code that does not answer the owner check" });
      });
    } catch (e) {
      errors.push(`4337 ${chain}: ${String(e?.error || e?.message || e).slice(0, 120)}`);
    }
  }));
  const order = (x) => `${x.chain}${x.kind}${x.version}${x.wallet.toLowerCase()}`;
  return { accounts: accounts.sort((a, b) => order(a).localeCompare(order(b))), hints: hints.sort((a, b) => order(a).localeCompare(order(b))), errors: errors.sort() };
}
