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
    pullFrom?: { stash: BasicDragonStash; amount: BigNumberish };
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
    // different stake times, depositor overlap, with claiming
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

export const setupAdvancedScenario3 = (ctx: TestContext): ScenarioInfo => {
    // Advanced Scenario 3:
    // multiple pools, depositor overlap, multiple deposits
    //
    // Pool 1 (75% reward share)
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:      0                60              40               0
    // At T = 0.25:   0             21.43           14.29           64.29
    // At T = 0.5:    0             21.43           14.29           64.29
    // At T = 0.75:   0             35.29           11.76           52.94
    // Totals:        0           34.5375          20.085           45.38
    //
    // Pool 2 (25% reward share)
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:        0               100               0               0
    // At T = 0.25:    50                 0              50               0
    // At T = 0.5:     20                60              20               0
    // At T = 0.75: 14.29             42.86           14.29           28.57
    // Totals:    21.0725            50.715         21.0725          7.1425
    //
    // Combined Totals:
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:         0               70              30               0
    // At T = 0.25:   12.5          16.0725         23.2175         48.2175
    // At T = 0.5:       5          31.0725         15.7175         48.2175
    // At T = 0.75: 3.5725          37.1825         12.3925         46.8475
    // Totals:      5.2681          38.5819         20.3319         35.8206

    const {
        users: [user1, user2, user3, user4],
    } = ctx;

    const baseAmount = ether("100");
    const totalRewardsBase = TOTAL_REWARDS.div(10000);

    const actions: Action[] = [
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
                    amount: baseAmount.mul(2),
                    action: "deposit",
                },
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "deposit",
                    poolId: 1,
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
                    poolId: 1,
                },
                {
                    signer: user1,
                    amount: baseAmount,
                    action: "deposit",
                    poolId: 1,
                },
                {
                    signer: user3,
                    amount: baseAmount,
                    action: "deposit",
                    poolId: 1,
                },
            ],
        },
        {
            checkpoint: 0.5,
            actions: [
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "deposit",
                    poolId: 1,
                },
                {
                    signer: user3,
                    amount: 0,
                    action: "harvest",
                },
                {
                    signer: user3,
                    amount: 0,
                    action: "harvest",
                    poolId: 1,
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
                {
                    signer: user4,
                    amount: baseAmount.mul(2),
                    action: "deposit",
                    poolId: 1,
                },
            ],
        },
    ];

    const rewards: RewardInfo[] = [
        {
            signer: user1,
            expectedReward: totalRewardsBase.mul(527),
        },
        {
            signer: user2,
            expectedReward: totalRewardsBase.mul(3858),
        },
        {
            signer: user3,
            expectedReward: totalRewardsBase.mul(2033),
        },
        {
            signer: user4,
            expectedReward: totalRewardsBase.mul(3582),
        },
    ];

    return { actions, rewards };
};

export const setupAdvancedScenario4 = (ctx: TestContext): ScenarioInfo => {
    // Advanced Scenario 4:
    // multiple pools, depositor overlap, with partial withdrawals
    //
    // Pool 1 (75% reward share)
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:       50                30              20               0
    // At T = 0.25: 26.31             15.79           10.53           47.37
    // At T = 0.5:  13.33                20           13.33           53.33
    // At T = 0.75: 11.11             33.33           11.11           44.44
    // Totals:    25.1875             24.78         13.7425          36.285
    //
    // Pool 2 (25% reward share)
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:        0               100               0               0
    // At T = 0.25:    25                50              25               0
    // At T = 0.5:  14.29             71.43           14.29               0
    // At T = 0.75: 16.66             33.33           16.66           33.33
    // Totals:    13.9875             63.69         13.9875          8.3325
    //
    // Combined Totals:
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:       37.5             47.5              15               0
    // At T = 0.25:   25.98          24.3425         14.1475         35.5275
    // At T = 0.5:    13.57          32.8575           13.57         39.9975
    // At T = 0.75: 12.4975            33.33         12.4975         41.6625
    // Totals:      22.3875          34.5075         13.8038         29.2969

    const {
        users: [user1, user2, user3, user4],
    } = ctx;

    const baseAmount = ether("100");
    const totalRewardsBase = TOTAL_REWARDS.div(10000);

    const actions: Action[] = [
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
                    amount: baseAmount.mul(2),
                    action: "deposit",
                },
                {
                    signer: user1,
                    amount: baseAmount.mul(5),
                    action: "deposit",
                },
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "deposit",
                    poolId: 1,
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
                    amount: baseAmount,
                    action: "withdrawPartial",
                    poolId: 1,
                },
                {
                    signer: user1,
                    amount: baseAmount,
                    action: "deposit",
                    poolId: 1,
                },
                {
                    signer: user3,
                    amount: baseAmount,
                    action: "deposit",
                    poolId: 1,
                },
            ],
        },
        {
            checkpoint: 0.5,
            actions: [
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "deposit",
                    poolId: 1,
                },
                {
                    signer: user3,
                    amount: 0,
                    action: "harvest",
                },
                {
                    signer: user3,
                    amount: 0,
                    action: "harvest",
                    poolId: 1,
                },
                {
                    signer: user1,
                    amount: baseAmount.mul(3),
                    action: "withdrawPartialAndHarvest",
                },
                {
                    signer: user4,
                    amount: baseAmount,
                    action: "withdrawPartial",
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
                {
                    signer: user4,
                    amount: baseAmount.mul(2),
                    action: "deposit",
                    poolId: 1,
                },
                {
                    signer: user4,
                    amount: 0,
                    action: "harvest",
                },
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "withdrawPartialAndHarvest",
                    poolId: 1,
                },
            ],
        },
    ];

    const rewards: RewardInfo[] = [
        {
            signer: user1,
            expectedReward: totalRewardsBase.mul(2239),
        },
        {
            signer: user2,
            expectedReward: totalRewardsBase.mul(3451),
        },
        {
            signer: user3,
            expectedReward: totalRewardsBase.mul(1381),
        },
        {
            signer: user4,
            expectedReward: totalRewardsBase.mul(2930),
        },
    ];

    return { actions, rewards };
};

export const setupAdvancedScenario5 = (ctx: TestContext): ScenarioInfo => {
    // Advanced Scenario 4:
    // same as scenario 4, with multiple stashes
    // 50% of stash released at T = 0.5, 50% released at T = 0.75
    // Rewards based on previous checkpoint
    //
    // Pool 1 (75% reward share)
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:       50                30              20               0
    // At T = 0.25: 26.31             15.79           10.53           47.37
    // At T = 0.5:  13.33                20           13.33           53.33
    // At T = 0.75: 11.11             33.33           11.11           44.44
    // Totals:    25.1875             24.78         13.7425          36.285
    //
    // Pool 2 (25% reward share)
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:        0               100               0               0
    // At T = 0.25:    25                50              25               0
    // At T = 0.5:  14.29             71.43           14.29               0
    // At T = 0.75: 16.66             33.33           16.66           33.33
    // Totals:    13.9875             63.69         13.9875          8.3325
    //
    // Combined Totals For Streaming Rewards:
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // At T = 0:       37.5             47.5              15               0
    // At T = 0.25:   25.98          24.3425         14.1475         35.5275
    // At T = 0.5:    13.57          32.8575           13.57         39.9975
    // At T = 0.75: 12.4975            33.33         12.4975         41.6625
    // Totals:      22.3875          34.5075         13.8038         29.2969
    //
    // Totals for Basic Stash Rewards (Pool 1):
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // Totals:      19.82             17.895           11.93          50.35
    //
    // Totals for Basic Stash Rewards (Pool 2):
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // Totals:      19.64             60.72            19.64              0
    //
    // Totals for Basic Stash Rewards (Combined):
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // Totals:      19.8               28.6          13.8575         37.7625
    //
    // Total Rewards:
    //            Staker 1 %        Staker 2 %      Staker 3 %     Staker 4 %
    // Totals:      21.0938           31.5538        13.8307           33.53

    const {
        users: [user1, user2, user3, user4],
    } = ctx;

    const baseAmount = ether("100");

    // Multiply by 2 to account for 2 stashes
    const totalRewardsBase = TOTAL_REWARDS.div(10000).mul(2);

    const actions: Action[] = [
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
                    amount: baseAmount.mul(2),
                    action: "deposit",
                },
                {
                    signer: user1,
                    amount: baseAmount.mul(5),
                    action: "deposit",
                },
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "deposit",
                    poolId: 1,
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
                    amount: baseAmount,
                    action: "withdrawPartial",
                    poolId: 1,
                },
                {
                    signer: user1,
                    amount: baseAmount,
                    action: "deposit",
                    poolId: 1,
                },
                {
                    signer: user3,
                    amount: baseAmount,
                    action: "deposit",
                    poolId: 1,
                },
            ],
        },
        {
            checkpoint: 0.5,
            pullFrom: {
                stash: ctx.basicStash,
                amount: TOTAL_REWARDS.div(2),
            },
            actions: [
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "deposit",
                    poolId: 1,
                },
                {
                    signer: user3,
                    amount: 0,
                    action: "harvest",
                },
                {
                    signer: user3,
                    amount: 0,
                    action: "harvest",
                    poolId: 1,
                },
                {
                    signer: user1,
                    amount: baseAmount.mul(3),
                    action: "withdrawPartialAndHarvest",
                },
                {
                    signer: user4,
                    amount: baseAmount,
                    action: "withdrawPartial",
                },
            ],
        },
        {
            checkpoint: 0.75,
            pullFrom: {
                stash: ctx.basicStash,
                amount: TOTAL_REWARDS.div(2),
            },
            actions: [
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "deposit",
                },
                {
                    signer: user4,
                    amount: baseAmount.mul(2),
                    action: "deposit",
                    poolId: 1,
                },
                {
                    signer: user4,
                    amount: 0,
                    action: "harvest",
                },
                {
                    signer: user2,
                    amount: baseAmount.mul(3),
                    action: "withdrawPartialAndHarvest",
                    poolId: 1,
                },
            ],
        },
    ];

    const rewards: RewardInfo[] = [
        {
            signer: user1,
            expectedReward: totalRewardsBase.mul(2109),
        },
        {
            signer: user2,
            expectedReward: totalRewardsBase.mul(3155),
        },
        {
            signer: user3,
            expectedReward: totalRewardsBase.mul(1383),
        },
        {
            signer: user4,
            expectedReward: totalRewardsBase.mul(3353),
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
        const { checkpoint, actions: batchActions, pullFrom } = batch;
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

            if (pullFrom) {
                const { stash, amount } = pullFrom;

                await magic.mint(stash.address, amount);
                await pool.pullRewards(stash.address);
            }
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
