import chai, { expect } from "chai";
import { ethers, waffle } from "hardhat";
import { solidity } from "ethereum-waffle";
import { BigNumberish, ContractTransaction } from "ethers";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";

chai.use(solidity);

import type { TestERC20, BasicDragonStash, StreamingDragonStash, DragonFireBreather } from "../../src/types";

import { setNextBlockTimestamp, ether, shuffle, expectRoundedEqual } from "../utils";

export const TOTAL_REWARDS_PER_DAY = ether("864");
export const ONE_DAY_SEC = 86400;
export const PROGRAM_DAYS = 1000;
export const TOTAL_REWARDS = TOTAL_REWARDS_PER_DAY.mul(PROGRAM_DAYS);

/////////////////////////////////////////////////////////////////////////////////
///                                  TYPES                                    ///
/////////////////////////////////////////////////////////////////////////////////

export interface TestContext {
    magic: TestERC20;
    token: TestERC20;
    admin: SignerWithAddress;
    user: SignerWithAddress;
    other: SignerWithAddress;
    users: SignerWithAddress[];
    pool: DragonFireBreather;
    streamingStash: StreamingDragonStash;
    basicStash: BasicDragonStash;
}

export interface Action {
    checkpoint: number; // Should be between -1 and 1, 0 is reward start time, 1 is end
    actions: ActionInfo[];
}

export interface ActionInfo {
    signer: SignerWithAddress;
    amount: BigNumberish;
    depositId?: BigNumberish;
    action: "deposit" | "withdraw" | "withdrawPartial" | "harvest" | "withdrawAndHarvest" | "withdrawPartialAndHarvest";
    poolId?: number;
}

export interface RewardInfo {
    signer: SignerWithAddress;
    expectedReward: BigNumberish;
}

export interface ScenarioInfo {
    actions: Action[];
    rewards: RewardInfo[];
}

/////////////////////////////////////////////////////////////////////////////////
///                                  TIME                                     ///
/////////////////////////////////////////////////////////////////////////////////

export const harvestWithRoundedRewardCheck = async (
    pool: DragonFireBreather,
    pid: number,
    user: SignerWithAddress,
    expectedReward: BigNumberish,
    pctWithin?: number,
): Promise<ContractTransaction> => {
    const harvestTx = await pool.connect(user).harvest(pid, user.address);
    const receipt = await harvestTx.wait();

    // Cannot use expect matchers because of rounded equal comparison
    const harvestEvents = receipt.events?.filter(e => e.event === "Harvest");

    let reward = ethers.BigNumber.from(0);
    for (const event of harvestEvents!) {
        expect(event).to.not.be.undefined;
        expect(event?.args?.[0]).to.eq(user.address);

        reward = reward.add(event?.args?.[2]);
    }

    expectRoundedEqual(reward, expectedReward, pctWithin);

    return harvestTx;
};

export const tryWithdrawAll = async (pool: DragonFireBreather, user: SignerWithAddress): Promise<void> => {
    const numPools = (await pool.poolLength()).toNumber();

    for (let pid = 0; pid < numPools; pid++) {
        const [amount] = await pool.getUserInfo(pid, user.address);

        if (amount.gt(0)) {
            await expect(pool.connect(user).withdraw(pid, amount, user.address)).to.not.be.reverted;
        }
    }
};

/////////////////////////////////////////////////////////////////////////////////
///                                SCENARIOS                                  ///
/////////////////////////////////////////////////////////////////////////////////

export const setupAdvancedScenario1 = (ctx: TestContext): ScenarioInfo => {
    // Advanced scenario 1:
    // Multiple depositors, different times, same pools, no harvests between deposits
    //
    // Staker 1 Deposits N at 0
    // Staker 2 Deposits N/3 at 0.25
    // Staker 3 Deposits 2N/3 at 0.5
    // Staker 4 Deposits 2N at 0.75
    //
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:    100                 0               0               0
    // At T = 0.25:  75                25               0               0
    // At T = 0.5:   50             16.67           33.33               0
    // At T = 0.75:  25              8.33           16.67              50
    // Totals:      62.5             12.5            12.5             12.5

    const {
        users: [user1, user2, user3, user4],
    } = ctx;

    const baseAmount = ether("100");
    const totalRewardsBase = TOTAL_REWARDS.div(10000);

    const actions: Action[] = [
        {
            checkpoint: -1,
            actions: [
                {
                    signer: user1,
                    amount: baseAmount,
                    action: "deposit",
                },
            ],
        },
        {
            checkpoint: 0.25,
            actions: [
                {
                    signer: user2,
                    amount: baseAmount.div(3),
                    action: "deposit",
                },
            ],
        },
        {
            checkpoint: 0.5,
            actions: [
                {
                    signer: user3,
                    amount: baseAmount.div(3).mul(2),
                    action: "deposit",
                },
            ],
        },
        {
            checkpoint: 0.75,
            actions: [
                {
                    signer: user4,
                    amount: baseAmount.mul(2),
                    action: "deposit",
                },
            ],
        },
    ];

    const rewards: RewardInfo[] = [
        {
            signer: user1,
            expectedReward: totalRewardsBase.mul(6250),
        },
        {
            signer: user2,
            expectedReward: totalRewardsBase.mul(1250),
        },
        {
            signer: user3,
            expectedReward: totalRewardsBase.mul(1250),
        },
        {
            signer: user4,
            expectedReward: totalRewardsBase.mul(1250),
        },
    ];

    return { actions, rewards };
};

export const setupAdvancedScenario2 = (ctx: TestContext): ScenarioInfo => {
    // Advanced Scenario 2:
    // differnet stake times, depositor overlap, with claiming
    //
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = -1000: 100                0               0               0
    // At T = -500:    0                0               0               0
    // At T = 0:       0               75              25               0
    // At T = 0.25:    0                0              10              90
    // At T = 0.5: 16.67                0            8.33              75
    // At T = 0.75:13.33               20            6.67              60
    // Totals:       7.5            23.75            12.5           56.25

    const {
        users: [user1, user2, user3, user4],
    } = ctx;

    const baseAmount = ether("100");
    const totalRewardsBase = TOTAL_REWARDS.div(10000);

    const actions: Action[] = [
        {
            checkpoint: -1,
            actions: [
                {
                    signer: user1,
                    amount: baseAmount,
                    action: "deposit",
                },
            ],
        },
        {
            checkpoint: -0.5,
            actions: [
                {
                    signer: user1,
                    amount: 0,
                    action: "withdraw",
                },
            ],
        },
        {
            checkpoint: 0,
            actions: [
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "deposit",
                },
                {
                    signer: user3,
                    amount: baseAmount,
                    action: "deposit",
                },
            ],
        },
        {
            checkpoint: 0.25,
            actions: [
                {
                    signer: user4,
                    amount: baseAmount.mul(9),
                    action: "deposit",
                },
                {
                    signer: user2,
                    amount: 0,
                    action: "withdrawAndHarvest",
                },
            ],
        },
        {
            checkpoint: 0.5,
            actions: [
                {
                    signer: user1,
                    amount: baseAmount.mul(2),
                    action: "deposit",
                },
                {
                    signer: user3,
                    amount: 0,
                    action: "harvest",
                },
            ],
        },
        {
            checkpoint: 0.75,
            actions: [
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "deposit",
                },
            ],
        },
    ];

    const rewards: RewardInfo[] = [
        {
            signer: user1,
            expectedReward: totalRewardsBase.mul(750),
        },
        {
            signer: user2,
            expectedReward: totalRewardsBase.mul(2375),
        },
        {
            signer: user3,
            expectedReward: totalRewardsBase.mul(1250),
        },
        {
            signer: user4,
            expectedReward: totalRewardsBase.mul(5625),
        },
    ];

    return { actions, rewards };
};

export const runScenario = async (
    ctx: TestContext,
    actions: Action[],
    logCheckpoints = false,
): Promise<{ [user: string]: BigNumberish }> => {
    const { pool, streamingStash, magic } = ctx;
    const claims: { [user: string]: BigNumberish } = {};

    const defaultPoolId = 0;
    const allPoolIds = [defaultPoolId];

    const duration = ONE_DAY_SEC * PROGRAM_DAYS;
    let rewardsStarted = false;
    let start: number;
    let end: number;

    // Run through scenario from beginning of program until end
    for (const batch of actions) {
        const { checkpoint, actions: batchActions } = batch;
        let timestamp: number;

        // If checkpoint >= 0, and not yet started, start rewards
        if (checkpoint >= 0 && !rewardsStarted) {
            await magic.mint(streamingStash.address, TOTAL_REWARDS);
            await streamingStash.startStream(TOTAL_REWARDS, duration);

            start = await ethers.provider.getBlock("latest").then(b => b.timestamp);
            end = start + duration;
            rewardsStarted = true;
        }

        if (checkpoint > 0) {
            if (!start!) throw new Error("Rewards not started");

            // Determine timestamp for this checkpoint and roll to it
            timestamp = start + duration * checkpoint;
            await setNextBlockTimestamp(timestamp);

            // Make sure any accrual happens for previous time
            await pool.pullRewards(streamingStash.address);
        }

        let tx: ContractTransaction;

        // Shuffle actions to ensure rewards not time-based per batch
        for (const a of shuffle(batchActions)) {
            const { signer, amount, action } = a;
            const pid = a.poolId ?? defaultPoolId;

            if (allPoolIds.indexOf(pid) === -1) allPoolIds.push(pid);

            if (action === "deposit") {
                tx = await pool.connect(signer).deposit(pid, amount, signer.address);
            } else if (action === "harvest") {
                // No need to roll, just claim - keep track of amount rewarded
                tx = await pool.connect(signer).harvest(pid, signer.address);
                const receipt = await tx.wait();

                const harvestEvents = receipt.events?.filter(e => e.event === "Harvest");

                let reward = ethers.BigNumber.from(0);
                for (const event of harvestEvents!) {
                    expect(event).to.not.be.undefined;
                    expect(event?.args?.[0]).to.eq(signer.address);
                    expect(event?.args?.[1]).to.eq(pid);

                    reward = reward.add(event?.args?.[2]);
                }

                if (claims[signer.address]) {
                    claims[signer.address] = ethers.BigNumber.from(claims[signer.address]).add(reward);
                } else {
                    claims[signer.address] = reward;
                }
            } else if (action === "withdraw") {
                // Figure out withdraw amount
                const [amount] = await pool.getUserInfo(pid, signer.address);
                tx = await pool.connect(signer).withdraw(pid, amount, signer.address);
                const receipt = await tx.wait();

                const withdrawEvents = receipt.events?.filter(e => e.event === "Withdraw");

                for (const event of withdrawEvents!) {
                    expect(event).to.not.be.undefined;
                    expect(event?.args?.[0]).to.eq(signer.address);
                    expect(event?.args?.[1]).to.eq(pid);
                    expect(event?.args?.[2]).to.eq(amount);
                    expect(event?.args?.[3]).to.eq(signer.address);
                }
            } else if (action === "withdrawPartial") {
                tx = await pool.connect(signer).withdraw(pid, a.amount, signer.address);
                const receipt = await tx.wait();

                const withdrawEvents = receipt.events?.filter(e => e.event === "Withdraw");

                for (const event of withdrawEvents!) {
                    expect(event).to.not.be.undefined;
                    expect(event?.args?.[0]).to.eq(signer.address);
                    expect(event?.args?.[1]).to.eq(pid);
                    expect(event?.args?.[2]).to.eq(a.amount);
                    expect(event?.args?.[3]).to.eq(signer.address);
                }
            }
            if (action === "withdrawAndHarvest") {
                // Figure out withdraw amount
                const [amount] = await pool.getUserInfo(pid, signer.address);
                tx = await pool.connect(signer).withdrawAndHarvest(pid, amount, signer.address);
                const receipt = await tx.wait();

                const withdrawEvents = receipt.events?.filter(e => e.event === "Withdraw");

                for (const event of withdrawEvents!) {
                    expect(event).to.not.be.undefined;
                    expect(event?.args?.[0]).to.eq(signer.address);
                    expect(event?.args?.[1]).to.eq(pid);
                    expect(event?.args?.[2]).to.eq(amount);
                    expect(event?.args?.[3]).to.eq(signer.address);
                }

                const harvestEvents = receipt.events?.filter(e => e.event === "Harvest");

                let reward = ethers.BigNumber.from(0);
                for (const event of harvestEvents!) {
                    expect(event).to.not.be.undefined;
                    expect(event?.args?.[0]).to.eq(signer.address);
                    expect(event?.args?.[1]).to.eq(pid);

                    reward = reward.add(event?.args?.[2]);
                }

                if (claims[signer.address]) {
                    claims[signer.address] = ethers.BigNumber.from(claims[signer.address]).add(reward);
                } else {
                    claims[signer.address] = reward;
                }
            } else if (action === "withdrawPartialAndHarvest") {
                tx = await pool.connect(signer).withdrawAndHarvest(pid, a.amount, signer.address);
                const receipt = await tx.wait();

                const withdrawEvents = receipt.events?.filter(e => e.event === "Withdraw");

                for (const event of withdrawEvents!) {
                    expect(event).to.not.be.undefined;
                    expect(event?.args?.[0]).to.eq(signer.address);
                    expect(event?.args?.[1]).to.eq(pid);
                    expect(event?.args?.[2]).to.eq(a.amount);
                    expect(event?.args?.[3]).to.eq(signer.address);
                }

                const harvestEvents = receipt.events?.filter(e => e.event === "Harvest");

                let reward = ethers.BigNumber.from(0);
                for (const event of harvestEvents!) {
                    expect(event).to.not.be.undefined;
                    expect(event?.args?.[0]).to.eq(signer.address);
                    expect(event?.args?.[1]).to.eq(pid);

                    reward = reward.add(event?.args?.[2]);
                }

                if (claims[signer.address]) {
                    claims[signer.address] = ethers.BigNumber.from(claims[signer.address]).add(reward);
                } else {
                    claims[signer.address] = reward;
                }
            }
        }

        await tx!.wait();

        // Actions for timestamp done

        if (logCheckpoints) {
            // Report balances for all coins
            const { users, token } = ctx;

            console.log();
            console.log("Timestamp:", timestamp!);

            for (const poolId of allPoolIds) {
                console.log();
                console.log(`Total Staked in pool ${poolId}`, (await pool.poolInfo(poolId)).totalStaked);
                console.log("Balances for pool", poolId);
                for (const user of users.slice(0, 4)) {
                    console.log();
                    console.log(`Wallet balance (${user.address}): ${await token.balanceOf(user.address)}`);
                    console.log(
                        `Staker balance (${user.address}): ${(await pool.userInfo(poolId, user.address)).amount}`,
                    );
                }
            }
        }
    }

    // Now roll to end - all staking should be processed
    await setNextBlockTimestamp(end!);
    await ethers.provider.send("evm_mine", []);

    // Pull one more set of rewards
    await pool.pullRewards(streamingStash.address);

    return claims;
};
