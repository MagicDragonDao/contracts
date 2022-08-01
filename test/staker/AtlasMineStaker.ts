/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ethers, waffle } from "hardhat";
import { BigNumberish, ContractTransaction } from "ethers";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect, should } from "chai";

const { loadFixture } = waffle;

import { deploy, deployUpgradeable, increaseTime } from "../utils";
import type { AtlasMineStakerUpgradeable as AtlasMineStaker } from "../../src/types/AtlasMineStakerUpgradeable";
import type { MasterOfCoin } from "../../src/types/MasterOfCoin";
import type { MockLegionMetadataStore } from "../../src/types/MockLegionMetadataStore";
import type { AtlasMine } from "../../src/types/AtlasMine";
import type { TestERC20 } from "../../src/types/TestERC20";
import type { TestERC1155 } from "../../src/types/TestERC1155";
import type { TestERC721 } from "../../src/types/TestERC721";

import {
    TestContext,
    stakeSingle,
    stakeMultiple,
    withdrawSingle,
    withdrawExactDeposit,
    claimSingle,
    accrue,
    rollSchedule,
    rollLock,
    rollTo,
    rollToDepositWindow,
    expectRoundedEqual,
    setup5050Scenario,
    setup7525Scenario,
    setupAdvancedScenario1,
    setupAdvancedScenario2,
    setupAdvancedScenario3,
    setupAdvancedScenario4,
    setupAdvancedScenario5,
    setupAdvancedScenario6,
    runScenario,
    withdrawWithRoundedRewardCheck,
    claimWithRoundedRewardCheck,
    rollToPartialWindow,
    TOTAL_REWARDS,
    ACCRUAL_WINDOWS,
    shuffle,
    ONE_DAY_SEC,
    PROGRAM_DAYS,
    rollToNearestAccrual,
} from "./helpers";

const ether = ethers.utils.parseEther;

describe("Atlas Mine Staking (Pepe Pool)", () => {
    let ctx: TestContext;
    let USER_INITIAL_BALANCE = ether("100000");

    const fixture = async (): Promise<TestContext> => {
        const signers = await ethers.getSigners();
        const [admin, ...users] = signers.slice(0, 5);

        // Deploy contracts
        const magic = <TestERC20>await deploy("TestERC20", admin, []);
        const treasures = <TestERC1155>await deploy("TestERC1155", admin, []);
        const legions = <TestERC721>await deploy("TestERC721", admin, []);

        const masterOfCoin = <MasterOfCoin>await deploy("MasterOfCoin", admin, []);
        await masterOfCoin.init(magic.address);

        const metadataStore = <MockLegionMetadataStore>await deploy("MockLegionMetadataStore", admin, []);

        const mine = <AtlasMine>await deploy("AtlasMine", admin, []);
        await mine.init(magic.address, masterOfCoin.address);
        await mine.setTreasure(treasures.address);
        await mine.setLegion(legions.address);
        await mine.setLegionMetadataStore(metadataStore.address);
        await mine.setUtilizationOverride(ether("1"));

        const staker = <AtlasMineStaker>await deployUpgradeable("AtlasMineStakerUpgradeable", admin, [
            magic.address,
            mine.address,
            0, // 0 == AtlasMine.Lock.twoWeeks
        ]);

        // Devote first half of day to accruing
        await staker.setAccrualWindows(ACCRUAL_WINDOWS);

        // Distribute coins and set up staking program
        await magic.mint(admin.address, ether("10000"));
        await magic.mint(masterOfCoin.address, TOTAL_REWARDS.mul(2));

        const DAY_SEC = 86400;
        // Put start time in the future - we will fast-forward
        const start = Math.floor(Date.now() / 1000) + 10_000_000;
        const end = start + PROGRAM_DAYS * DAY_SEC;

        // 0.01 MAGIC per second, 864 per day
        await masterOfCoin.addStream(mine.address, TOTAL_REWARDS, start, end, false);

        // Give 100000 MAGIC to each user and approve the staker contract
        const stakerFunding = users.map(u => magic.mint(u.address, USER_INITIAL_BALANCE));
        const stakerApprove = users.map(u => magic.connect(u).approve(staker.address, USER_INITIAL_BALANCE));
        await Promise.all(stakerFunding.concat(stakerApprove));

        return {
            signers,
            admin,
            users,
            magic,
            treasures,
            legions,
            masterOfCoin,
            mine,
            metadataStore,
            staker,
            start,
            end,
        };
    };

    beforeEach(async () => {
        ctx = await loadFixture(fixture);
    });

    describe("Initialization", () => {
        const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

        it("reverts if the MAGIC token address is initialized to 0", async () => {
            const { admin, mine } = ctx;

            const impl = await deploy("AtlasMineStakerUpgradeable", admin, []);

            // Deploy proxy
            const proxyAdminFactory = await ethers.getContractFactory("ProxyAdmin");
            const proxyAdmin = await proxyAdminFactory.deploy();

            const proxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy");
            const proxy = await proxyFactory.deploy(impl.address, proxyAdmin.address, Buffer.from(""));
            const staker = <AtlasMineStaker>await ethers.getContractAt("AtlasMineStakerUpgradeable", proxy.address);

            await expect(staker.initialize(ZERO_ADDRESS, mine.address, 0)).to.be.revertedWith(
                "Invalid magic token address",
            );
        });

        it("reverts if the atlas mine address is initialized to 0", async () => {
            const { admin, magic } = ctx;

            const impl = await deploy("AtlasMineStakerUpgradeable", admin, []);

            // Deploy proxy
            const proxyAdminFactory = await ethers.getContractFactory("ProxyAdmin");
            const proxyAdmin = await proxyAdminFactory.deploy();

            const proxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy");
            const proxy = await proxyFactory.deploy(impl.address, proxyAdmin.address, Buffer.from(""));
            const staker = <AtlasMineStaker>await ethers.getContractAt("AtlasMineStakerUpgradeable", proxy.address);

            await expect(staker.initialize(magic.address, ZERO_ADDRESS, 0)).to.be.revertedWith(
                "Invalid mine contract address",
            );
        });
    });

    describe("Staking", () => {
        beforeEach(async () => {
            await rollToDepositWindow();
        });

        describe("stake", () => {
            it("does not allow a user to stake if their specified amount is 0", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await expect(stakeSingle(staker, user, 0)).to.be.revertedWith("Deposit amount 0");
            });

            it("allows a user to stake", async () => {
                const {
                    users: [user],
                    staker,
                    magic,
                } = ctx;

                const amount = ether("10");

                await expect(stakeSingle(staker, user, amount))
                    .to.emit(staker, "UserDeposit")
                    .withArgs(user.address, amount);

                expect(await staker.userTotalStake(user.address)).to.eq(amount);
                expect(await magic.balanceOf(user.address)).to.eq(ether("99990"));
            });
        });

        describe("withdraw", () => {
            it("does not allow a user to withdraw if they have not staked", async () => {
                const {
                    users: [user1, user2],
                    staker,
                } = ctx;
                await stakeSingle(staker, user1, ether("10"));

                const lastDepositId = await staker.currentId(user1.address);
                await expect(withdrawExactDeposit(staker, user2, lastDepositId)).to.be.revertedWith("No deposit");
            });

            it("does not allow a user to withdraw if the amount specified is 0", async () => {
                const {
                    users: [user1],
                    staker,
                } = ctx;

                // Stake more than rewards to force a withdraw
                // With 2 stakers, each will earn 7000 MAGIC over lock period
                await stakeSingle(staker, user1, ether("10"));
                await rollSchedule(staker);

                // Fast-forward through stake and mine a block
                await rollLock();
                await ethers.provider.send("evm_mine", []);

                await rollToDepositWindow();

                const lastDepositId = await staker.currentId(user1.address);
                await expect(
                    withdrawExactDeposit(staker, user1, lastDepositId, ethers.BigNumber.from(0)),
                ).to.be.revertedWith("Withdraw amount 0");
            });

            it("does not allow a user to withdraw if their last deposit is more recent than the lock time", async () => {
                const {
                    users: [user],
                    staker,
                    start,
                } = ctx;

                await rollTo(start + ONE_DAY_SEC);
                const firstStakeTs = await rollToDepositWindow();

                await stakeSingle(staker, user, ether("10"));
                const firstDepositId = await staker.currentId(user.address);

                await rollSchedule(staker, firstStakeTs);
                await rollToDepositWindow();

                await expect(withdrawExactDeposit(staker, user, firstDepositId)).to.be.revertedWith("Deposit locked");

                // Roll forward 7 days and stake again
                await rollTo(firstStakeTs + ONE_DAY_SEC * 7);
                await stakeSingle(staker, user, ether("10"));
                const secondDepositId = await staker.currentId(user.address);

                // Roll lock and try to withdraw
                await rollLock(firstStakeTs);
                await expect(withdrawExactDeposit(staker, user, secondDepositId)).to.be.revertedWith("Deposit locked");
                await expect(withdrawExactDeposit(staker, user, firstDepositId)).to.not.be.reverted;
            });

            it("efficiently unstakes locked coins to retain as much reward-earning deposit as possible", async () => {
                const {
                    users: [user1, user2],
                    staker,
                    magic,
                    mine,
                } = ctx;

                // Stake more than rewards to force a withdraw
                // With 2 stakers, each will earn 7000 MAGIC over lock period
                const stakeTime = await rollToDepositWindow();
                const amount = ether("20000");
                await stakeMultiple(staker, [
                    [user1, amount],
                    [user2, amount],
                ]);

                await rollSchedule(staker, stakeTime);

                // Fast-forward and try to withdraw - other 10 should stay
                await rollLock(stakeTime);
                await ethers.provider.send("evm_mine", []);

                await accrue(staker);
                await rollToDepositWindow();

                // No rewards because program hasn't started yet
                await expect(withdrawSingle(staker, user1))
                    .to.emit(staker, "UserWithdraw")
                    .withArgs(user1.address, 1, amount, 0);

                // User returned all funds
                expect(await magic.balanceOf(user1.address)).to.eq(USER_INITIAL_BALANCE);

                // Check that rest of stake is still in AtlasMine, not staker
                const depositId = await mine.currentId(staker.address);
                const stakeInfo = await mine.userInfo(staker.address, depositId);
                expect(stakeInfo.originalDepositAmount).to.eq(amount.mul(2));
                expect(stakeInfo.depositAmount).to.eq(amount);
            });

            it("withdraws a single deposit", async () => {
                const {
                    users: [user1],
                    staker,
                    magic,
                    start,
                    end,
                } = ctx;

                const amount = ether("20000");
                await stakeMultiple(staker, [
                    [user1, amount],
                    [user1, amount],
                ]);

                // Go to start of rewards program
                await rollTo(start);

                // Make a tx to deposit
                const tx = await staker.stakeScheduled();
                await tx.wait();

                await rollToPartialWindow(start, end, 0.5);
                await accrue(staker);
                await rollToDepositWindow();

                // Fast-forwarded halfway through program
                const depositId = 1;
                const expectedReward = TOTAL_REWARDS.div(4);
                const withdrawTx = <ContractTransaction>await staker.connect(user1).withdraw(depositId, amount);
                const receipt = await withdrawTx.wait();

                const withdrawEvent = receipt.events?.find(e => e.event === "UserWithdraw");
                expect(withdrawEvent).to.not.be.undefined;
                expect(withdrawEvent?.args?.[0]).to.eq(user1.address);
                expect(withdrawEvent?.args?.[1]).to.eq(depositId);
                expect(withdrawEvent?.args?.[2]).to.eq(amount);
                // Should get 1/4 of rewards for a single stake over half the reward lifetime
                expectRoundedEqual(withdrawEvent?.args?.[3], expectedReward);

                // User returned a single stake + reward
                expectRoundedEqual(
                    await magic.balanceOf(user1.address),
                    USER_INITIAL_BALANCE.sub(amount).add(expectedReward),
                );
            });

            it("withdraws the entire deposit if the specified amount is larger than the deposit amount", async () => {
                const {
                    users: [user1],
                    staker,
                    magic,
                    start,
                    end,
                } = ctx;

                const amount = ether("20000");
                await stakeMultiple(staker, [
                    [user1, amount],
                    [user1, amount],
                ]);

                // Go to start of rewards program
                await rollTo(start);

                // Make a tx to deposit
                const tx = await staker.stakeScheduled();
                await tx.wait();

                await rollToPartialWindow(start, end, 0.5);
                await accrue(staker);
                await rollToDepositWindow();

                // Fast-forward in scenarios - 1.3mm seconds should pass,
                // so 13k MAGIC to pool. First user stake should get half
                const depositId = 1;
                const expectedReward = TOTAL_REWARDS.div(4);

                // Same as last test, but 100x the amount
                const withdrawTx = <ContractTransaction>(
                    await staker.connect(user1).withdraw(depositId, amount.mul(100))
                );
                const receipt = await withdrawTx.wait();

                const withdrawEvent = receipt.events?.find(e => e.event === "UserWithdraw");
                expect(withdrawEvent).to.not.be.undefined;
                expect(withdrawEvent?.args?.[0]).to.eq(user1.address);
                expect(withdrawEvent?.args?.[1]).to.eq(depositId);
                expect(withdrawEvent?.args?.[2]).to.eq(amount);
                expectRoundedEqual(withdrawEvent?.args?.[3], expectedReward);

                // User returned a single stake + reward
                expectRoundedEqual(
                    await magic.balanceOf(user1.address),
                    USER_INITIAL_BALANCE.sub(amount).add(expectedReward),
                );
            });

            it("withdrawal distributes the correct amount of pro rata rewards", async () => {
                const {
                    users: [user1],
                    staker,
                    magic,
                } = ctx;

                const { stakes } = await setup5050Scenario(ctx);

                const expectedReward = TOTAL_REWARDS.div(2);
                await withdrawWithRoundedRewardCheck(staker, user1, stakes[user1.address], expectedReward);

                // User returned all funds + reward
                expectRoundedEqual(await magic.balanceOf(user1.address), USER_INITIAL_BALANCE.add(expectedReward));
            });

            it("withdrawal distributes the correct amount of pro rata rewards (multiple deposit times)", async () => {
                const {
                    users: [user1, user2],
                    staker,
                    magic,
                } = ctx;

                const { stakes } = await setup7525Scenario(ctx);

                const user1ExpectedReward = TOTAL_REWARDS.div(4).mul(3);
                const user2ExpectedReward = TOTAL_REWARDS.div(4);

                await withdrawWithRoundedRewardCheck(staker, user1, stakes[user1.address], user1ExpectedReward);
                await withdrawWithRoundedRewardCheck(staker, user2, stakes[user2.address], user2ExpectedReward);

                // User returned all funds + reward
                expectRoundedEqual(await magic.balanceOf(user1.address), USER_INITIAL_BALANCE.add(user1ExpectedReward));
                expectRoundedEqual(await magic.balanceOf(user2.address), USER_INITIAL_BALANCE.add(user2ExpectedReward));
            });
        });

        describe("claim", () => {
            it("claims rewards for a single deposit", async () => {
                const {
                    users: [user1],
                    staker,
                    magic,
                    start,
                } = ctx;

                const amount = ether("20000");
                await stakeMultiple(staker, [
                    [user1, amount],
                    [user1, amount],
                ]);

                // Go to start of rewards program
                await rollTo(start);

                // Make a tx to deposit
                const tx = await staker.stakeScheduled();
                await tx.wait();

                await rollLock(start);
                await accrue(staker);
                await rollToDepositWindow();

                // Fast-forward in scenarios - 1.3mm seconds should pass,
                // so 13k MAGIC to pool. First user stake should get half
                const depositId = 1;
                const claimTx = <ContractTransaction>await staker.connect(user1).claim(depositId);
                const receipt = await claimTx.wait();

                const claimEvent = receipt.events?.find(e => e.event === "UserClaim");
                expect(claimEvent).to.not.be.undefined;
                expect(claimEvent?.args?.[0]).to.eq(user1.address);
                expect(claimEvent?.args?.[1]).to.eq(depositId);
                expectRoundedEqual(claimEvent?.args?.[2], ether("6500"));

                // User returned a single stake + reward
                expectRoundedEqual(await magic.balanceOf(user1.address), ether("66500"));
            });

            it("distributes the correct amount of pro rata rewards", async () => {
                const {
                    users: [user],
                    staker,
                    magic,
                } = ctx;

                const { stakes } = await setup5050Scenario(ctx);

                const expectedReward = TOTAL_REWARDS.div(2);
                await claimWithRoundedRewardCheck(staker, user, expectedReward);

                // User returned all funds + reward
                expectRoundedEqual(
                    await magic.balanceOf(user.address),
                    USER_INITIAL_BALANCE.sub(stakes[user.address]).add(expectedReward),
                );
            });

            it("distributes the correct amount of pro rata rewards (multiple deposit times)", async () => {
                const {
                    users: [user1, user2],
                    staker,
                    magic,
                } = ctx;

                const { stakes } = await setup7525Scenario(ctx);

                const user1ExpectedReward = TOTAL_REWARDS.div(4).mul(3);
                const user2ExpectedReward = TOTAL_REWARDS.div(4);

                await claimWithRoundedRewardCheck(staker, user1, user1ExpectedReward);
                await claimWithRoundedRewardCheck(staker, user2, user2ExpectedReward);

                // Reward distribued to user
                expectRoundedEqual(
                    await magic.balanceOf(user1.address),
                    USER_INITIAL_BALANCE.sub(stakes[user1.address]).add(user1ExpectedReward),
                );
                expectRoundedEqual(
                    await magic.balanceOf(user2.address),
                    USER_INITIAL_BALANCE.sub(stakes[user2.address]).add(user2ExpectedReward),
                );
            });

            it("should not allow a user to claim twice", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await setup5050Scenario(ctx);

                const expectedReward = TOTAL_REWARDS.div(2);
                await claimWithRoundedRewardCheck(staker, user, expectedReward);
                // Claim again, get very small rewards - 1 second passed
                await claimWithRoundedRewardCheck(staker, user, 0);
            });
        });

        describe("stakeScheduled", async () => {
            it("does not allow staking again less than 12 hours since last staking", async () => {
                const {
                    users: [user],
                    staker,
                    start,
                } = ctx;

                const firstStakeTs = await rollTo(start + ONE_DAY_SEC);
                await ethers.provider.send("evm_mine", []);
                await rollToDepositWindow();

                await stakeSingle(staker, user, ether("10"));
                await rollSchedule(staker, firstStakeTs);

                await expect(staker.stakeScheduled()).to.be.revertedWith("not enough time since last stake");
            });

            it("is able to correctly stake scheduled after a withdraw from the holding pool", async () => {
                const {
                    users: [user1, user2],
                    staker,
                    start,
                } = ctx;

                // Stake, and roll the schedule
                const firstStakeTs = await rollTo(start + ONE_DAY_SEC);
                await ethers.provider.send("evm_mine", []);
                await rollToDepositWindow();

                await stakeSingle(staker, user1, ether("1000"));

                expect(await staker.totalPendingStake()).to.equal(ether("1000"));

                await rollSchedule(staker, firstStakeTs);

                expect(await staker.totalPendingStake()).to.equal(0);

                const nextStakeTs = await rollLock(firstStakeTs);
                await ethers.provider.send("evm_mine", []);
                await rollToDepositWindow();

                // Make some new deposits > original stake, without rolling schedule
                await stakeMultiple(staker, [
                    [user1, ether("1500")],
                    [user2, ether("1500")],
                ]);

                expect(await staker.totalPendingStake()).to.equal(ether("3000"));

                // Should be 3000 pending, withdraw 1000
                // Have first staker withdraw
                await staker.connect(user1).withdraw(1, ether("1000"));

                // Now 2000 pending
                expect(await staker.totalPendingStake()).to.equal(ether("2000"));

                // Roll the schedule and stake
                await rollSchedule(staker, nextStakeTs);

                expect(await staker.totalPendingStake()).to.equal(0);
            });
        });

        describe("accrue", () => {
            it("does not allow deposits during an accrual window", async () => {
                const {
                    users: [user],
                    staker,
                    start,
                } = ctx;

                await rollToNearestAccrual(start + ONE_DAY_SEC);

                await expect(stakeSingle(staker, user, 0)).to.be.revertedWith("In accrual window");
            });

            it("does now allow accruing during a deposit window", async () => {
                const {
                    users: [user],
                    staker,
                    mine,
                    start,
                } = ctx;

                const firstStakeTs = await rollTo(start + ONE_DAY_SEC);
                await ethers.provider.send("evm_mine", []);
                await rollToDepositWindow();

                await stakeSingle(staker, user, ether("10"));
                await rollSchedule(staker, firstStakeTs);
                await rollToDepositWindow();

                const depositIds = await mine.getAllUserDepositIds(staker.address);
                expect(depositIds.length).to.be.gt(0);

                await expect(staker.accrue(depositIds)).to.be.revertedWith("Not accruing");
            });

            it("does not allow accrual if an accrual window is not set", async () => {
                const {
                    users: [user],
                    staker,
                    mine,
                    start,
                } = ctx;

                const firstStakeTs = await rollTo(start + ONE_DAY_SEC);
                await ethers.provider.send("evm_mine", []);
                await rollToDepositWindow();

                await stakeSingle(staker, user, ether("10"));
                await rollSchedule(staker, firstStakeTs);

                const depositIds = await mine.getAllUserDepositIds(staker.address);
                expect(depositIds.length).to.be.gt(0);

                await staker.setAccrualWindows([]);

                await expect(staker.accrue(depositIds)).to.be.revertedWith("Accrual windows not set");
            });

            it("does not allow accrual if deposits are not specified", async () => {
                const {
                    users: [user],
                    staker,
                    mine,
                    start,
                } = ctx;

                const firstStakeTs = await rollTo(start + ONE_DAY_SEC);
                await ethers.provider.send("evm_mine", []);
                await rollToDepositWindow();

                await stakeSingle(staker, user, ether("10"));
                await rollSchedule(staker, firstStakeTs);

                const depositIds = await mine.getAllUserDepositIds(staker.address);
                expect(depositIds.length).to.be.gt(0);

                await staker.setAccrualWindows([]);

                await expect(staker.accrue(depositIds)).to.be.revertedWith("Accrual windows not set");
            });

            it("accrues rewards", async () => {
                const {
                    users: [user],
                    staker,
                    magic,
                    mine,
                    start,
                } = ctx;

                const amount = ether("20000");
                await stakeSingle(staker, user, amount);

                // Go to start of rewards program
                await rollTo(start);

                // Make a tx to deposit
                const tx = await staker.stakeScheduled();
                await tx.wait();

                const unlockTime = await rollLock(start);
                await rollToNearestAccrual(unlockTime);

                // Fast-forward in scenarios - 1.3mm seconds should pass,
                // so 13k MAGIC to pool
                const depositIds = await mine.getAllUserDepositIds(staker.address);
                expect(depositIds.length).to.be.gt(0);

                const expectedAccrual = ether("13000");

                const accrueTx = await staker.accrue(depositIds);
                const receipt = await accrueTx.wait();

                const harvestEvent = receipt.events?.find(e => e.event === "MineHarvest");
                expect(harvestEvent).to.not.be.undefined;
                expectRoundedEqual(harvestEvent?.args?.[0], ether("13000"), 5);
                expect(harvestEvent?.args?.[1]).to.eq(0);
                expect(harvestEvent?.args?.[2]).to.deep.eq(depositIds);

                // Staker should now have 13000 magic
                expectRoundedEqual(await magic.balanceOf(staker.address), expectedAccrual);
            });

            it("deposits at different times during the same deposit window receive the same rewards", async () => {
                const {
                    users: [user1, user2],
                    staker,
                    mine,
                    magic,
                    start,
                } = ctx;

                // Set 3 hour staking wait so we can stake twice in the same window
                const THREE_HOURS = 3600 * 3;
                await staker.setMinimumStakingWait(THREE_HOURS);

                const amount = ether("20000");

                await rollTo(start);
                await ethers.provider.send("evm_mine", []);
                const firstDepositTs = await rollToDepositWindow();
                const secondDepositTs = firstDepositTs + 3600 * 7;

                await stakeSingle(staker, user1, amount);
                await rollTo(firstDepositTs + THREE_HOURS + 1);
                await staker.stakeScheduled();

                // Move forward 6 hours - still in same deposit window
                await rollTo(secondDepositTs);

                await stakeSingle(staker, user2, amount);
                await staker.stakeScheduled();

                // Move forward to unlock time and accrue
                const unlockTime = await rollLock(start);
                await rollToNearestAccrual(unlockTime);

                const depositIds = await mine.getAllUserDepositIds(staker.address);
                expect(depositIds.length).to.be.gt(0);
                await staker.accrue(depositIds);

                // Both reward claims should be equal
                const preclaimBalanceUser1 = await magic.balanceOf(user1.address);
                const preclaimBalanceUser2 = await magic.balanceOf(user2.address);

                await rollToDepositWindow();
                await claimSingle(staker, user1);
                await claimSingle(staker, user2);

                const postclaimBalanceUser1 = await magic.balanceOf(user1.address);
                const postclaimBalanceUser2 = await magic.balanceOf(user2.address);

                const rewardsUser1 = postclaimBalanceUser1.sub(preclaimBalanceUser1);
                const rewardsUser2 = postclaimBalanceUser2.sub(preclaimBalanceUser2);

                expectRoundedEqual(rewardsUser1, ether("6500"));
                expectRoundedEqual(rewardsUser2, ether("6500"));

                // Should get _exactly_ the same
                expect(rewardsUser1).to.eq(rewardsUser2);
            });

            it("accrues the same amount of rewards whether over one or multiple txs", async () => {
                const {
                    users: [user],
                    staker,
                    magic,
                    mine,
                    start,
                } = ctx;

                // Set 3 hour staking wait so we can stake twice in the same window
                const THREE_HOURS = 3600 * 3;
                await staker.setMinimumStakingWait(THREE_HOURS);

                const amount = ether("20000");

                await rollTo(start);
                await ethers.provider.send("evm_mine", []);
                const firstDepositTs = await rollToDepositWindow();
                const secondDepositTs = firstDepositTs + 3600 * 7;

                await stakeSingle(staker, user, amount);
                await rollTo(firstDepositTs + THREE_HOURS + 1);
                await staker.stakeScheduled();

                // Move forward 6 hours - still in same deposit window
                await rollTo(secondDepositTs);

                await stakeSingle(staker, user, amount);
                await staker.stakeScheduled();

                const unlockTime = await rollLock(start);
                await rollToNearestAccrual(unlockTime);

                // Fast-forward in scenarios - 1.3mm seconds should pass,
                // so 13k MAGIC to pool
                const depositIds = await mine.getAllUserDepositIds(staker.address);
                expect(depositIds.length).to.eq(2);

                const expectedAccrual = ether("13000");

                // Staker should now have 13000 magic
                await staker.accrue(depositIds);
                expectRoundedEqual(await magic.balanceOf(staker.address), expectedAccrual);

                // Fast forward again
                // Should still be in accrual since we move forward exatly one day
                const currentTime = (await ethers.provider.getBlock("latest")).timestamp;
                const unlockTime2 = await rollLock(currentTime);
                await rollToNearestAccrual(unlockTime2);

                // Accrue again, staker should have another 13000
                await staker.accrue([depositIds[0]]);
                await staker.accrue([depositIds[1]]);
                expectRoundedEqual(await magic.balanceOf(staker.address), expectedAccrual.mul(2));
            });
        });
    });

    describe("NFT-boosted staking", () => {
        let hoard: SignerWithAddress;

        beforeEach(async () => {
            // Set up hoard
            const {
                admin,
                users: [, _hoard],
                staker,
                treasures,
                legions,
            } = ctx;

            hoard = _hoard;

            await staker.connect(admin).setHoard(hoard.address, true);

            // Mint 4 treasures
            // Token id 161 - 7.3% boost
            // Token id 97 - 15.8% boost
            // Token id 103 - 3% boost
            // Token id 95 - 15.7% boost

            await treasures.mint(hoard.address, 161, 20);
            await treasures.mint(hoard.address, 97, 20);
            await treasures.mint(hoard.address, 103, 20);
            await treasures.mint(hoard.address, 95, 20);
            await treasures.connect(hoard).setApprovalForAll(staker.address, true);

            // Mint 4 legions
            // 2 1/1s (ID < 5) and 2 all-class

            await legions.mint(hoard.address, 0);
            await legions.mint(hoard.address, 1);
            await legions.mint(hoard.address, 10);
            await legions.mint(hoard.address, 11);
            await legions.connect(hoard).setApprovalForAll(staker.address, true);
        });

        it("does not allow a non-hoard caller to stake a treasure", async () => {
            const {
                users: [user],
                staker,
            } = ctx;

            await expect(staker.connect(user).stakeTreasure(161, 10)).to.be.revertedWith("Not hoard");
        });

        it("does not allow a non-hoard caller to stake a legion", async () => {
            const {
                users: [user],
                staker,
            } = ctx;

            await expect(staker.connect(user).stakeLegion(2)).to.be.revertedWith("Not hoard");
        });

        it("does not allow the hoard to unstake a treasure that is not owned", async () => {
            const { staker } = ctx;
            const treasureTokenId = 99;

            await expect(staker.connect(hoard).stakeTreasure(treasureTokenId, 10)).to.be.revertedWith(
                "Not enough treasures",
            );
        });

        it("does not allow the hoard to unstake a legion that is not owned", async () => {
            // Max boost
            const { staker, legions, admin } = ctx;
            await legions.mint(admin.address, 2);

            await expect(staker.connect(hoard).stakeLegion(2)).to.be.revertedWith("Not owner of legion");
        });

        it("allows the hoard to stake a treasure", async () => {
            const { staker, treasures } = ctx;
            const tokenId = 103;

            await expect(staker.connect(hoard).stakeTreasure(tokenId, 20)).to.emit(staker, "StakeNFT").withArgs(
                hoard.address,
                treasures.address,
                tokenId,
                20,
                ether("0.6"), // 60% boost
            );
        });

        it("allows the hoard to stake a legion", async () => {
            const { staker, legions } = ctx;
            const tokenId = 0;

            await expect(staker.connect(hoard).stakeLegion(tokenId)).to.emit(staker, "StakeNFT").withArgs(
                hoard.address,
                legions.address,
                tokenId,
                1,
                ether("6"), // 600% boost
            );
        });

        it("distributes the correct pro rata rewards with a boost multiplier", async () => {
            // Max boost
            const {
                staker,
                users: [user],
                admin,
                magic,
                mine,
                end,
            } = ctx;
            const treasureTokenId = 97;

            // 15.8 * 20 = 316% boost
            await staker.connect(hoard).stakeTreasure(treasureTokenId, 20);

            // 600 + 200 + 200 = 1000% boost
            await staker.connect(hoard).stakeLegion(0);
            await staker.connect(hoard).stakeLegion(10);
            await staker.connect(hoard).stakeLegion(11);

            // total 1316% boost
            expect(await mine.boosts(staker.address)).to.eq(ether("13.16"));

            // Set up another staker and stake without boosts
            const staker2 = <AtlasMineStaker>await deployUpgradeable("AtlasMineStakerUpgradeable", admin, [
                magic.address,
                mine.address,
                0, // 0 == AtlasMine.Lock.twoWeeks
            ]);
            await staker2.setAccrualWindows(ACCRUAL_WINDOWS);

            expect(await mine.boosts(staker2.address)).to.eq(0);

            const amount = ether("10");
            await magic.connect(user).approve(staker2.address, amount);

            await rollToDepositWindow();
            await Promise.all([stakeSingle(staker, user, amount), stakeSingle(staker2, user, amount)]);

            // Stake in mine from both stakers
            const tx = await rollSchedule(staker);
            await tx.wait();
            await staker2.stakeScheduled();

            // Go to the end
            await rollTo(end);
            await accrue(staker);
            await accrue(staker2);
            await rollToDepositWindow();

            // Claim rewards
            // In addition to NFT boost, both have lock boosts, so total is:
            // 1326% for boosted pool + 100% base
            // 10% for unboosted pool + 100% base
            const denom = ether("15.36");
            const boostedStakerRewards = TOTAL_REWARDS.div(denom).mul(ether("14.26"));
            const regularStakerRewards = TOTAL_REWARDS.div(denom).mul(ether("1.1"));

            await claimWithRoundedRewardCheck(staker, user, boostedStakerRewards);
            await claimWithRoundedRewardCheck(staker2, user, regularStakerRewards);
        });

        it("does not allow a non-hoard caller to unstake a treasure", async () => {
            const {
                users: [user],
                staker,
            } = ctx;

            await expect(staker.connect(user).unstakeTreasure(161, 10)).to.be.revertedWith("Not hoard");
        });

        it("does not allow a non-hoard caller to unstake a legion", async () => {
            const {
                users: [user],
                staker,
            } = ctx;

            await expect(staker.connect(user).unstakeLegion(2)).to.be.revertedWith("Not hoard");
        });

        it("does not allow the hoard to unstake a treasure that hasn't been staked", async () => {
            const { staker } = ctx;
            const treasureTokenId = 97;
            const otherTokenId = 161;

            // 15.8 * 20 = 316% boost
            await staker.connect(hoard).stakeTreasure(treasureTokenId, 20);

            await expect(staker.connect(hoard).unstakeTreasure(otherTokenId, 10)).to.be.revertedWith(
                "Not enough treasures",
            );
        });

        it("does not allow the hoard to unstake a legion that hasn't been staked", async () => {
            // Max boost
            const { staker } = ctx;

            await staker.connect(hoard).stakeLegion(0);
            await staker.connect(hoard).stakeLegion(10);

            await expect(staker.connect(hoard).unstakeLegion(1)).to.be.revertedWith("Not staker of legion");
        });

        it("allows the hoard to unstake a treasure", async () => {
            // Max boost
            const { staker, mine, treasures } = ctx;
            const treasureTokenId = 97;

            // 15.8 * 20 = 316% boost
            await staker.connect(hoard).stakeTreasure(treasureTokenId, 20);

            // 600 + 200 + 200 = 1000% boost
            await staker.connect(hoard).stakeLegion(0);
            await staker.connect(hoard).stakeLegion(10);
            await staker.connect(hoard).stakeLegion(11);

            // total 1316% boost
            expect(await mine.boosts(staker.address)).to.eq(ether("13.16"));

            // Unstake 10 treasures - should remove 158% boost
            await expect(staker.connect(hoard).unstakeTreasure(treasureTokenId, 10))
                .to.emit(staker, "UnstakeNFT")
                .withArgs(hoard.address, treasures.address, treasureTokenId, 10, ether("11.58"));

            // total 1316 - 158 =  1158% boost
            expect(await mine.boosts(staker.address)).to.eq(ether("11.58"));

            // Treasures back in staker wallet
            expect(await treasures.balanceOf(hoard.address, treasureTokenId)).to.eq(10);
        });

        it("allows the hoard to unstake a legion", async () => {
            // Max boost
            const { staker, mine, legions } = ctx;
            const treasureTokenId = 97;

            // 15.8 * 20 = 316% boost
            await staker.connect(hoard).stakeTreasure(treasureTokenId, 20);

            // 600 + 200 + 200 = 1000% boost
            await staker.connect(hoard).stakeLegion(0);
            await staker.connect(hoard).stakeLegion(10);
            await staker.connect(hoard).stakeLegion(11);

            // total 1316% boost
            expect(await mine.boosts(staker.address)).to.eq(ether("13.16"));

            // Unstake 1/1 legion - should remove 600% boost
            await expect(staker.connect(hoard).unstakeLegion(0))
                .to.emit(staker, "UnstakeNFT")
                .withArgs(hoard.address, legions.address, 0, 1, ether("7.16"));

            // total 1316 - 600 =  716% boost
            expect(await mine.boosts(staker.address)).to.eq(ether("7.16"));

            // Legion back in staker wallet
            expect(await legions.ownerOf(0)).to.eq(hoard.address);
        });

        it("does not allow a non-owner to remove a hoard", async () => {
            const {
                users: [user],
                staker,
            } = ctx;

            await expect(staker.connect(user).setHoard(hoard.address, false)).to.be.revertedWith(
                "Ownable: caller is not the owner",
            );
        });

        it("allows the owner to remove a hoard", async () => {
            const { admin, staker } = ctx;
            const treasureTokenId = 0;

            await expect(staker.connect(admin).setHoard(hoard.address, false)).to.not.be.reverted;

            await expect(staker.connect(hoard).stakeTreasure(treasureTokenId, 20)).to.be.revertedWith("Not hoard");

            await expect(staker.connect(hoard).stakeLegion(0)).to.be.revertedWith("Not hoard");
        });

        it("allows multiple hoards to stake in parallel", async () => {
            // Stake from two hoards
            const { users, admin, staker, treasures, legions, mine } = ctx;
            const legionHoard = users[2];
            const treasureTokenId = 97;

            await staker.connect(admin).setHoard(legionHoard.address, true);

            await legions.mint(legionHoard.address, 2);
            await legions.mint(legionHoard.address, 12);
            await legions.mint(legionHoard.address, 13);
            await treasures.mint(legionHoard.address, treasureTokenId, 20);

            await treasures.connect(legionHoard).setApprovalForAll(staker.address, true);
            await legions.connect(legionHoard).setApprovalForAll(staker.address, true);

            // Stake from both accounts
            await staker.connect(legionHoard).stakeLegion(2);
            await staker.connect(legionHoard).stakeLegion(12);
            await staker.connect(legionHoard).stakeLegion(13);
            await staker.connect(legionHoard).stakeTreasure(treasureTokenId, 10);
            await staker.connect(hoard).stakeTreasure(treasureTokenId, 10);

            // Make sure boosts correct
            expect(await mine.boosts(staker.address)).to.eq(ether("13.16"));

            // Make sure one user can't unstake the other's NFTs
            await expect(staker.connect(legionHoard).unstakeTreasure(treasureTokenId, 15)).to.be.revertedWith(
                "Not enough treasures",
            );

            await expect(staker.connect(hoard).unstakeLegion(12)).to.be.revertedWith("Not staker of legion");

            // Make sure unstakes go to same wallet
            await staker.connect(legionHoard).unstakeLegion(2);
            expect(await legions.ownerOf(2)).to.eq(legionHoard.address);

            await staker.connect(hoard).unstakeTreasure(treasureTokenId, 10);
            expect(await treasures.balanceOf(hoard.address, treasureTokenId)).to.eq(20);
            expect(await treasures.balanceOf(legionHoard.address, treasureTokenId)).to.eq(10);
        });
    });

    describe("View Functions", () => {
        beforeEach(async () => {
            await rollToDepositWindow();
        });

        it("returns the correct amount of user stake", async () => {
            const {
                users: [user1, user2],
                staker,
            } = ctx;

            await stakeMultiple(staker, [
                [user1, ether("1")],
                [user2, ether("55")],
            ]);

            // Check stakes
            expect(await staker.userTotalStake(user1.address)).to.eq(ether("1"));
            expect(await staker.userTotalStake(user2.address)).to.eq(ether("55"));
        });

        it("returns the correct details of a single user stake", async () => {
            const {
                users: [user1],
                staker,
            } = ctx;

            await stakeMultiple(staker, [
                [user1, ether("1")],
                [user1, ether("55")],
            ]);

            // Check stakes
            expect(await staker.userTotalStake(user1.address)).to.eq(ether("56"));

            const stake1 = await staker.getUserStake(user1.address, 1);
            expect(stake1.amount).to.eq(ether("1"));

            const stake2 = await staker.getUserStake(user1.address, 2);
            expect(stake2.amount).to.eq(ether("55"));
        });

        it("returns the correct pending rewards for a single deposit", async () => {
            const {
                users: [user1],
                staker,
                start,
            } = ctx;

            const amount = ether("20000");
            await stakeMultiple(staker, [
                [user1, amount],
                [user1, amount],
            ]);

            // Go to start of rewards program
            await rollTo(start);

            // Make a tx to deposit
            const tx = await staker.stakeScheduled();
            await tx.wait();

            await rollLock(start);
            await accrue(staker);

            // Fast-forward in scenarios - 1.3mm seconds should pass,
            // so 13k MAGIC to pool. First user stake should get half
            const depositId = 1;
            const pending = await staker.pendingRewards(user1.address, depositId);
            expectRoundedEqual(pending, ether("6500"));
        });

        it("returns the correct pending rewards for a user", async () => {
            const {
                users: [user1],
                staker,
                start,
            } = ctx;

            const amount = ether("20000");
            await stakeMultiple(staker, [
                [user1, amount],
                [user1, amount],
            ]);

            // Go to start of rewards program
            await rollTo(start);

            // Make a tx to deposit
            const tx = await staker.stakeScheduled();
            await tx.wait();

            await rollLock(start);
            await accrue(staker);

            // Fast-forward in scenarios - 1.3mm seconds should pass,
            // so 13k MAGIC to pool, all to user1
            const pending = await staker.pendingRewardsAll(user1.address);
            expectRoundedEqual(pending, ether("13000"));
        });

        it("returns the correct amount of magic controlled by the contract", async () => {
            const {
                users: [user1, user2],
                staker,
                start,
                end,
            } = ctx;

            await stakeMultiple(staker, [
                [user1, ether("1")],
                [user2, ether("55")],
            ]);

            // Roll to rewards period - should now control all rewarded magic
            expect(await staker.totalMagic()).to.eq(ether("56"));

            // Stake and roll, check rewards halfway and at the end
            await rollSchedule(staker);

            await rollToPartialWindow(start, end, 0.5);
            await ethers.provider.send("evm_mine", []);

            expectRoundedEqual(await staker.totalMagic(), ether("56").add(TOTAL_REWARDS.div(2)));

            // Roll halfway and check total magic
            await rollTo(end);
            await ethers.provider.send("evm_mine", []);

            expectRoundedEqual(await staker.totalMagic(), ether("56").add(TOTAL_REWARDS));
        });

        it("returns the correct amount of pending, undeposited stake", async () => {
            const {
                users: [user1, user2],
                staker,
                start,
            } = ctx;

            await stakeMultiple(staker, [
                [user1, ether("1")],
                [user2, ether("55")],
            ]);

            const ONE_DAY_SEC = 86400;
            const nextTimestamp = start + ONE_DAY_SEC;
            await rollTo(nextTimestamp);
            await ethers.provider.send("evm_mine", []);

            // Roll to rewards period - should now count as pending
            expect(await staker.totalPendingStake()).to.eq(ether("56"));

            const tx = await staker.stakeScheduled();
            await tx.wait();

            // Now nothing more pending
            expect(await staker.totalPendingStake()).to.eq(0);
        });

        it("returns the correct amount of withdrawable MAGIC", async () => {
            const {
                admin,
                users: [user1, user2],
                staker,
                start,
                end,
            } = ctx;

            await stakeMultiple(staker, [
                [user1, ether("1")],
                [user2, ether("9")],
            ]);

            // Should be able to withdraw anything since it hasn't been staked
            expect(await staker.totalWithdrawableMagic()).to.eq(ether("10"));

            await rollTo(start);
            let tx = await staker.stakeScheduled();
            await tx.wait();

            // Should not be able to withdraw anything, staked and locked
            expect(await staker.totalWithdrawableMagic()).to.eq(0);

            // Roll through part of rewards period, but before lock
            // 1_000_000 seconds is equal to 10000 MAGIC distributed
            await rollTo(start + 1_000_000);
            await accrue(staker);

            // Should not be able to withdraw anything, staked and locked - but nonzero rewards
            expectRoundedEqual(await staker.totalWithdrawableMagic(), ether("10000"));

            // Roll to end of rewards period, stake unlocked
            await rollTo(end);
            await accrue(staker);

            // Should get all principal plus rewards, even if unclaimed
            expectRoundedEqual(await staker.totalWithdrawableMagic(), TOTAL_REWARDS.add(ether("10")));

            await rollToDepositWindow();

            await staker.connect(admin).unstakeAllFromMine();

            // Should be the same after claim/unstake
            expectRoundedEqual(await staker.totalWithdrawableMagic(), TOTAL_REWARDS.add(ether("10")));

            // Have one user withdraw
            tx = await staker.connect(user2).withdrawAll();
            await tx.wait();

            // Should have 10 percent of rewards plus deposit withdrawable
            expectRoundedEqual(await staker.totalWithdrawableMagic(), TOTAL_REWARDS.div(10).add(ether("1")));
        });
    });

    describe("Owner Operations", () => {
        describe("Administration", () => {
            it("does not allow a non-owner to set atlas mine approvals", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await expect(staker.connect(user).approveNFTs()).to.be.revertedWith("Ownable: caller is not the owner");
            });

            it("allows an owner to set atlas mine approvals", async () => {
                const { admin, staker, mine, legions, treasures } = ctx;

                await expect(staker.connect(admin).approveNFTs()).to.not.be.reverted;

                expect(await legions.isApprovedForAll(staker.address, mine.address)).to.be.true;
                expect(await treasures.isApprovedForAll(staker.address, mine.address)).to.be.true;
            });

            it("does not allow a non-owner to revoke atlas mine approvals", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await expect(staker.connect(user).revokeNFTApprovals()).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("allows an owner to revoke atlas mine approvals", async () => {
                const { admin, staker, mine, legions, treasures } = ctx;

                await expect(staker.connect(admin).approveNFTs()).to.not.be.reverted;
                await expect(staker.connect(admin).revokeNFTApprovals()).to.not.be.reverted;

                expect(await legions.isApprovedForAll(staker.address, mine.address)).to.be.false;
                expect(await treasures.isApprovedForAll(staker.address, mine.address)).to.be.false;
            });

            it("does not allow a non-owner to set the reward fee", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await expect(staker.connect(user).setFee(10)).to.be.revertedWith("Ownable: caller is not the owner");
            });

            it("allows the owner to set the reward fee", async () => {
                const { admin, staker } = ctx;

                await expect(staker.connect(admin).setFee(200)).to.emit(staker, "SetFee").withArgs(200);
            });

            it("does not allow the owner to set a fee larger than the maximum", async () => {
                const { admin, staker } = ctx;

                await expect(staker.connect(admin).setFee(7500)).to.be.revertedWith("Invalid fee");
            });

            it("collects the correct fee when rewards are claimed", async () => {
                const {
                    users: [user],
                    admin,
                    staker,
                    magic,
                } = ctx;

                await staker.connect(admin).setFee(200);
                await rollToDepositWindow();
                const { stakes } = await setup5050Scenario(ctx);

                // Expected rewards - half of total pot minus fee
                const rewardAfterFee = TOTAL_REWARDS.div(2)
                    .div(10_000)
                    .mul(10_000 - 200);

                await claimWithRoundedRewardCheck(staker, user, rewardAfterFee);

                // User returned all funds + reward
                // Here, they should only get 98% of rewards
                expectRoundedEqual(
                    await magic.balanceOf(user.address),
                    USER_INITIAL_BALANCE.sub(stakes[user.address]).add(rewardAfterFee),
                );
            });

            it("does not allow a non-owner to withdraw collected fees", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await expect(staker.connect(user).withdrawFees()).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("allows the owner to withdraw collected fees", async () => {
                const {
                    users: [user],
                    admin,
                    staker,
                    magic,
                } = ctx;

                await staker.connect(admin).setFee(200);
                await rollToDepositWindow();
                await setup5050Scenario(ctx);

                // Expected rewards
                const rewardAfterFee = TOTAL_REWARDS.div(2)
                    .div(10_000)
                    .mul(10_000 - 200);
                const fee = TOTAL_REWARDS.div(10_000).mul(200);

                await claimWithRoundedRewardCheck(staker, user, rewardAfterFee);

                // Make sure admin gets fee upon calling func
                // Also gets fees from other staker
                const preclaimBalance = await magic.balanceOf(admin.address);
                await staker.connect(admin).withdrawFees();
                const postclaimBalance = await magic.balanceOf(admin.address);
                expectRoundedEqual(postclaimBalance.sub(preclaimBalance), fee);
            });

            it("does not allow a non-owner to add a hoard address", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await expect(staker.connect(user).setHoard(user.address, true)).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("allows the owner to add a hoard address", async () => {
                const { admin, staker, users } = ctx;

                await expect(staker.connect(admin).setHoard(users[3].address, true)).to.not.be.reverted;
            });

            it("does not allow a non-owner to change the staking wait", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await expect(staker.connect(user).setMinimumStakingWait(0)).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("does not allow an owner to change the staking wait to less than 3 hours", async () => {
                const { admin, staker } = ctx;

                await expect(staker.connect(admin).setMinimumStakingWait(3600)).to.be.revertedWith(
                    "Minimum interval 3 hours",
                );
            });

            it("allows an owner to change the staking wait", async () => {
                const {
                    admin,
                    users: [user],
                    staker,
                    start,
                } = ctx;

                const firstStakeTs = await rollTo(start + ONE_DAY_SEC);
                await ethers.provider.send("evm_mine", []);
                await rollToDepositWindow();

                await stakeSingle(staker, user, ether("10"));
                await rollSchedule(staker, firstStakeTs);

                await expect(staker.stakeScheduled()).to.be.revertedWith("not enough time since last stake");

                await expect(staker.connect(admin).setMinimumStakingWait(14400))
                    .to.emit(staker, "SetMinimumStakingWait")
                    .withArgs(14400);

                await increaseTime(14400);
                await expect(staker.stakeScheduled()).to.not.be.reverted;
            });

            it("does not allow a non-owner to set accrual windows", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await expect(staker.connect(user).setAccrualWindows([0, 1])).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("does not allow an owner to set invalid accrual windows (wrong length)");
            it("does not allow an owner to set invalid accrual windows (wrong order)");
            it("does not allow an owner to set invalid accrual windows (wrong order across windows)");
            it("does not allow an owner to set invalid accrual windows (overlapping windows)");

            it("allows an owner to set accrual windows");
            it("allows an owner to use 0 and 24 as accrual windows");
        });

        describe("Stake Management", () => {
            it("does not allow a non-owner to unstake to a specified target", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await expect(staker.connect(user).unstakeToTarget(ether("10"))).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("allows an owner to unstake to a specified target", async () => {
                const {
                    admin,
                    users: [user1, user2],
                    staker,
                    magic,
                    start,
                    end,
                } = ctx;

                await rollToDepositWindow();
                await stakeMultiple(staker, [
                    [user1, ether("1")],
                    [user2, ether("9")],
                ]);

                // Should be able to withdraw anything since it hasn't been staked
                expect(await staker.totalWithdrawableMagic()).to.eq(ether("10"));

                await rollTo(start);
                await staker.stakeScheduled();

                // Roll to end of rewards period, stake unlocked
                await rollTo(end);

                // Contract should not hold any MAGIC - all staked or pending claim
                expectRoundedEqual(await magic.balanceOf(staker.address), 0);

                await accrue(staker);
                await staker.connect(admin).unstakeToTarget(ether("5"));

                // Staker should now hold all total rewards plus unstaked 5 units
                expectRoundedEqual(await magic.balanceOf(staker.address), TOTAL_REWARDS.add(ether("5")));
            });

            it("does not allow a non-owner to unstake all possible stake", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await expect(staker.connect(user).unstakeAllFromMine()).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("allows an owner to unstake all possible stake", async () => {
                const {
                    admin,
                    users: [user1, user2],
                    staker,
                    magic,
                    start,
                    end,
                } = ctx;

                await rollToDepositWindow();
                await stakeMultiple(staker, [
                    [user1, ether("1")],
                    [user2, ether("9")],
                ]);

                // Should be able to withdraw anything since it hasn't been staked
                expect(await staker.totalWithdrawableMagic()).to.eq(ether("10"));

                await rollTo(start);
                await staker.stakeScheduled();

                // Roll to end of rewards period, stake unlocked
                await rollTo(end);

                // Contract should not hold any MAGIC - all staked or pending claim
                expectRoundedEqual(await magic.balanceOf(staker.address), 0);

                await accrue(staker);
                await staker.connect(admin).unstakeAllFromMine();

                // Staker should now hold all total rewards plus all unstaked deposits (10 unites)
                expectRoundedEqual(await magic.balanceOf(staker.address), TOTAL_REWARDS.add(ether("10")));
            });
        });
    });

    describe("Emergency Flows", () => {
        beforeEach(async () => {
            await rollToDepositWindow();
        });

        it("does not allow a non-owner to pause the stake schedule", async () => {
            const {
                users: [user],
                staker,
            } = ctx;

            await expect(staker.connect(user).toggleSchedulePause(true)).to.be.revertedWith(
                "Ownable: caller is not the owner",
            );
        });

        it("allows the owner to pause the stake schedule", async () => {
            const {
                users: [user1],
                admin,
                staker,
            } = ctx;

            await expect(staker.connect(admin).toggleSchedulePause(true))
                .to.emit(staker, "StakingPauseToggle")
                .withArgs(true);

            // New stakes should not be allowed
            await expect(staker.connect(user1).deposit(ether("1"))).to.be.revertedWith("new staking paused");
            await expect(staker.connect(admin).stakeScheduled()).to.be.revertedWith("new staking paused");
        });

        it("does not allow a non-owner to unstake everything from the mine", async () => {
            const {
                users: [user],
                staker,
            } = ctx;

            await expect(staker.connect(user).emergencyUnstakeAllFromMine()).to.be.revertedWith(
                "Ownable: caller is not the owner",
            );
        });

        it("does not allow an emergency unstake if new stakes are not paused", async () => {
            const { admin, staker } = ctx;

            await expect(staker.connect(admin).emergencyUnstakeAllFromMine()).to.be.revertedWith(
                "Not in emergency state",
            );
        });

        it("unstakes everything possible from mine", async () => {
            const {
                users: [user1, user2],
                admin,
                staker,
                mine,
                magic,
                start,
            } = ctx;

            // Do regular staking
            const amount = ether("20000");
            const txs = await stakeMultiple(staker, [
                [user1, amount],
                [user2, amount],
            ]);

            // Wait for all deposits to finish
            await Promise.all(txs.map(t => t.wait()));

            // Go to start of rewards program
            await rollTo(start);

            // Make a tx to deposit
            const tx = await staker.stakeScheduled();
            await tx.wait();

            // Roll to lock, accrue rewards, and move past accrual window for tests
            await rollLock(start);

            // Cannot unstake
            expect(await staker.totalWithdrawableMagic()).to.eq(0);

            // Pause stakes and put atlas mine in emergency mode
            await staker.connect(admin).toggleSchedulePause(true);
            await mine.connect(admin).toggleUnlockAll();

            // Emergency unstake all
            await staker.connect(admin).emergencyUnstakeAllFromMine();

            // Should have made all stake withdrawable with no rewards collected
            const totalStaked = amount.mul(2);
            expectRoundedEqual(await magic.balanceOf(staker.address), totalStaked);
        });

        it("does not allow an admin to emergency unstake if not all stakes can be withdrawn", async () => {
            const {
                users: [user1, user2],
                admin,
                staker,
            } = ctx;

            // Do regular staking
            // Don't roll up far enough for stakes to unlock
            const nextDaySec = Math.floor(Date.now() / 1000) + 86500;

            // Stake more than rewards to force a withdraw
            // With 2 stakers, each will earn 7000 MAGIC over lock period
            const amount = ether("20000");
            await stakeMultiple(staker, [
                [user1, amount],
                [user2, amount],
            ]);

            // Go to next day and stake in mine
            await rollTo(nextDaySec);
            const tx = await staker.stakeScheduled();
            await tx.wait();

            // Pause stakes
            // UNLIKE last test, do not put atlas mine in emergency mode,
            // so coins will stay locked
            await staker.connect(admin).toggleSchedulePause(true);

            // Emergency unstake all
            await expect(staker.connect(admin).emergencyUnstakeAllFromMine()).to.be.revertedWith(
                "Position is still locked",
            );
        });

        it("does not allow a user to emergency withdraw if new stakes are not paused", async () => {
            const {
                users: [user1, user2],
                admin,
                staker,
            } = ctx;

            // Do regular staking
            // Don't roll up far enough for stakes to unlock
            const nextDaySec = Math.floor(Date.now() / 1000) + 86500;

            // Stake more than rewards to force a withdraw
            // With 2 stakers, each will earn 7000 MAGIC over lock period
            const amount = ether("20000");
            await stakeMultiple(staker, [
                [user1, amount],
                [user2, amount],
            ]);

            // Go to next day and stake in mine
            await rollTo(nextDaySec);
            const tx = await staker.stakeScheduled();
            await tx.wait();

            await expect(staker.connect(user1).withdrawEmergency()).to.be.revertedWith("Not in emergency state");
        });

        it("does now allow a user to emergency withdraw is there is not enough unstaked", async () => {
            const {
                users: [user1, user2],
                admin,
                staker,
                mine,
            } = ctx;

            // Do regular staking
            // Don't roll up far enough for stakes to unlock
            const nextDaySec = Math.floor(Date.now() / 1000) + 86500;

            // Stake more than rewards to force a withdraw
            // With 2 stakers, each will earn 7000 MAGIC over lock period
            const amount = ether("20000");
            await stakeMultiple(staker, [
                [user1, amount],
                [user2, amount],
            ]);

            // Go to next day and stake in mine
            await rollTo(nextDaySec);
            const tx = await staker.stakeScheduled();
            await tx.wait();

            // Pause stakes and put atlas mine in emergency mode
            // But do NOT call unstake all function
            await staker.connect(admin).toggleSchedulePause(true);
            await mine.connect(admin).toggleUnlockAll();

            await expect(staker.connect(user1).withdrawEmergency()).to.be.revertedWith("Not enough unstaked");
        });

        it("allows a user to emergency withdraw after an emergency unstake", async () => {
            const {
                users: [user1, user2],
                admin,
                staker,
                magic,
                mine,
            } = ctx;

            // Do regular staking
            // Don't roll up far enough for stakes to unlock
            const nextDaySec = Math.floor(Date.now() / 1000) + 86500;

            // Stake more than rewards to force a withdraw
            // With 2 stakers, each will earn 7000 MAGIC over lock period
            const amount = ether("20000");
            await stakeMultiple(staker, [
                [user1, amount],
                [user2, amount],
            ]);

            // Go to next day and stake in mine
            await rollTo(nextDaySec);
            const tx = await staker.stakeScheduled();
            await tx.wait();

            // Pause stakes and put atlas mine in emergency mode, and unstake all
            await staker.connect(admin).toggleSchedulePause(true);
            await mine.connect(admin).toggleUnlockAll();
            await staker.connect(admin).emergencyUnstakeAllFromMine();

            await expect(staker.connect(user1).withdrawEmergency())
                .to.emit(staker, "UserWithdraw")
                .withArgs(user1.address, 0, ether("20000"), 0);

            // Make sure all funds returned, with no rewards
            expect(await magic.balanceOf(user1.address)).to.eq(ether("100000"));
        });

        it("allows a user to emergency withdraw after unstake (no rewards)", async () => {
            const {
                users: [user1, user2],
                admin,
                staker,
                magic,
                mine,
            } = ctx;

            // Do regular staking
            // Don't roll up far enough for stakes to unlock
            const nextDaySec = Math.floor(Date.now() / 1000) + 86500;

            // Stake more than rewards to force a withdraw
            // With 2 stakers, each will earn 7000 MAGIC over lock period
            const amount = ether("20000");
            await stakeMultiple(staker, [
                [user1, amount],
                [user2, amount],
            ]);

            // Go to next day and stake in mine
            await rollTo(nextDaySec);
            const tx = await staker.stakeScheduled();
            await tx.wait();

            // Pause stakes and put atlas mine in emergency mode, and unstake all
            await staker.connect(admin).toggleSchedulePause(true);
            await mine.connect(admin).toggleUnlockAll();
            await staker.connect(admin).unstakeToTarget(ether("20000"));

            await expect(staker.connect(user1).withdrawEmergency())
                .to.emit(staker, "UserWithdraw")
                .withArgs(user1.address, 0, ether("20000"), 0);

            // Make sure all funds returned, with no rewards
            expect(await magic.balanceOf(user1.address)).to.eq(ether("100000"));
        });
    });

    describe("Advanced Rewards Calculation", () => {
        /**
         * Different advanced scenarios:
         * different deposits at different times
         * user unstakes but then redeposits later
         * some prestaking, some in-flow staking
         * Claiming at different times
         * Two stakers with one NFT boosted
         *
         * For each scenario, precalculate and test all outputs
         */
        it("scenario 1", async () => {
            const { magic, staker } = ctx;
            const { actions, rewards } = setupAdvancedScenario1(ctx);

            await runScenario(ctx, actions);

            // Now check all expected rewards and user balance
            // Shuffle to ensure that order doesn't matter
            const shuffledRewards = shuffle(rewards);
            // const shuffledRewards = rewards;
            for (const reward of shuffledRewards) {
                const { signer, expectedReward } = reward;
                const preclaimBalance = await magic.balanceOf(signer.address);

                await claimWithRoundedRewardCheck(staker, signer, expectedReward);
                const postclaimBalance = await magic.balanceOf(signer.address);

                expectRoundedEqual(postclaimBalance.sub(preclaimBalance), expectedReward);

                // Withdraw funds to make sure we can
                await staker.connect(signer).withdrawAll();
                // await expect(staker.connect(signer).withdrawAll()).to.not.be.reverted;

                // Mine a block to wind clock
                await ethers.provider.send("evm_increaseTime", [10]);
            }

            // Make sure more all claims return 0
            for (const reward of shuffledRewards) {
                // Make sure another claim gives 0
                await claimWithRoundedRewardCheck(staker, reward.signer, 0);
            }
        });

        it("scenario 2", async () => {
            const { magic, staker } = ctx;
            const { actions, rewards } = setupAdvancedScenario2(ctx);

            const preclaimBalances: { [user: string]: BigNumberish } = {};
            for (const { signer } of rewards) {
                preclaimBalances[signer.address] = await magic.balanceOf(signer.address);
            }

            const claims = await runScenario(ctx, actions);

            // Now check all expected rewards and user balance
            const shuffledRewards = shuffle(rewards);
            for (const reward of shuffledRewards) {
                const { signer, expectedReward } = reward;
                const preclaimBalance = preclaimBalances[signer.address];

                // Adjust if midstream claims/withdraws have been made
                const adjustedExpectedReward = ethers.BigNumber.from(expectedReward).sub(claims[signer.address] || 0);

                // Increased tolerance here, but not in final adjusted reward
                await claimWithRoundedRewardCheck(staker, signer, adjustedExpectedReward, 8);
                const postclaimBalance = await magic.balanceOf(signer.address);

                expectRoundedEqual(postclaimBalance.sub(preclaimBalance), expectedReward);

                // Withdraw funds to make sure we can
                if ((await staker.userTotalStake(signer.address)).gt(0)) {
                    // await staker.connect(signer).withdrawAll();
                    await staker.connect(signer).withdrawAll();
                    // await expect(staker.connect(signer).withdrawAll()).to.not.be.reverted;
                }

                // Make sure another claim gives 0
                await claimWithRoundedRewardCheck(staker, signer, 0);
            }
        });

        it("scenario 3", async () => {
            const { magic, staker } = ctx;
            const { actions, rewards } = setupAdvancedScenario3(ctx);

            const preclaimBalances: { [user: string]: BigNumberish } = {};
            for (const { signer } of rewards) {
                preclaimBalances[signer.address] = await magic.balanceOf(signer.address);
            }

            const claims = await runScenario(ctx, actions);

            // Now check all expected rewards and user balance
            const shuffledRewards = shuffle(rewards);
            for (const reward of shuffledRewards) {
                const { signer, expectedReward } = reward;
                const preclaimBalance = preclaimBalances[signer.address];

                // Adjust if midstream claims/withdraws have been made
                const adjustedExpectedReward = ethers.BigNumber.from(expectedReward).sub(claims[signer.address] || 0);

                // Increased tolerance here, but not in final adjusted reward
                await claimWithRoundedRewardCheck(staker, signer, adjustedExpectedReward, 8);
                const postclaimBalance = await magic.balanceOf(signer.address);

                expectRoundedEqual(postclaimBalance.sub(preclaimBalance), expectedReward);

                // Withdraw funds to make sure we can
                if ((await staker.userTotalStake(signer.address)).gt(0)) {
                    await staker.connect(signer).withdrawAll();
                    // await expect(staker.connect(signer).withdrawAll()).to.not.be.reverted;
                }

                // Make sure another claim gives 0
                await claimWithRoundedRewardCheck(staker, signer, 0);
            }
        });

        it("scenario 4", async () => {
            const { magic, admin, staker } = ctx;
            const { actions, rewards } = setupAdvancedScenario4(ctx);

            const preclaimBalances: { [user: string]: BigNumberish } = {};
            for (const { signer } of rewards) {
                preclaimBalances[signer.address] = await magic.balanceOf(signer.address);
            }

            const tx = await staker.connect(admin).setFee(400);
            await tx.wait();

            const claims = await runScenario(ctx, actions);

            // for (const r of rewards) {
            //     console.log("Signer", r.signer.address, r.expectedReward);
            // }

            // console.log();

            // Now check all expected rewards and user balance
            const shuffledRewards = shuffle(rewards);
            for (const reward of shuffledRewards) {
                const { signer, expectedReward } = reward;
                const preclaimBalance = preclaimBalances[signer.address];

                // Adjust if midstream claims/withdraws have been made
                const adjustedExpectedReward = ethers.BigNumber.from(expectedReward).sub(claims[signer.address] || 0);

                // console.log("Checking", signer.address, expectedReward, adjustedExpectedReward);

                // Increased tolerance here, but not in final adjusted reward
                await claimWithRoundedRewardCheck(staker, signer, adjustedExpectedReward, 8);

                const postclaimBalance = await magic.balanceOf(signer.address);

                expectRoundedEqual(postclaimBalance.sub(preclaimBalance), expectedReward);

                // Withdraw funds to make sure we can
                if ((await staker.userTotalStake(signer.address)).gt(0)) {
                    await staker.connect(signer).withdrawAll();
                    // await expect(staker.connect(signer).withdrawAll()).to.not.be.reverted;
                }

                // Make sure another claim gives 0
                await claimWithRoundedRewardCheck(staker, signer, 0);
            }

            await expect(staker.connect(admin).withdrawFees()).to.not.be.reverted;
        });

        it("scenario 5", async () => {
            const { magic, admin, staker, mine, users, legions } = ctx;

            // Set up another staker and stake without boosts
            const staker2 = <AtlasMineStaker>await deployUpgradeable("AtlasMineStakerUpgradeable", admin, [
                magic.address,
                mine.address,
                0, // 0 == AtlasMine.Lock.twoWeeks
            ]);

            await staker2.setAccrualWindows(ACCRUAL_WINDOWS);

            const stakerApprove = users.map(u => magic.connect(u).approve(staker2.address, ether("100000")));
            await Promise.all(stakerApprove);

            const hoard = users[users.length - 1];
            await staker.connect(admin).setHoard(hoard.address, true);
            await legions.mint(hoard.address, 110);
            await legions.connect(hoard).setApprovalForAll(staker.address, true);
            await staker.connect(hoard).stakeLegion(110);

            // total 210% boost
            expect(await mine.boosts(staker.address)).to.eq(ether("1"));
            expect(await mine.boosts(staker2.address)).to.eq(ether("0"));

            const { actions, rewards } = setupAdvancedScenario5(ctx, [staker, staker2]);

            const preclaimBalances: { [user: string]: BigNumberish } = {};
            for (const { signer } of rewards) {
                preclaimBalances[signer.address] = await magic.balanceOf(signer.address);
            }

            await runScenario(ctx, actions);

            // Now check all expected rewards and user balance
            const shuffledRewards = shuffle(rewards);
            for (const reward of shuffledRewards) {
                const { signer, expectedReward } = reward;

                const preclaimBalance = preclaimBalances[signer.address];

                // Claim from both stakers
                for (const s of [staker, staker2]) {
                    const claimTx = await claimSingle(s, signer);
                    const receipt = await claimTx.wait();

                    // Cannot use expect matchers because of rounded equal comparison
                    const claimEvent = receipt.events?.find(e => e.event === "UserClaim");

                    if (claimEvent) {
                        expect(claimEvent?.args?.[0]).to.eq(signer.address);
                    }
                }

                const postclaimBalance = await magic.balanceOf(signer.address);
                expectRoundedEqual(postclaimBalance.sub(preclaimBalance), expectedReward, 8);

                // Withdraw funds to make sure we can
                if ((await staker.userTotalStake(signer.address)).gt(0)) {
                    await staker.connect(signer).withdrawAll();
                    // await expect(staker.connect(signer).withdrawAll()).to.not.be.reverted;
                }

                if ((await staker2.userTotalStake(signer.address)).gt(0)) {
                    await staker2.connect(signer).withdrawAll();
                    // await expect(staker2.connect(signer).withdrawAll()).to.not.be.reverted;
                }

                // Make sure another claim gives 0
                await claimWithRoundedRewardCheck(staker, signer, 0);
                await claimWithRoundedRewardCheck(staker2, signer, 0);
            }
        });

        it("scenario 6", async () => {
            const { magic, staker } = ctx;
            const { actions, rewards } = setupAdvancedScenario6(ctx);

            const preclaimBalances: { [user: string]: BigNumberish } = {};
            for (const { signer } of rewards) {
                preclaimBalances[signer.address] = await magic.balanceOf(signer.address);
            }

            const claims = await runScenario(ctx, actions);

            // Now check all expected rewards and user balance
            const shuffledRewards = shuffle(rewards);
            for (const reward of shuffledRewards) {
                const { signer, expectedReward } = reward;
                const preclaimBalance = preclaimBalances[signer.address];

                // Adjust if midstream claims/withdraws have been made
                const adjustedExpectedReward = ethers.BigNumber.from(expectedReward).sub(claims[signer.address] || 0);

                await claimWithRoundedRewardCheck(staker, signer, adjustedExpectedReward);

                const postclaimBalance = await magic.balanceOf(signer.address);

                expectRoundedEqual(postclaimBalance.sub(preclaimBalance), expectedReward);

                // Withdraw funds to make sure we can
                if ((await staker.userTotalStake(signer.address)).gt(0)) {
                    await staker.connect(signer).withdrawAll();
                    // await expect(staker.connect(signer).withdrawAll()).to.not.be.reverted;
                }

                // Make sure another claim gives 0
                await claimWithRoundedRewardCheck(staker, signer, 0);
            }
        });
    });
});
