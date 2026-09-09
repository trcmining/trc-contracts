import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

dotenv.config();

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";

// Both default RPC endpoints can be overridden via environment variables.
// The mainnet endpoint used to be 1rpc.io/eth, which intermittently returns an
// nginx 301 HTML page; hardhat cannot parse that and throws HH107/HH110. We hit
// this for real on the second transaction after a deployment.
const MAINNET_RPC = process.env.ETHEREUM_MAINNET_RPC_URL || "https://ethereum-rpc.publicnode.com";
const SEPOLIA_RPC = process.env.ETHEREUM_SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com";

const config: HardhatUserConfig = {
  paths: {
    sources: "./src",
  },
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      // 🔴 Must stay "paris". solc 0.8.20 defaults to "shanghai", which emits PUSH0
      //    and produces different bytecode — the contracts on mainnet were compiled
      //    for paris, so leaving this unset makes the local build fail to reproduce
      //    them. scripts/verify-onchain.mjs is what catches this.
      evmVersion: "paris",
    },
  },
  networks: {
    /**
     * The local chain is pinned to sepolia's chainId, 11155111.
     *
     * The default would be 31337, but the platform's local live-fire drill reads
     * contract addresses and chain config under NEXT_PUBLIC_CHAIN_ID=11155111.
     * A mismatch means either no address is found or viem reports a chain
     * mismatch. The runbook used to ask people to change this by hand every
     * time; pinning it here removes that step.
     */
    hardhat: {
      chainId: 11155111,
    },
    mainnet: {
      url: MAINNET_RPC,
      chainId: 1,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    sepolia: {
      url: SEPOLIA_RPC,
      chainId: 11155111,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  // Source verification: requires a key from https://etherscan.io/myapikey
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
};

export default config;
