import { ethers } from "hardhat";
import BigNumber from "bignumber.js";

import { SECTION_SEPARATOR } from "./constants";

import type { AtlasMineStaker } from "../src/types/AtlasMineStaker";
import type { AtlasMine } from "../src/types/AtlasMine";
import type { MasterOfCoin } from "../src/types/MasterOfCoin";
import type { ERC20 } from "../src/types/ERC20";

export async function main(): Promise<void> {
    const MASTER_OF_COIN_ADDR = "0x3563590e19d2b9216e7879d269a04ec67ed95a87";
    const MINE_ADDR = "0xa0a89db1c899c49f98e6326b764bafcf167fc2ce";
    const STAKER_ADDR = "0xA094629baAE6aF0C43F17F434B975337cBDb3C42";

    const mocf = await ethers.getContractFactory("MasterOfCoin");
    const minef = await ethers.getContractFactory("AtlasMine");
    const stakerf = await ethers.getContractFactory("AtlasMineStaker");

    const moc = <MasterOfCoin>await mocf.attach(MASTER_OF_COIN_ADDR);
    const mine = <AtlasMine>await minef.attach(MINE_ADDR);
    const staker = <AtlasMineStaker>await stakerf.attach(STAKER_ADDR);

    // Read rewards for each stake
    const depositIds = await mine.getAllUserDepositIds(STAKER_ADDR);

    console.log("Have this many deposits:", depositIds.length);

    const depositId = 48;
    const info = await mine.userInfo(STAKER_ADDR, depositId);

    console.log("Stake info:");
    console.log(info);

    // for (const id of depositIds) {
    //     try {
    //         // console.log("Getting pending rewards for deposit", id);
    //         const pending = await mine.pendingRewardsPosition(STAKER_ADDR, id);
    //         // console.log("Got ", ethers.utils.formatEther(pending));
    //         // console.log();
    //     } catch {
    //         console.log(`Deposit id ${id} failed.`);
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
