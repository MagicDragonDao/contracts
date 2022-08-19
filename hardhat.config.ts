import "@typechain/hardhat";
import "@nomiclabs/hardhat-waffle";
import "@nomiclabs/hardhat-etherscan";
import "@openzeppelin/hardhat-upgrades";
import "hardhat-gas-reporter";
import "hardhat-dependency-compiler";
import "hardhat-contract-sizer";
import "solidity-coverage";

import "./tasks/accounts";

import { resolve } from "path";

import { config as dotenvConfig } from "dotenv";
import { HardhatUserConfig } from "hardhat/config";
import { NetworkUserConfig, HardhatNetworkUserConfig } from "hardhat/types";

dotenvConfig({ path: resolve(__dirname, "./.env") });

const chainIds = {
    ganache: 1337,
    goerli: 5,
    hardhat: 1337,
    localhost: 31337,
    kovan: 42,
    mainnet: 1,
    rinkeby: 4,
    ropsten: 3,
    arbitrumOne: 42161,
};

// Ensure that we have all the environment variables we need.
let mnemonic: string;
if (!process.env.MNEMONIC) {
    mnemonic = "test test test test test test test test test test test junk";
} else {
    mnemonic = process.env.MNEMONIC;
}

const forkMainnet = process.env.FORK_MAINNET === "true";

let alchemyApiKey: string | undefined;
if (forkMainnet && !process.env.ALCHEMY_API_KEY) {
    throw new Error("Please set process.env.ALCHEMY_API_KEY");
} else {
    alchemyApiKey = process.env.ALCHEMY_API_KEY;
}

function createTestnetConfig(network: keyof typeof chainIds): NetworkUserConfig {
    const url = `https://eth-${network}.alchemyapi.io/v2/${alchemyApiKey}`;
    return {
        accounts: {
            count: 10,
            initialIndex: 0,
            mnemonic,
            path: "m/44'/60'/0'/0",
        },
        chainId: chainIds[network],
        url,
    };
}

function createHardhatConfig(): HardhatNetworkUserConfig {
    const config = {
        accounts: {
            mnemonic,
        },
        chainId: chainIds.hardhat,
        allowUnlimitedContractSize: true,
    };

    if (forkMainnet) {
        return Object.assign(config, {
            forking: {
                url: `https://arb1.arbitrum.io/rpc`,
            },
        });
    }

    return config;
}

function createMainnetConfig(): NetworkUserConfig {
    return {
        accounts: {
            mnemonic,
        },
        chainId: chainIds.mainnet,
        url: `https://eth-mainnet.alchemyapi.io/v2/${alchemyApiKey}`,
    };
}

const optimizerEnabled = process.env.DISABLE_OPTIMIZER ? false : true;

const compilerSettings = {
    metadata: {
        // Not including the metadata hash
        // https://github.com/paulrberg/solidity-template/issues/31
        bytecodeHash: "none",
    },
    // You should disable the optimizer when debugging
    // https://hardhat.org/hardhat-network/#solidity-optimizer-support
    optimizer: {
        enabled: optimizerEnabled,
        runs: 1000,
    },
};

const config: HardhatUserConfig = {
    defaultNetwork: "hardhat",
    gasReporter: {
        currency: "USD",
        enabled: process.env.REPORT_GAS ? true : false,
        excludeContracts: [],
        src: "./contracts",
        coinmarketcap: process.env.COINMARKETCAP_API_KEY,
        outputFile: process.env.REPORT_GAS_OUTPUT,
    },
    networks: {
        mainnet: createMainnetConfig(),
        hardhat: createHardhatConfig(),
        goerli: createTestnetConfig("goerli"),
        kovan: createTestnetConfig("kovan"),
        rinkeby: createTestnetConfig("rinkeby"),
        ropsten: createTestnetConfig("ropsten"),
        arbitrumOne: {
            // url: "https://arb1.arbitrum.io/rpc",
            url: "https://arb-mainnet.g.alchemy.com/v2/YfFJbmU2VrOV7DFCW9UMEr7PHCE-XbKZ",
            accounts: { mnemonic },
            chainId: chainIds.arbitrumOne,
        },
        localhost: {
            accounts: {
                mnemonic,
            },
            chainId: chainIds.hardhat,
            gasMultiplier: 10,
        },
    },
    paths: {
        artifacts: "./artifacts",
        cache: "./cache",
        sources: "./contracts",
        tests: "./test",
    },
    solidity: {
        compilers: [
            {
                version: "0.8.11",
                settings: compilerSettings,
            },
            {
                version: "0.8.10",
                settings: compilerSettings,
            },
            {
                version: "0.8.0",
                settings: compilerSettings,
            },
            {
                version: "0.4.12",
            },
        ],
    },
    typechain: {
        outDir: "src/types",
        target: "ethers-v5",
    },
    dependencyCompiler: {
        paths: [
            "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol",
            "@openzeppelin/contracts/proxy/transparent/ProxyAdmin.sol",
            "treasure-staking/contracts/AtlasMine.sol",
            "treasure-staking/contracts/MasterOfCoin.sol",
            "treasure-staking/contracts/interfaces/ILegionMetadataStore.sol",
        ],
    },
    etherscan: {
        apiKey: {
            mainnet: process.env.ETHERSCAN_API_KEY,
            arbitrumOne: process.env.ARBISCAN_API_KEY,
        },
    },
};

export default config;
