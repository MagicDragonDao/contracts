import { ethers } from "hardhat";

import { SECTION_SEPARATOR } from "./constants";

import type { AtlasMineStaker } from "../src/types/AtlasMineStaker";
export async function main(): Promise<void> {
    // await deploy();
    // await generateApprove();
    await generateStake();

    // Other possible actions:
    // Transfer ownership
    // Set a DAO fee
    // Set a hoard address
}

async function generateApprove(): Promise<void> {
    const staker = "0xE92e7eE2ae2CC43C7d4Cb0da286fe0F72D452B0B";
    const legionsAddr = "0xfE8c1ac365bA6780AEc5a985D989b327C27670A1";

    const factory = await ethers.getContractFactory("ERC721");

    const data = factory.interface.encodeFunctionData("setApprovalForAll", [legionsAddr, true]);

    console.log("Encoded Calldata:");
    console.log(data);
}

async function generateStake(): Promise<void> {
    const staker = "0xE92e7eE2ae2CC43C7d4Cb0da286fe0F72D452B0B";
    const legionId = 24784;

    const factory = await ethers.getContractFactory("AtlasMineStaker");

    const data = factory.interface.encodeFunctionData("stakeLegion", [legionId]);

    console.log("Encoded Calldata:");
    console.log(data);
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
