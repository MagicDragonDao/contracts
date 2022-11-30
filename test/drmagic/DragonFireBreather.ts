/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ethers, waffle } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";

const { loadFixture } = waffle;

import { deploy, expectRoundedEqual, ether } from "../utils";
import type { TestERC20, BasicDragonStash, StreamingDragonStash, DragonFireBreather } from "../../src/types";

interface TestContext {
    magic: TestERC20;
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

        // deploy pool
        const pool = <DragonFireBreather>await deploy("DragonFireBreather", admin, [magic.address]);

        // deploy stash contracts
        const stash = <StreamingDragonStash>await deploy("StreamingDragonStash", admin, [magic.address, pool.address]);

        // set permissions for pool
        await pool.grantRole(REWARD_STASH_ROLE, stash.address);
        await pool.grantRole(DISTRIBUTOR_ROLE, admin.address);

        return {
            magic,
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
        describe("add", () => {
            it("does not allow a non-admin to add a pool");
            it("does not allow a pool without a staking token");
            it("adds a new pool");
            it("it does not allow the same staking token to be used across multiple tools");
        });

        describe("set", () => {
            it("does not allow a non-admin to change pool settings");
            it("updates pool settings");
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
