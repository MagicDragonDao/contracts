/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ethers, waffle } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";

const { loadFixture } = waffle;

import { deploy, expectRoundedEqual, ether } from "../utils";
import type {
    TestERC20,
    BasicDragonStash,
    StreamingDragonStash,
    MockRewarder,
    DragonFireBreather,
} from "../../src/types";
import { BigNumberish } from "ethers";

interface TestContext {
    magic: TestERC20;
    token: TestERC20;
    admin: SignerWithAddress;
    user: SignerWithAddress;
    other: SignerWithAddress;
    pool: DragonFireBreather;
    streamingStash: StreamingDragonStash;
    basicStash: BasicDragonStash;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADMIN_ROLE = "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775";
const REWARD_STASH_ROLE = "0x6d5e2be2384f7cf31b2f788488ae165959caf2b96f1a210e510ee2ad6fcb24c2";
const DISTRIBUTOR_ROLE = "0xfbd454f36a7e1a388bd6fc3ab10d434aa4578f811acbbcf33afb1c697486313c";

describe("DragonFireBreather (MasterChef V2)", () => {
    let ctx: TestContext;

    const amount = ether("1000");
    const STREAM_DURATION = 100_000; // 100000 seconds

    const fixture = async (): Promise<TestContext> => {
        const [admin, user, other] = await ethers.getSigners();

        const magic = <TestERC20>await deploy("TestERC20", admin, []);
        await magic.mint(admin.address, amount);
        await magic.mint(user.address, amount);

        const token = <TestERC20>await deploy("TestERC20", admin, []);

        // deploy pool
        const pool = <DragonFireBreather>await deploy("DragonFireBreather", admin, [magic.address]);

        // deploy stash contracts
        const streamingStash = <StreamingDragonStash>(
            await deploy("StreamingDragonStash", admin, [magic.address, pool.address])
        );
        await magic.mint(streamingStash.address, amount);

        const basicStash = <BasicDragonStash>await deploy("BasicDragonStash", admin, [magic.address, pool.address]);

        // set permissions for pool
        await pool.grantRole(REWARD_STASH_ROLE, streamingStash.address);
        await pool.grantRole(REWARD_STASH_ROLE, basicStash.address);
        await pool.grantRole(DISTRIBUTOR_ROLE, admin.address);

        return {
            magic,
            token,
            admin,
            user,
            other,
            pool,
            streamingStash,
            basicStash,
        };
    };

    describe("Deployment", () => {
        it("reverts if deployed without a reward token", async () => {
            const factory = await ethers.getContractFactory("DragonFireBreather");

            await expect(factory.deploy(ZERO_ADDRESS)).to.be.revertedWith("No reward token");
        });

        it("initializes the correct roles and permissions", async () => {
            ctx = await loadFixture(fixture);
            const { pool, basicStash, streamingStash, admin } = ctx;

            expect(await pool.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
            expect(await pool.hasRole(DISTRIBUTOR_ROLE, admin.address)).to.be.true;
            expect(await pool.hasRole(REWARD_STASH_ROLE, admin.address)).to.be.false;
            expect(await pool.hasRole(REWARD_STASH_ROLE, basicStash.address)).to.be.true;
            expect(await pool.hasRole(REWARD_STASH_ROLE, streamingStash.address)).to.be.true;

            expect(await pool.getRoleAdmin(REWARD_STASH_ROLE)).to.eq(ADMIN_ROLE);
            expect(await pool.getRoleAdmin(DISTRIBUTOR_ROLE)).to.eq(ADMIN_ROLE);
        });
    });

    describe("Pool Management", () => {
        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        describe("add", () => {
            it("does not allow a non-admin to add a pool", async () => {
                const { pool, other, magic } = ctx;

                await expect(pool.connect(other).add(100, magic.address, ZERO_ADDRESS)).to.be.revertedWith(
                    "AccessControl",
                );
            });

            it("does not allow a pool without a staking token", async () => {
                const { pool, admin } = ctx;

                await expect(pool.connect(admin).add(100, ZERO_ADDRESS, ZERO_ADDRESS)).to.be.revertedWith(
                    "No reward token",
                );
            });

            it("adds a new pool", async () => {
                const { pool, admin, magic } = ctx;

                await expect(pool.connect(admin).add(100, magic.address, ZERO_ADDRESS))
                    .to.emit(pool, "LogPoolAddition")
                    .withArgs(0, 100, magic.address, ZERO_ADDRESS);

                expect(await pool.totalAllocPoint()).to.eq(100);
                expect(await pool.stakingToken(0)).to.eq(magic.address);
                expect(await pool.activeStakingTokens(magic.address)).to.be.true;

                const poolInfo = await pool.poolInfo(0);

                expect(poolInfo).to.not.be.undefined;
                expect(poolInfo.accRewardsPerShare).to.eq(0);
                expect(poolInfo.allocPoint).to.eq(100);
            });

            it("it does not allow the same staking token to be used across multiple tools", async () => {
                const { pool, admin, magic } = ctx;

                await expect(pool.connect(admin).add(100, magic.address, ZERO_ADDRESS))
                    .to.emit(pool, "LogPoolAddition")
                    .withArgs(0, 100, magic.address, ZERO_ADDRESS);

                await expect(pool.connect(admin).add(200, magic.address, ZERO_ADDRESS)).to.be.revertedWith(
                    "Token already used",
                );
            });
        });

        describe("set", () => {
            let pid: number;
            let rewarder: MockRewarder;

            beforeEach(async () => {
                const { pool, admin, magic } = ctx;

                await pool.connect(admin).add(100, magic.address, ZERO_ADDRESS);

                pid = 0;

                rewarder = await deploy("MockRewarder", admin, []);
            });

            it("does not allow a non-admin to change pool settings", async () => {
                const { pool, other } = ctx;

                await expect(pool.connect(other).set(pid, 50, rewarder.address, false)).to.be.revertedWith(
                    "AccessControl",
                );
            });

            it("reverts if the pool does not exist", async () => {
                const { pool, admin } = ctx;

                // Will revert with 0x32 - array out-of-bounds
                await expect(pool.connect(admin).set(pid + 1, 50, rewarder.address, false)).to.be.revertedWith(
                    "Pool does not exist",
                );
            });

            it("updates pool settings", async () => {
                const { pool, admin } = ctx;

                expect(await pool.totalAllocPoint()).to.eq(100);

                await expect(pool.connect(admin).set(pid, 50, rewarder.address, false))
                    .to.emit(pool, "LogSetPool")
                    .withArgs(pid, 50, ZERO_ADDRESS, false);

                expect(await pool.totalAllocPoint()).to.eq(50);
            });

            it("updates pool settings and overwrites rewarder", async () => {
                const { pool, admin } = ctx;

                expect(await pool.totalAllocPoint()).to.eq(100);

                await expect(pool.connect(admin).set(pid, 50, rewarder.address, true))
                    .to.emit(pool, "LogSetPool")
                    .withArgs(pid, 50, rewarder.address, true);

                expect(await pool.totalAllocPoint()).to.eq(50);
            });
        });
    });

    describe("Staking", () => {
        let pid: number;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);

            const { admin, streamingStash, user, pool, magic } = ctx;

            // Set up streamingStash
            await streamingStash.connect(admin).startStream(amount, STREAM_DURATION);

            // Approve deposit
            await magic.connect(user).approve(pool.address, amount);

            // Set up pool
            await pool.connect(admin).add(100, magic.address, ZERO_ADDRESS);

            pid = 0;
        });

        describe("deposit", () => {
            it("reverts if given an invalid pid", async () => {
                const { pool, user } = ctx;

                await expect(pool.connect(user).deposit(pid + 1, amount, user.address)).to.be.revertedWith(
                    "Pool does not exist",
                );
            });

            it("allows a user to deposit staking tokens", async () => {
                const { pool, user, magic } = ctx;

                await expect(pool.connect(user).deposit(pid, amount, user.address))
                    .to.emit(pool, "Deposit")
                    .withArgs(user.address, pid, amount, user.address);

                // Check stats
                const userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(amount);
                expect(userInfo.rewardDebt).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(0);
                expect(await magic.balanceOf(pool.address)).to.eq(amount);
            });

            it("allows a user to make multiple deposits to the same pool", async () => {
                const { pool, user, magic } = ctx;

                await expect(pool.connect(user).deposit(pid, amount.div(4), user.address))
                    .to.emit(pool, "Deposit")
                    .withArgs(user.address, pid, amount.div(4), user.address);

                // Check stats
                let userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(amount.div(4));
                expect(userInfo.rewardDebt).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount.div(4).mul(3));
                expect(await magic.balanceOf(pool.address)).to.eq(amount.div(4));

                await expect(pool.connect(user).deposit(pid, amount.div(2), user.address))
                    .to.emit(pool, "Deposit")
                    .withArgs(user.address, pid, amount.div(2), user.address);

                // Check stats
                userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(amount.div(4).mul(3));
                expect(userInfo.rewardDebt).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount.div(4));
                expect(await magic.balanceOf(pool.address)).to.eq(amount.div(4).mul(3));
            });

            it("allows a user to make multiple deposits to the same pool, over time", async () => {
                const { pool, admin, user, magic, basicStash } = ctx;
                await expect(pool.connect(user).deposit(pid, amount.div(4), user.address))
                    .to.emit(pool, "Deposit")
                    .withArgs(user.address, pid, amount.div(4), user.address);

                // Check stats
                let userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(amount.div(4));
                expect(userInfo.rewardDebt).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount.div(4).mul(3));
                expect(await magic.balanceOf(pool.address)).to.eq(amount.div(4));

                // Pull some rewards
                await magic.mint(basicStash.address, amount);
                await pool.connect(admin).pullRewards(basicStash.address);
                const { accRewardsPerShare } = await pool.poolInfo(pid);

                // Figure out reward per token
                await expect(pool.connect(user).deposit(pid, amount.div(2), user.address))
                    .to.emit(pool, "Deposit")
                    .withArgs(user.address, pid, amount.div(2), user.address);

                // Check stats
                userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(amount.div(4).mul(3));
                expect(userInfo.rewardDebt).to.eq(amount.div(2).mul(accRewardsPerShare).div(ether("1")));

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount.div(4));
                // Also add amount that was pulled from stash
                expect(await magic.balanceOf(pool.address)).to.eq(amount.div(4).mul(3).add(amount));
            });

            it("allows a user to make a third-party deposit", async () => {
                const { pool, user, other, magic } = ctx;

                await expect(pool.connect(user).deposit(pid, amount, other.address))
                    .to.emit(pool, "Deposit")
                    .withArgs(user.address, pid, amount, other.address);

                // Check stats
                const userInfo = await pool.userInfo(pid, other.address);
                expect(userInfo.amount).to.eq(amount);
                expect(userInfo.rewardDebt).to.eq(0);

                const depositorInfo = await pool.userInfo(pid, user.address);
                expect(depositorInfo.amount).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(0);
                expect(await magic.balanceOf(pool.address)).to.eq(amount);
            });
        });

        describe("withdraw", () => {
            beforeEach(async () => {
                // Make a deposit
                const { pool, user } = ctx;
                await pool.connect(user).deposit(pid, amount, user.address);
            });

            it("reverts if given an invalid pid", async () => {
                const { pool, user } = ctx;

                await expect(pool.connect(user).withdraw(pid + 1, amount, user.address)).to.be.revertedWith(
                    "Pool does not exist",
                );
            });

            it("reverts if the user has no deposit", async () => {
                const { pool, other } = ctx;

                await expect(pool.connect(other).withdraw(pid, amount, other.address)).to.be.revertedWith(
                    "No user deposit",
                );
            });

            it("reverts if attempting to withdraw more than deposited", async () => {
                const { pool, user } = ctx;

                await expect(pool.connect(user).withdraw(pid, amount.mul(2), user.address)).to.be.revertedWith(
                    "Not enough deposit",
                );
            });

            it("allows a user to withdraw", async () => {
                const { pool, user, magic } = ctx;

                await expect(pool.connect(user).withdraw(pid, amount, user.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount, user.address);

                // Check state
                const userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount);
                expect(await magic.balanceOf(pool.address)).to.eq(0);
            });

            it("allows a user to partially withdraw", async () => {
                const { pool, user, magic } = ctx;

                await expect(pool.connect(user).withdraw(pid, amount.div(2), user.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount.div(2), user.address);

                // Check state
                let userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(amount.div(2));

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount.div(2));
                expect(await magic.balanceOf(pool.address)).to.eq(amount.div(2));

                // Withdraw again
                await expect(pool.connect(user).withdraw(pid, amount.div(2), user.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount.div(2), user.address);

                // Check state
                userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount);
                expect(await magic.balanceOf(pool.address)).to.eq(0);
            });

            it("allows a user to partially withdraw, over time", async () => {
                const { pool, user, magic, admin, basicStash } = ctx;

                await expect(pool.connect(user).withdraw(pid, amount.div(2), user.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount.div(2), user.address);

                // Check state
                let userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(amount.div(2));
                expect(userInfo.rewardDebt).to.eq(0); // No rewards pulled

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount.div(2));
                expect(await magic.balanceOf(pool.address)).to.eq(amount.div(2));

                // Pull some rewards
                await magic.mint(basicStash.address, amount);
                await pool.connect(admin).pullRewards(basicStash.address);
                const { accRewardsPerShare } = await pool.poolInfo(pid);

                // Withdraw again
                await expect(pool.connect(user).withdraw(pid, amount.div(2), user.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount.div(2), user.address);

                // Check state - reward debt should be decremented
                userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(0);
                expect(userInfo.rewardDebt).to.eq(amount.div(2).mul(accRewardsPerShare).div(ether("1").mul(-1)));

                // Check balances
                // Pool still has pulled rewards left (none harvested)
                expect(await magic.balanceOf(user.address)).to.eq(amount);
                expect(await magic.balanceOf(pool.address)).to.eq(amount);
            });

            it("allows a user to withdraw to a third-party address", async () => {
                const { pool, user, magic, other } = ctx;

                await expect(pool.connect(user).withdraw(pid, amount, other.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount, other.address);

                // Check state
                const userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(0);
                expect(await magic.balanceOf(other.address)).to.eq(amount);
                expect(await magic.balanceOf(pool.address)).to.eq(0);
            });
        });

        describe("harvest", () => {
            beforeEach(async () => {
                // Make a deposit
                const { pool, user, magic, admin, basicStash } = ctx;
                await pool.connect(user).deposit(pid, amount, user.address);

                // Pull some rewards
                await magic.mint(basicStash.address, amount);
                await pool.connect(admin).pullRewards(basicStash.address);
            });

            it("reverts if given an invalid pid", async () => {
                const { pool, user } = ctx;

                await expect(pool.connect(user).harvest(pid + 1, user.address)).to.be.revertedWith(
                    "Pool does not exist",
                );
            });

            it("harvests 0 if the user has no deposit", async () => {
                const { pool, other } = ctx;

                await expect(pool.connect(other).harvest(pid, other.address))
                    .to.emit(pool, "Harvest")
                    .withArgs(other.address, pid, 0);
            });

            it("distributes the correct amount of rewards", async () => {
                const { pool, user, other, magic, basicStash, admin } = ctx;

                // Have other deposit same amount as user
                await magic.mint(other.address, amount);
                await magic.connect(other).approve(pool.address, amount);
                await pool.connect(other).deposit(pid, amount, other.address);

                // Pull rewards again
                await magic.mint(basicStash.address, amount);
                await pool.connect(admin).pullRewards(basicStash.address);

                // User should get 75% of rewards - all from first pull, half from second
                await expect(pool.connect(user).harvest(pid, user.address))
                    .to.emit(pool, "Harvest")
                    .withArgs(user.address, pid, amount.div(2).mul(3));

                expect(await magic.balanceOf(user.address)).to.eq(amount.div(2).mul(3));
                expect(await magic.balanceOf(pool.address)).to.eq(amount.div(2).mul(5));
            });

            it("successive reward claims distribute 0", async () => {
                const { pool, user, other, magic, basicStash, admin } = ctx;

                // Have other deposit same amount as user
                await magic.mint(other.address, amount);
                await magic.connect(other).approve(pool.address, amount);
                await pool.connect(other).deposit(pid, amount, other.address);

                // Pull rewards again
                await magic.mint(basicStash.address, amount);
                await pool.connect(admin).pullRewards(basicStash.address);

                // User should get 75% of rewards - all from first pull, half from second
                await expect(pool.connect(user).harvest(pid, user.address))
                    .to.emit(pool, "Harvest")
                    .withArgs(user.address, pid, amount.div(2).mul(3));

                expect(await magic.balanceOf(user.address)).to.eq(amount.div(2).mul(3));
                expect(await magic.balanceOf(pool.address)).to.eq(amount.div(2).mul(5));

                // Try to harvest again
                await expect(pool.connect(user).harvest(pid, user.address))
                    .to.emit(pool, "Harvest")
                    .withArgs(user.address, pid, 0);
            });

            it("distributes rewards to a third-party address", async () => {
                const { pool, user, other, magic } = ctx;

                await expect(pool.connect(user).harvest(pid, other.address))
                    .to.emit(pool, "Harvest")
                    .withArgs(user.address, pid, amount);

                expect(await magic.balanceOf(user.address)).to.eq(0);
                expect(await magic.balanceOf(other.address)).to.eq(amount);
                expect(await magic.balanceOf(pool.address)).to.eq(amount);
            });
        });

        describe("withdrawAndHarvest", () => {
            beforeEach(async () => {
                // Make a deposit
                const { pool, user, magic, admin, basicStash } = ctx;
                await pool.connect(user).deposit(pid, amount, user.address);

                // Pull some rewards
                await magic.mint(basicStash.address, amount);
                await pool.connect(admin).pullRewards(basicStash.address);
            });

            it("reverts if given an invalid pid", async () => {
                const { pool, user } = ctx;

                await expect(pool.connect(user).withdrawAndHarvest(pid + 1, amount, user.address)).to.be.revertedWith(
                    "Pool does not exist",
                );
            });

            it("reverts if the user has no deposit", async () => {
                const { pool, other } = ctx;

                await expect(pool.connect(other).withdrawAndHarvest(pid, amount, other.address)).to.be.revertedWith(
                    "No user deposit",
                );
            });

            it("reverts if attempting to withdraw more than deposited", async () => {
                const { pool, user } = ctx;

                await expect(
                    pool.connect(user).withdrawAndHarvest(pid, amount.mul(2), user.address),
                ).to.be.revertedWith("Not enough deposit");
            });

            it("distributes the correct amount of token rewards", async () => {
                const { pool, user, magic } = ctx;

                await expect(pool.connect(user).withdrawAndHarvest(pid, amount, user.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount, user.address)
                    .to.emit(pool, "Harvest")
                    .withArgs(user.address, pid, amount);

                // Check state
                const userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(0);
                expect(userInfo.rewardDebt).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount.mul(2));
                expect(await magic.balanceOf(pool.address)).to.eq(0);
            });

            it("allows a user to partially withdraw with full reward distribution", async () => {
                const { pool, user, magic } = ctx;

                await expect(pool.connect(user).withdrawAndHarvest(pid, amount.div(2), user.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount.div(2), user.address)
                    .to.emit(pool, "Harvest")
                    .withArgs(user.address, pid, amount);

                // Check state
                const { accRewardsPerShare } = await pool.poolInfo(pid);
                let userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(amount.div(2));
                expect(userInfo.rewardDebt).to.eq(amount.div(2).mul(accRewardsPerShare).div(ether("1")));

                // Check balances - also includes rewards now
                expect(await magic.balanceOf(user.address)).to.eq(amount.div(2).mul(3));
                expect(await magic.balanceOf(pool.address)).to.eq(amount.div(2));

                // Withdraw again
                await expect(pool.connect(user).withdrawAndHarvest(pid, amount.div(2), user.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount.div(2), user.address)
                    .to.emit(pool, "Harvest")
                    .withArgs(user.address, pid, 0);

                // Check state
                userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(0);
                expect(userInfo.rewardDebt).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount.mul(2));
                expect(await magic.balanceOf(pool.address)).to.eq(0);
            });

            it("allows partial calls to withdrawAndHarvest, over time", async () => {
                const { pool, user, other, magic, basicStash, admin } = ctx;

                // Have other deposit same amount as user
                await magic.mint(other.address, amount);
                await magic.connect(other).approve(pool.address, amount);
                await pool.connect(other).deposit(pid, amount, other.address);

                // Have first user withdraw 75% of their stake
                await expect(pool.connect(user).withdrawAndHarvest(pid, amount.div(4).mul(3), user.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount.div(4).mul(3), user.address)
                    .to.emit(pool, "Harvest")
                    .withArgs(user.address, pid, amount);

                // Pull rewards again
                await magic.mint(basicStash.address, amount);
                await pool.connect(admin).pullRewards(basicStash.address);

                // User should get 20% of remaining rewards from second batch
                await expect(pool.connect(user).withdrawAndHarvest(pid, amount.div(4), user.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount.div(4), user.address)
                    .to.emit(pool, "Harvest")
                    .withArgs(user.address, pid, amount.div(5));

                expect(await magic.balanceOf(user.address)).to.eq(amount.div(5).mul(11));
                expect(await magic.balanceOf(pool.address)).to.eq(amount.div(5).mul(9));
            });

            it("distributes staking tokens and rewards to a third-party address", async () => {
                const { pool, user, other, magic } = ctx;

                await expect(pool.connect(user).withdrawAndHarvest(pid, amount, other.address))
                    .to.emit(pool, "Withdraw")
                    .withArgs(user.address, pid, amount, other.address)
                    .to.emit(pool, "Harvest")
                    .withArgs(user.address, pid, amount);

                // Check state
                const userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(0);
                expect(userInfo.rewardDebt).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(0);
                expect(await magic.balanceOf(other.address)).to.eq(amount.mul(2));
                expect(await magic.balanceOf(pool.address)).to.eq(0);
            });
        });

        describe("emergencyWithdraw", () => {
            beforeEach(async () => {
                // Make a deposit
                const { pool, user, magic, admin, basicStash } = ctx;
                await pool.connect(user).deposit(pid, amount, user.address);

                // Pull some rewards
                await magic.mint(basicStash.address, amount);
                await pool.connect(admin).pullRewards(basicStash.address);
            });

            it("reverts if given an invalid pid", async () => {
                const { pool, user } = ctx;

                await expect(pool.connect(user).emergencyWithdraw(pid + 1, user.address)).to.be.revertedWith(
                    "Pool does not exist",
                );
            });

            it("reverts if the user has no deposit", async () => {
                const { pool, other } = ctx;

                await expect(pool.connect(other).emergencyWithdraw(pid, other.address)).to.be.revertedWith(
                    "No user deposit",
                );
            });

            it("allows a user to withdraw and does not update rewards", async () => {
                const { pool, user, magic } = ctx;

                await expect(pool.connect(user).emergencyWithdraw(pid, user.address))
                    .to.emit(pool, "EmergencyWithdraw")
                    .withArgs(user.address, pid, amount, user.address);

                // Check state
                const userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(0);
                expect(userInfo.rewardDebt).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount); // Only deposit, no rewards
                expect(await magic.balanceOf(pool.address)).to.eq(amount); // Leftover rewards
            });

            it("allows a user to withdraw to a third-party address", async () => {
                const { pool, user, other, magic } = ctx;

                await expect(pool.connect(user).emergencyWithdraw(pid, other.address))
                    .to.emit(pool, "EmergencyWithdraw")
                    .withArgs(user.address, pid, amount, other.address);

                // Check state
                const userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(0);
                expect(userInfo.rewardDebt).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(0);
                expect(await magic.balanceOf(other.address)).to.eq(amount); // Only deposit, no rewards
                expect(await magic.balanceOf(pool.address)).to.eq(amount); // Leftover rewards
            });

            it("does not allow a user to harvest after an emergency withdraw", async () => {
                const { pool, user, magic } = ctx;

                await expect(pool.connect(user).emergencyWithdraw(pid, user.address))
                    .to.emit(pool, "EmergencyWithdraw")
                    .withArgs(user.address, pid, amount, user.address);

                // Check state
                const userInfo = await pool.userInfo(pid, user.address);
                expect(userInfo.amount).to.eq(0);
                expect(userInfo.rewardDebt).to.eq(0);

                // Check balances
                expect(await magic.balanceOf(user.address)).to.eq(amount); // Only deposit, no rewards
                expect(await magic.balanceOf(pool.address)).to.eq(amount); // Leftover rewards

                // Try to harvest
                await expect(pool.connect(user).harvest(pid, user.address))
                    .to.emit(pool, "Harvest")
                    .withArgs(user.address, pid, 0);

                // Check balances - no change
                expect(await magic.balanceOf(user.address)).to.eq(amount);
                expect(await magic.balanceOf(pool.address)).to.eq(amount);
            });
        });
    });

    describe("Reward Management", () => {
        beforeEach(async () => {
            ctx = await loadFixture(fixture);

            const { admin, basicStash, user, pool, magic } = ctx;

            // Approve deposit
            await magic.connect(user).approve(pool.address, amount);

            // Set up pool
            await pool.connect(admin).add(100, magic.address, ZERO_ADDRESS);

            // Fund some stash
            await magic.mint(basicStash.address, amount);

            // Make a deposit
            await pool.connect(user).deposit(0, amount, user.address);
        });

        it("does not allow a non-distributor to pull rewards", async () => {
            const { pool, user, basicStash } = ctx;

            await expect(pool.connect(user).pullRewards(basicStash.address)).to.be.revertedWith("AccessControl");
        });

        it("pulls rewards and distributes according to alloc points", async () => {
            const { admin, pool, basicStash, magic } = ctx;

            // Pull some rewards
            const tx = await pool.connect(admin).pullRewards(basicStash.address);
            const receipt = await tx.wait();

            // Check LogUpdatePool events
            const lupEvent = receipt?.events?.find(e => e.event == "LogUpdatePool");

            // Make sure poolInfo is correct
            expect(lupEvent).to.not.be.undefined;
            expect(lupEvent?.args?.[0]).to.eq(0);
            expect(lupEvent?.args?.[2]).to.eq(amount);
            expect(lupEvent?.args?.[3]).to.eq(amount.mul(ether("1")).div(amount));

            // Check balances
            expect(await magic.balanceOf(basicStash.address)).to.eq(0);
            expect(await magic.balanceOf(pool.address)).to.eq(amount.mul(2));
        });
    });

    describe("View Functions", () => {
        beforeEach(async () => {
            ctx = await loadFixture(fixture);
        });

        it("reports the correct pool length", async () => {
            const { token, magic, admin, pool } = ctx;

            expect(await pool.poolLength()).to.eq(0);

            await pool.connect(admin).add(100, magic.address, ZERO_ADDRESS);

            expect(await pool.poolLength()).to.eq(1);

            // Add a second pool
            await pool.connect(admin).add(25, token.address, ZERO_ADDRESS);

            expect(await pool.poolLength()).to.eq(2);
        });

        it("reports the correct pending rewards for a user", async () => {
            const { pool, user, other, magic, basicStash, admin } = ctx;

            await pool.connect(admin).add(100, magic.address, ZERO_ADDRESS);
            const pid = 0;

            // Deposit for the user
            await magic.connect(user).approve(pool.address, amount);
            await pool.connect(user).deposit(pid, amount, user.address);

            // Pull some rewards
            await magic.mint(basicStash.address, amount);
            await pool.connect(admin).pullRewards(basicStash.address);

            // Check pending rewards for user
            expect(await pool.pendingRewards(pid, user.address)).to.eq(amount);

            // Have other deposit same amount as user
            await magic.mint(other.address, amount);
            await magic.connect(other).approve(pool.address, amount);
            await pool.connect(other).deposit(pid, amount, other.address);

            // Pull rewards again
            await magic.mint(basicStash.address, amount);
            await pool.connect(admin).pullRewards(basicStash.address);

            // User should get 75% of rewards - all from first pull, half from second
            expect(await pool.pendingRewards(pid, user.address)).to.eq(amount.div(2).mul(3));
        });

        it("reports user info for a pool", async () => {
            const { pool, admin, user, magic, basicStash } = ctx;

            await pool.connect(admin).add(100, magic.address, ZERO_ADDRESS);
            const pid = 0;

            // Deposit for the user
            await magic.connect(user).approve(pool.address, amount);
            await pool.connect(user).deposit(pid, amount.div(2), user.address);

            // Check stats
            let userInfo = await pool.getUserInfo(pid, user.address);
            let [stakeAmount, rewardDebt] = userInfo;
            expect(stakeAmount).to.eq(amount.div(2));
            expect(rewardDebt).to.eq(0);

            // Pull some rewards
            await magic.mint(basicStash.address, amount);
            await pool.connect(admin).pullRewards(basicStash.address);
            const { accRewardsPerShare } = await pool.poolInfo(pid);

            // Deposit again
            await pool.connect(user).deposit(pid, amount.div(2), user.address);

            // Pull some more rewards
            await magic.mint(basicStash.address, amount);
            await pool.connect(admin).pullRewards(basicStash.address);

            // Check stats - make sure rewardDebt updated based on last accRewardsBeforeDeposit
            userInfo = await pool.getUserInfo(pid, user.address);
            [stakeAmount, rewardDebt] = userInfo;
            expect(stakeAmount).to.eq(amount);
            expect(rewardDebt).to.eq(amount.div(2).mul(accRewardsPerShare).div(ether("1")));

            // User should get all rewards - all from first pull, half from second
            await expect(pool.connect(user).harvest(pid, user.address))
                .to.emit(pool, "Harvest")
                .withArgs(user.address, pid, amount.mul(2));
        });
    });

    describe("Multiple Pools", () => {
        beforeEach(async () => {
            ctx = await loadFixture(fixture);

            const { admin, basicStash, user, pool, magic, token } = ctx;

            // Approve deposit
            await magic.connect(user).approve(pool.address, amount);

            // Set up two pools
            await pool.connect(admin).add(100, magic.address, ZERO_ADDRESS);
            await pool.connect(admin).add(25, token.address, ZERO_ADDRESS);

            // Fund some stash
            await magic.mint(basicStash.address, amount);
        });

        it("distributes according to allocPoint", async () => {
            const { token, admin, user, other, pool, basicStash } = ctx;

            // Make a deposit to first pool
            await pool.connect(user).deposit(0, amount, user.address);

            // Stake a bit in second pool
            await token.mint(other.address, amount.mul(2));
            await token.connect(other).approve(pool.address, amount.mul(2));
            await pool.connect(other).deposit(1, amount.mul(2), other.address);

            // Pull some rewards
            const tx = await pool.connect(admin).pullRewards(basicStash.address);
            const receipt = await tx.wait();

            // Check LogUpdatePool events
            const lupEvents = receipt?.events?.filter(e => e.event == "LogUpdatePool");

            // Make sure poolInfo is correct
            expect(lupEvents).to.not.be.undefined;
            expect(lupEvents?.length).to.eq(2);
            expect(lupEvents?.[0]?.args?.[0]).to.eq(0);
            expect(lupEvents?.[0]?.args?.[2]).to.eq(amount);
            expect(lupEvents?.[0]?.args?.[3]).to.eq(amount.div(5).mul(4).mul(ether("1")).div(amount));
            expect(lupEvents?.[1]?.args?.[0]).to.eq(1);
            expect(lupEvents?.[1]?.args?.[2]).to.eq(amount.mul(2));
            expect(lupEvents?.[1]?.args?.[3]).to.eq(amount.div(10).mul(ether("1")).div(amount));
        });

        it("distributes correctly after updating allocPoint", async () => {
            const { token, magic, admin, user, other, pool, basicStash } = ctx;

            // Make a deposit to first pool
            await pool.connect(user).deposit(0, amount, user.address);

            // Stake a bit in second pool
            await token.mint(other.address, amount.mul(2));
            await token.connect(other).approve(pool.address, amount.mul(2));
            await pool.connect(other).deposit(1, amount.mul(2), other.address);

            // Pull some rewards
            await pool.connect(admin).pullRewards(basicStash.address);
            const { accRewardsPerShare: accRewardsPerShare0 } = await pool.poolInfo(0);
            const { accRewardsPerShare: accRewardsPerShare1 } = await pool.poolInfo(1);

            // Change the alloc points, give pool 1 equal share
            await pool.connect(admin).set(1, 100, ZERO_ADDRESS, false);

            // Pull some more rewards
            await magic.mint(basicStash.address, amount);
            const tx = await pool.connect(admin).pullRewards(basicStash.address);
            const receipt = await tx.wait();

            // Check LogUpdatePool events
            const lupEvents = receipt?.events?.filter(e => e.event == "LogUpdatePool");

            // Make sure poolInfo is correct
            // Pool 0:
            expect(lupEvents).to.not.be.undefined;
            expect(lupEvents?.length).to.eq(2);
            expect(lupEvents?.[0]?.args?.[0]).to.eq(0);
            expect(lupEvents?.[0]?.args?.[2]).to.eq(amount);
            expect(lupEvents?.[0]?.args?.[3]).to.eq(accRewardsPerShare0.add(amount.div(2).mul(ether("1")).div(amount)));

            expect(lupEvents?.[1]?.args?.[0]).to.eq(1);
            expect(lupEvents?.[1]?.args?.[2]).to.eq(amount.mul(2));
            expect(lupEvents?.[1]?.args?.[3]).to.eq(
                accRewardsPerShare1.add(amount.div(2).mul(ether("1")).div(amount.mul(2))),
            );
        });

        it("harvesting from one pool does not affect other pool", async () => {
            const { token, magic, admin, user, pool, basicStash } = ctx;

            // Make a deposit to first pool
            await pool.connect(user).deposit(0, amount, user.address);

            // Stake a bit in second pool
            await token.mint(user.address, amount.mul(2));
            await token.connect(user).approve(pool.address, amount.mul(2));
            await pool.connect(user).deposit(1, amount.mul(2), user.address);

            // Pull some rewards
            await pool.connect(admin).pullRewards(basicStash.address);

            // Change the alloc points, give pool 1 equal share
            await pool.connect(admin).set(1, 100, ZERO_ADDRESS, false);

            // Pull some more rewards
            await magic.mint(basicStash.address, amount);
            await pool.connect(admin).pullRewards(basicStash.address);

            // Harvest from one pool
            await pool.connect(user).harvest(1, user.address);

            // Check other pool still has pending rewards
            expect(await pool.pendingRewards(0, user.address)).to.eq(amount.div(10).mul(13));
        });
    });

    describe("Rewarder Contract", () => {
        it("calls the correct function on rewarder contract on deposit");
        it("calls the correct function on rewarder contract on withdraw");
        it("calls the correct function on rewarder contract on harvest");
        it("calls the correct function on rewarder contract on withdrawAndHarvest");
    });

    describe("Migration", () => {
        it("does not allow a non-admin to set the migrator contract");
        it("allows an admin to set a migrator contract");
        it("migrates one staking token to another staking token via migrator contract");
        it("fails to migrate if token amounts are not preserved over migration");
    });

    describe("Advanced Scenarios", () => {
        // scenario 1, multiple depositors at different times, same pools, no harvests between deposits
        // scenario 2, multiple pools, depositor overlap, multiple deposits
        // scenario 3, multiple pools, depositor overlap, with partial withdrawals
        // scenario 4, scenario 3, with migration
    });
});
