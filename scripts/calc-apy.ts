import { ethers } from "hardhat";
import BigNumber from "bignumber.js";

import { SECTION_SEPARATOR } from "./constants";

import type { AtlasMineStaker } from "../src/types/AtlasMineStaker";
import type { AtlasMine } from "../src/types/AtlasMine";
import type { MasterOfCoin } from "../src/types/MasterOfCoin";
import type { ERC20 } from "../src/types/ERC20";

export async function main(): Promise<string> {
    const MASTER_OF_COIN_ADDR = "0x3563590e19d2b9216e7879d269a04ec67ed95a87";
    const MINE_ADDR = "0xa0a89db1c899c49f98e6326b764bafcf167fc2ce";
    // const STAKER_ADDR = "0x7779Bb39C2ae74f652f6490eE497Ab7E088548A1";
    const STAKER_ADDR = "0x760b432f51dd210c3559987d6d55ee2de1db44e6";

    const mocf = await ethers.getContractFactory("MasterOfCoin");
    const minef = await ethers.getContractFactory("AtlasMine");
    const stakerf = await ethers.getContractFactory("AtlasMineStaker");

    const moc = <MasterOfCoin>await mocf.attach(MASTER_OF_COIN_ADDR);
    const mine = <AtlasMine>await minef.attach(MINE_ADDR);
    const staker = <AtlasMineStaker>await stakerf.attach(STAKER_ADDR);

    // Use real BigNumbers instead of ethers.BigNumbers
    const rps = new BigNumber((await moc.getRatePerSecond(MINE_ADDR)).toString());
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
    const factory = await ethers.getContractFactory("AtlasMineStaker");
    const staker = <AtlasMineStaker>await factory.deploy(MAGIC, MINE, lock);
    await staker.deployed();

    console.log("Staker deployed to:", staker.address);
}

async function approveMagic(): Promise<void> {
    const staker = "0x760b432f51dd210C3559987D6D55ee2DE1Db44E6";
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
