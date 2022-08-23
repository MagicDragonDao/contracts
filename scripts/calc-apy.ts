import { ethers } from "hardhat";
import BigNumber from "bignumber.js";

import type { AtlasMineStakerUpgradeable } from "../src/types/AtlasMineStakerUpgradeable";
import type { AtlasMine } from "../src/types/AtlasMine";
import type { MasterOfCoin } from "../src/types/MasterOfCoin";
import type { Middleman } from "../src/types/Middleman";

export async function main(): Promise<string> {
    const MASTER_OF_COIN_ADDR = "0x3563590e19d2b9216e7879d269a04ec67ed95a87";
    const MINE_ADDR = "0xa0a89db1c899c49f98e6326b764bafcf167fc2ce";
    const STAKER_ADDR = "0xA094629baAE6aF0C43F17F434B975337cBDb3C42";
    const MIDDLEMAN_ADDR = "0x3EA9CeAEbDeB702FCBC576710084C464431584c8";

    const mocf = await ethers.getContractFactory("MasterOfCoin");
    const minef = await ethers.getContractFactory("AtlasMine");
    const stakerf = await ethers.getContractFactory("AtlasMineStakerUpgradeable");
    const middlemanf = await ethers.getContractFactory("Middleman");

    const moc = <MasterOfCoin>await mocf.attach(MASTER_OF_COIN_ADDR);
    const mine = <AtlasMine>await minef.attach(MINE_ADDR);
    const staker = <AtlasMineStakerUpgradeable>await stakerf.attach(STAKER_ADDR);
    const middleman = <Middleman>await middlemanf.attach(MIDDLEMAN_ADDR);

    // Use real BigNumbers instead of ethers.BigNumbers
    const rpsMiddleman = new BigNumber((await moc.getRatePerSecond(MIDDLEMAN_ADDR)).toString());
    const amShareData = await middleman.getHarvesterShares(MINE_ADDR);
    const [, shares, totalShares, targetIndex] = amShareData;
    const amShares = new BigNumber(shares[targetIndex.toNumber()].toString());
    const rps = rpsMiddleman.times(amShares).div(totalShares.toString());

    const mineBalance = new BigNumber((await mine.totalLpToken()).toString());
    let stakerBalance = new BigNumber(0);

    const stakerCurrentId = (await mine.currentId(STAKER_ADDR)).toNumber();

    for (let i = 0; i <= stakerCurrentId; i++) {
        // Get balance of stake
        const stakeInfo = await mine.userInfo(STAKER_ADDR, i);
        const lpAmount = new BigNumber(stakeInfo.lpAmount.toString());

        stakerBalance = stakerBalance.plus(lpAmount);
    }

    const stakerRatio = stakerBalance.div(mineBalance);
    const proRataMagicPerSecond = rps.times(stakerRatio);
    const SECONDS_PER_YEAR = 31_536_000;
    const magicPerYear = proRataMagicPerSecond.times(SECONDS_PER_YEAR);

    const stakerTotalDeposits = new BigNumber((await staker.totalStaked()).toString());
    const apy = magicPerYear.div(stakerTotalDeposits).times(100);

    console.log("Current APY:", apy.toString());

    return apy.toString();
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
