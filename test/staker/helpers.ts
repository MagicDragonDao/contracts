import chai, { expect } from "chai";
import { ethers, waffle } from "hardhat";
import { solidity } from "ethereum-waffle";
import { BigNumberish, ContractTransaction } from "ethers";

import { setNextBlockTimestamp } from "../utils";

import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import type { AtlasMineStaker } from "../../src/types/AtlasMineStaker";
import type { MasterOfCoin } from "../../src/types/MasterOfCoin";
import type { MockLegionMetadataStore } from "../../src/types/MockLegionMetadataStore";
import type { AtlasMine } from "../../src/types/AtlasMine";
import type { TestERC20 } from "../../src/types/TestERC20";
import type { TestERC1155 } from "../../src/types/TestERC1155";
import type { TestERC721 } from "../../src/types/TestERC721";
import { Test } from "mocha";

chai.use(solidity);

export const ether = ethers.utils.parseEther;
export const TOTAL_REWARDS = ether("172800");
export const ONE_DAY_SEC = 86400;

/////////////////////////////////////////////////////////////////////////////////
///                                  TYPES                                    ///
/////////////////////////////////////////////////////////////////////////////////

export interface TestContext {
    signers: SignerWithAddress[];
    admin: SignerWithAddress;
    users: SignerWithAddress[];
    staker: AtlasMineStaker;
    masterOfCoin: MasterOfCoin;
    metadataStore: MockLegionMetadataStore;
    mine: AtlasMine;
    magic: TestERC20;
    treasures: TestERC1155;
    legions: TestERC721;
    start: number;
    end: number;
}

export interface ScenarioInfo {
    signer: SignerWithAddress;
    timestamp: number;
    amount: BigNumberish;
    expectedReward: BigNumberish;
}

/////////////////////////////////////////////////////////////////////////////////
///                                  STAKING                                  ///
/////////////////////////////////////////////////////////////////////////////////

export type StakeParams = [SignerWithAddress, BigNumberish];

export const stakeSingle = async (
    staker: AtlasMineStaker,
    user: SignerWithAddress,
    amount: BigNumberish,
): Promise<ContractTransaction> => {
    return staker.connect(user).deposit(amount);
};

export const stakeMultiple = async (staker: AtlasMineStaker, stakes: StakeParams[]): Promise<ContractTransaction[]> => {
    const promises = stakes.map(s => stakeSingle(staker, ...s));
    return Promise.all(promises);
};

export const stakeSequence = async (staker: AtlasMineStaker, stakes: StakeParams[]): Promise<ContractTransaction> => {
    // Only returns final transaction
    let tx: ContractTransaction;
    for (const s of stakes) {
        tx = await stakeSingle(staker, ...s);
    }

    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return tx!;
};

export const withdrawSingle = async (
    staker: AtlasMineStaker,
    user: SignerWithAddress,
): Promise<ContractTransaction> => {
    return staker.connect(user).withdraw();
};

export const withdrawWithRoundedRewardCheck = async (
    staker: AtlasMineStaker,
    user: SignerWithAddress,
    stakeAmount: BigNumberish,
    expectedReward: BigNumberish,
): Promise<ContractTransaction> => {
    const withdrawTx = await withdrawSingle(staker, user);
    const receipt = await withdrawTx.wait();

    // Cannot use expect matchers because of rounded equal comparison
    const withdrawEvent = receipt.events?.find(e => e.event === "UserWithdraw");

    expect(withdrawEvent).to.not.be.undefined;
    expect(withdrawEvent?.args?.[0]).to.eq(user.address);
    expect(withdrawEvent?.args?.[1]).to.eq(stakeAmount);
    expectRoundedEqual(withdrawEvent?.args?.[2], expectedReward);

    return withdrawTx;
};

export const claimWithRoundedRewardCheck = async (
    staker: AtlasMineStaker,
    user: SignerWithAddress,
    expectedReward: BigNumberish,
): Promise<ContractTransaction> => {
    const claimTx = await claimSingle(staker, user);
    const receipt = await claimTx.wait();

    // Cannot use expect matchers because of rounded equal comparison
    const claimEvent = receipt.events?.find(e => e.event === "UserClaim");

    expect(claimEvent).to.not.be.undefined;
    expect(claimEvent?.args?.[0]).to.eq(user.address);
    expectRoundedEqual(claimEvent?.args?.[1], expectedReward);

    return claimTx;
};

export const claimSingle = async (staker: AtlasMineStaker, user: SignerWithAddress): Promise<ContractTransaction> => {
    return staker.connect(user).claim();
};

/////////////////////////////////////////////////////////////////////////////////
///                                  TIME                                     ///
/////////////////////////////////////////////////////////////////////////////////

export const rollSchedule = async (
    staker: AtlasMineStaker,
    start = Math.floor(Date.now() / 1000),
): Promise<ContractTransaction> => {
    const nextTimestamp = start + ONE_DAY_SEC;
    await setNextBlockTimestamp(nextTimestamp);

    return staker.stakeScheduled();
};

// TODO: Assumes 2-week lock. Make flexible if we test different locks
// Move forward 1.3mm seconds, or approximately 15 days
export const rollLock = async (start = Math.floor(Date.now() / 1000)): Promise<number> => {
    const nextTimestamp = start + 1_300_000;
    await setNextBlockTimestamp(nextTimestamp);

    return nextTimestamp;
};

export const rollToPartialWindow = async (start: number, end: number, ratio: number): Promise<number> => {
    const diff = (end - start) * ratio;
    const timestamp = start + diff;
    await setNextBlockTimestamp(timestamp);

    return timestamp;
};

export const rollTo = async (time: number): Promise<void> => {
    await setNextBlockTimestamp(time);
};

/////////////////////////////////////////////////////////////////////////////////
///                                MATCHERS                                   ///
/////////////////////////////////////////////////////////////////////////////////

export const expectRoundedEqual = (num: BigNumberish, target: BigNumberish): void => {
    num = ethers.BigNumber.from(num);
    target = ethers.BigNumber.from(target);

    // Tolerable precision is 1%. Precision is lost in the magic mine in both
    // calculating NFT reward boosts and timing per second
    const precision = 10000;

    if (target.eq(0)) {
        expect(num).to.be.lt(precision);
    } else {
        // Expect it to be within 4 0s of precision, less than 1 bp diff
        const lowerBound = target.div(precision).mul(precision - 1);
        const upperBound = target.div(precision).mul(precision + 1);

        expect(num).to.be.gt(lowerBound);
        expect(num).to.be.lt(upperBound);
    }
};

/////////////////////////////////////////////////////////////////////////////////
///                                SCENARIOS                                  ///
/////////////////////////////////////////////////////////////////////////////////

export const setup5050Scenario = async (ctx: TestContext, rollUntil?: number) => {
    const {
        users: [user1, user2],
        staker,
        start,
    } = ctx;

    const end = rollUntil || start;

    // Stake more than rewards to force a withdraw
    // With 2 stakers, each will earn 7000 MAGIC over lock period
    const amount = ether("20000");
    const txs = await stakeMultiple(staker, [
        [user1, amount],
        [user2, amount],
    ]);

    // Wait for all deposits to finish
    await Promise.all(txs.map(t => t.wait()));

    // Go to start of rewards program
    await rollTo(end);

    // Make a tx to deposit
    const tx = await staker.stakeScheduled();
    await tx.wait();

    const timestamp = await rollLock(end);

    // We now have unlocked coins among two stakers who deposited equal
    // amounts at the same time
    return {
        lastBlockTime: timestamp,
        stakes: {
            [user1.address]: amount,
            [user2.address]: amount,
        },
    };
};

export const setup7525Scenario = async (ctx: TestContext) => {
    const {
        users: [user1, user2],
        staker,
        start,
        end,
    } = ctx;

    // Stake more than rewards to force a withdraw
    // With 2 stakers, each will earn 7000 MAGIC over lock period
    const amount = ether("20000");
    let tx = await stakeSingle(staker, user1, amount);
    await tx.wait();

    // Go to start of rewards program
    await rollTo(start);

    // Make a tx to deposit
    tx = await staker.stakeScheduled();
    await tx.wait();

    // Fast-forward to halfway through the lock time and have other
    // user also make a deposit
    const ts = await rollToPartialWindow(start, end, 0.5);

    tx = await stakeSingle(staker, user2, amount);
    await tx.wait();

    await rollSchedule(staker, ts);

    // Fast-forward to end of program
    // User1 should have 75% of rewards
    // User2 should have 25%
    await rollTo(end);

    // We now have unlocked coins among two stakers who deposited equal
    // amounts at the same time
    return {
        lastBlockTime: end,
        stakes: {
            [user1.address]: amount,
            [user2.address]: amount,
        },
        depositTimes: {
            [user1.address]: start,
            [user2.address]: ts,
        },
    };
};

export const setupAdvancedScenario1 = (ctx: TestContext): ScenarioInfo[] => {
    // Advanced Scenario 1:
    // (Different stake times, no nft boosts)
    // 1728000 total seconds in scenario = T
    // Base stake amount = N
    // 1 Share = (N/2) deposited for 25% of pool
    // Staker 1 Deposits N at 0 = 8 shares
    // Staker 2 Deposits N/2 at 25% of T = 3 shares
    // Staker 3 Deposits 2N at 50% of T = 8 shares
    // Staker 4 Deposits 4N at 75% of T = 8 shares
    // Total is 27, so divide rewards into 27 parts
    // 1,2,3 each get 8 of 27 parts, 4 gets 3 of 27 parts
    const {
        users: [user1, user2, user3, user4],
        start,
        end,
    } = ctx;

    const baseAmount = ether("100");
    const totalTime = end - start;
    const totalRewardsBase = TOTAL_REWARDS.div(27);

    const scenario: ScenarioInfo[] = [
        {
            signer: user1,
            timestamp: start,
            amount: baseAmount,
            expectedReward: totalRewardsBase.mul(8),
        },
        {
            signer: user2,
            timestamp: start + totalTime * 0.25,
            amount: baseAmount.div(2),
            expectedReward: totalRewardsBase.mul(3),
        },
        {
            signer: user3,
            timestamp: start + totalTime * 0.5,
            amount: baseAmount.mul(2),
            expectedReward: totalRewardsBase.mul(8),
        },
        {
            signer: user4,
            timestamp: start + totalTime * 0.75,
            amount: baseAmount.mul(4),
            expectedReward: totalRewardsBase.mul(8),
        },
    ];

    return scenario;
};

export const runScenario = async (ctx: TestContext, scenario: ScenarioInfo[]) => {
    const { staker, end } = ctx;
    // Run through scenario from beginning of program until end
    for (const deposit of scenario) {
        const { signer, timestamp, amount } = deposit;
        console.log("Staking", signer.address, amount.toString());

        const depositTime = timestamp - ONE_DAY_SEC;
        await rollTo(depositTime);

        // Make deposit one day in advance, then roll
        let tx = await staker.connect(signer).deposit(amount);
        await tx.wait();

        // Now roll again and stake
        await rollTo(timestamp);
        tx = await staker.stakeScheduled();
        await tx.wait();

        // Stake done
    }

    // Now roll to end - all staking should be processed
    await rollTo(end);
};
