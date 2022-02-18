import { ethers } from "hardhat";

import { SECTION_SEPARATOR } from "./constants";

import type { AtlasMineStaker } from "../src/types/AtlasMineStaker";

export async function main(): Promise<void> {
    console.log(SECTION_SEPARATOR);
    const signers = await ethers.getSigners();
    console.log("Deployer address: ", signers[0].address);
    console.log("Deployer balance: ", (await signers[0].getBalance()).toString());
    console.log(SECTION_SEPARATOR);

    const MAGIC = "0x539bde0d7dbd336b79148aa742883198bbf60342";
    const MINE = "0xa0a89db1c899c49f98e6326b764bafcf167fc2ce";
    const lock = 0; // 2 weeks

    // Deploy the contracts
    const factory = await ethers.getContractFactory("AtlasMineStaker");
    const staker = <AtlasMineStaker>await factory.deploy(MAGIC, MINE, lock);
    await staker.deployed();

    console.log("Staker deployed to:", staker.address);

    // Other possible actions:
    // Transfer ownership
    // Set a DAO fee
    // Set a hoard address
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
