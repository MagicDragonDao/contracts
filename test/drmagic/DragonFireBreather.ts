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
    stash: StreamingDragonStash;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const ADMIN_ROLE = "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775";
const REWARD_STASH_ROLE = "0x6d5e2be2384f7cf31b2f788488ae165959caf2b96f1a210e510ee2ad6fcb24c2";
const DISTRIBUTOR_ROLE = "0xfbd454f36a7e1a388bd6fc3ab10d434aa4578f811acbbcf33afb1c697486313c";

describe("DragonFireBreather (MasterChef V2)", () => {
    let ctx: TestContext;

    const amount = ether("1000");

    const fixture = async (): Promise<TestContext> => {
        const [admin, user, other] = await ethers.getSigners();

        const magic = <TestERC20>await deploy("TestERC20", admin, []);
        await magic.mint(admin.address, amount);

        const token = <TestERC20>await deploy("TestERC20", admin, []);

        // deploy pool
        const pool = <DragonFireBreather>await deploy("DragonFireBreather", admin, [magic.address]);

        // deploy stash contracts
        const stash = <StreamingDragonStash>await deploy("StreamingDragonStash", admin, [magic.address, pool.address]);

        // set permissions for pool
        await pool.grantRole(REWARD_STASH_ROLE, stash.address);
        await pool.grantRole(DISTRIBUTOR_ROLE, admin.address);

        return {
            magic,
            token,
            admin,
            user,
            other,
            pool,
            stash,
        };
    };

    describe("Deployment", () => {
        it("reverts if deployed without a reward token", async () => {
            const factory = await ethers.getContractFactory("DragonFireBreather");

            await expect(factory.deploy(ZERO_ADDRESS)).to.be.revertedWith("No reward token");
        });

        it("initializes the correct roles and permissions", async () => {
            ctx = await loadFixture(fixture);
            const { pool, stash, admin } = ctx;

            expect(await pool.hasRole(ADMIN_ROLE, admin.address)).to.be.true;
            expect(await pool.hasRole(DISTRIBUTOR_ROLE, admin.address)).to.be.true;
            expect(await pool.hasRole(REWARD_STASH_ROLE, admin.address)).to.be.false;
            expect(await pool.hasRole(REWARD_STASH_ROLE, stash.address)).to.be.true;

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
                await expect(pool.connect(admin).set(pid + 1, 50, rewarder.address, false)).to.be.reverted;
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
        describe("deposit", () => {
            it("reverts if given an invalid pid");
            it("allows a user to deposit staking tokens");
            it("allows a user to make multiple deposits to the same pool");
            it("allows a user to make a third-party deposit");
        });

        describe("withdraw", () => {
            it("reverts if given an invalid pid");
            it("reverts if the user has no deposit");
            it("reverts if attempting to withdraw more than deposited");
            it("allows a user to withdraw");
            it("allows a user to partially withdraw");
            it("allows a user to withdraw to a third-party address");
        });

        describe("harvest", () => {
            it("reverts if given an invalid pid");
            it("reverts if the user has no deposit");
            it("distributes the correct amount of rewards");
            it("successive reward claims distribute 0");
            it("distributes rewards to a third-party address");
        });

        describe("withdrawAndHarvest", () => {
            it("reverts if given an invalid pid");
            it("reverts if the user has no deposit");
            it("distributes the correct amount of staking tokens rewards");
            it("allows a user to partially withdraw with full reward distribution");
            it("distributes staking tokens and rewards to a third-party address");
        });

        describe("emergencyWithdraw", () => {
            it("reverts if given an invalid pid");
            it("reverts if the user has no deposit");
            it("allows a user to withdraw and does not update rewards");
            it("allows a user to withdraw to a third-party address");
        });
    });

    describe("Reward Management", () => {
        it("does not allow a non-distributor to pull rewards");
        it("pulls rewards and distributes according to pull alloc points");
    });

    describe("View Functions", () => {
        it("reports the correct pool length");
        it("reports the correct pending rewards for a user");
        it("reports user info for a pool");
    });

    describe("Multiple Pools", () => {
        it("distributes according to allocPoint");
        it("distributes correctly after updating allocPoint");
        it("harvesting from one pool does not affect other pool");
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
});
