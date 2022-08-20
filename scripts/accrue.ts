import { ethers } from "hardhat";

import { SECTION_SEPARATOR } from "./constants";

import type { AtlasMineStakerUpgradeable } from "../src/types/AtlasMineStakerUpgradeable";
import type { AtlasMine } from "../src/types/AtlasMine";

export async function main(): Promise<void> {
    const MINE_ADDR = "0xa0a89db1c899c49f98e6326b764bafcf167fc2ce";
    const STAKER_ADDR = "0xA094629baAE6aF0C43F17F434B975337cBDb3C42";
    const CHUNK_SIZE = 20;

    const minef = await ethers.getContractFactory("AtlasMine");
    const stakerf = await ethers.getContractFactory("AtlasMineStakerUpgradeable");

    const mine = <AtlasMine>await minef.attach(MINE_ADDR);
    const staker = <AtlasMineStakerUpgradeable>await stakerf.attach(STAKER_ADDR);

    // Read rewards for each stake
    const depositIds = await mine.getAllUserDepositIds(STAKER_ADDR);

    console.log(SECTION_SEPARATOR);

    console.log("Running at", new Date().toISOString());
    console.log("Have this many deposits:", depositIds.length);
    console.log();

    const addr = "0xB6631E52E513eEE0b8c932d7c76F8ccfA607a28e";
    const id = await staker.currentId(addr);

    for (let i = 0; i <= id.toNumber(); i++) {
        console.log("Checking id", i);

        const stake = await staker.getUserStake(addr, i);

        if (stake.amount.gt(0)) {
            console.log("Should have reward for", i);
            const r = await staker.pendingRewards(addr, i);
            console.log("Reward", ethers.utils.formatEther(r));
        } else {
            console.log("No deposit for", i);
        }
    }

    // for (let i = 0; i < depositIds.length; i += CHUNK_SIZE) {
    //     const start = i;
    //     const end = i + CHUNK_SIZE;

    //     const chunk = depositIds.slice(start, end);

    //     try {
    //         const tx = await staker.accrue(chunk);
    //         const receipt = await tx.wait();

    //         console.log(`Accrued rewards for deposits ${start}-${end - 1}`);
    //         console.log("Tx ID:", receipt.transactionHash);
    //         console.log();
    //     } catch (e) {
    //         console.error("Got error accuring:");
    //         console.error(e.message);
    //         console.log();
    //     }
    // }
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
