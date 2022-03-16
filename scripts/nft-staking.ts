import { ethers } from "hardhat";

import { SECTION_SEPARATOR } from "./constants";

import type { AtlasMineStaker } from "../src/types/AtlasMineStaker";
export async function main(): Promise<void> {
    // await deploy();
    // await generateApprove();
    // await generateStake();
    await transferOwnership();

    // Other possible actions:
    // Transfer ownership
    // Set a DAO fee
    // Set a hoard address
}

async function transferOwnership(): Promise<void> {
    const stakerAddr = "0xE92e7eE2ae2CC43C7d4Cb0da286fe0F72D452B0B";
    const multisig = "0x4deFaa0B91EA699F0Da90DEC276bbaa629015140";

    const factory = await ethers.getContractFactory("AtlasMineStaker");
    const staker = <AtlasMineStaker>await factory.attach(stakerAddr);

    const tx = await staker.transferOwnership(multisig);
    console.log("Sent tx:", tx.hash);
}

async function generateApprove(): Promise<void> {
    const staker = "0xE92e7eE2ae2CC43C7d4Cb0da286fe0F72D452B0B";
    const legionsAddr = "0xfE8c1ac365bA6780AEc5a985D989b327C27670A1";

    const factory = await ethers.getContractFactory("ERC721");

    const data = factory.interface.encodeFunctionData("setApprovalForAll", [staker, true]);

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
