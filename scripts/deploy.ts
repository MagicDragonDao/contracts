import { ethers } from "hardhat";

import { SECTION_SEPARATOR } from "./constants";

import type { AtlasMineStakerUpgradeable } from "../src/types/AtlasMineStakerUpgradeable";
import type { ERC20 } from "../src/types/ERC20";

import AMAbi from "../artifacts/contracts/AtlasMineStakerUpgradeable.sol/AtlasMineStakerUpgradeable.json";

export async function main(): Promise<void> {
    await deploy();
    // await approveMagic();

    // Other possible actions:
    // Transfer ownership
    // Set a DAO fee
    // Set a hoard address
}

export async function deploy(): Promise<void> {
    console.log(SECTION_SEPARATOR);
    const signers = await ethers.getSigners();
    console.log("Deployer address: ", signers[0].address);
    console.log("Deployer balance: ", (await signers[0].getBalance()).toString());
    console.log(SECTION_SEPARATOR);

    const MAGIC = "0x539bde0d7dbd336b79148aa742883198bbf60342";
    const MINE = "0xa0a89db1c899c49f98e6326b764bafcf167fc2ce";
    const lock = 0; // 2 weeks

    // Deploy the contracts
    const factory = await ethers.getContractFactory("AtlasMineStakerUpgradeable");
    const staker = <AtlasMineStakerUpgradeable>await factory.deploy({ gasLimit: 10000000 });
    await staker.deployed();

    console.log("Staker implementation deployed to:", staker.address);

    await staker.initialize(MAGIC, MINE, lock);

    const iface = new ethers.utils.Interface(AMAbi.abi);

    const data = iface.encodeFunctionData("resetUnstakedAndStake", ["551932342000000000000000"]);

    console.log("Upgrade and call data:");
    console.log(data);

    // const proxyAdminFactory = await ethers.getContractFactory("ProxyAdmin");
    // const proxyAdmin = await proxyAdminFactory.deploy();
    // await proxyAdmin.deployed();

    // console.log("Proxy admin deployed to:", proxyAdmin.address);

    // const proxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy");
    // const proxy = await proxyFactory.deploy(staker.address, proxyAdmin.address, Buffer.from(""));
    // await proxy.deployed();

    // console.log("Proxy deployed to:", proxy.address);
}

async function approveMagic(): Promise<void> {
    const staker = "0xE92e7eE2ae2CC43C7d4Cb0da286fe0F72D452B0B";
    const MAGIC = "0x539bde0d7dbd336b79148aa742883198bbf60342";

    const factory = await ethers.getContractFactory("ERC20");
    const magic = <ERC20>await factory.attach(MAGIC);

    await magic.approve(staker, ethers.utils.parseEther("100"));
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
