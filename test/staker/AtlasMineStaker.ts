import { ethers, waffle } from "hardhat";
import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import { expect } from "chai";

const { loadFixture } = waffle;

import { deploy, setNextBlockTimestamp } from "../utils";

import type { AtlasMineStaker } from "../../src/types/AtlasMineStaker";
import type { MasterOfCoin } from "../../src/types/MasterOfCoin";
import type { AtlasMine } from "../../src/types/AtlasMine";
import type { TestERC20 } from "../../src/types/TestERC20";
import type { TestERC1155 } from "../../src/types/TestERC1155";
import type { TestERC721 } from "../../src/types/TestERC721";

import { stakeSingle, stakeMultiple, stakeSequence, withdrawSingle, rollSchedule, rollLock, rollTo } from "./helpers";

const ether = ethers.utils.parseEther;

interface TestContext {
  signers: SignerWithAddress[];
  admin: SignerWithAddress;
  users: SignerWithAddress[];
  staker: AtlasMineStaker;
  masterOfCoin: MasterOfCoin;
  mine: AtlasMine;
  magic: TestERC20;
  treasures: TestERC1155;
  legions: TestERC721;
  start: number;
  end: number;
}

describe("Atlas Mine Staking (Pepe Pool)", () => {
  let ctx: TestContext;

  const fixture = async (): Promise<TestContext> => {
    const signers = await ethers.getSigners();
    const [admin, ...users] = signers.slice(0, 5);

    // Deploy contracts
    const magic = <TestERC20>await deploy("TestERC20", admin, []);
    const treasures = <TestERC1155>await deploy("TestERC1155", admin, []);
    const legions = <TestERC721>await deploy("TestERC721", admin, []);

    const masterOfCoin = <MasterOfCoin>await deploy("MasterOfCoin", admin, []);
    await masterOfCoin.init(magic.address);

    const mine = <AtlasMine>await deploy("AtlasMine", admin, []);
    await mine.init(magic.address, masterOfCoin.address);
    await mine.setTreasure(treasures.address);
    await mine.setLegion(legions.address);
    await mine.setUtilizationOverride(ether("1"));

    const staker = <AtlasMineStaker>await deploy("AtlasMineStaker", admin, [
      magic.address,
      mine.address,
      0, // 0 == AtlasMine.Lock.twoWeeks
    ]);

    // Distribute coins and set up staking program
    await magic.mint(admin.address, ether("10000"));
    await magic.mint(masterOfCoin.address, ether("20000"));

    const DAY_SEC = 86400;
    // Put start time in the future - we will fast-forward
    const start = Math.floor(Date.now() / 1000) + 1_000_000_000;
    const end = start + 140 * DAY_SEC;

    // 140 day program, 1000 MAGIC distributed per day
    await masterOfCoin.addStream(mine.address, ether("140000"), start, end, false);

    // Give 100000 MAGIC to each user and approve the staker contract
    const stakerFunding = users.map(u => magic.mint(u.address, ether("100000")));
    const stakerApprove = users.map(u => magic.connect(u).approve(staker.address, ether("100000")));
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
      staker,
      start,
      end,
    };
  };

  beforeEach(async () => {
    ctx = await loadFixture(fixture);
  });

  describe("Staking", () => {
    describe("stake", () => {
      it("does not allow a user to stake if their specified amount is 0", async () => {
        const {
          users: [user],
          staker,
        } = ctx;

        await expect(stakeSingle(staker, user, 0)).to.be.revertedWith("Deposit amount 0");
      });

      it("does not allow a user to stake if their deposit is too small", async () => {
        const {
          users: [user1, user2],
          staker,
        } = ctx;

        // User 1s deposit must be 1e9 times user two's deposit
        // Here we use 1E vs. 1 wei
        await expect(
          stakeSequence(staker, [
            [user1, ether("1")],
            [user2, 1],
          ]),
        ).to.be.revertedWith("Deposit too small");
      });

      it("allows a user to stake", async () => {
        const {
          users: [user],
          staker,
          magic,
        } = ctx;
        const amount = ether("10");

        await expect(stakeSingle(staker, user, amount)).to.emit(staker, "UserDeposit").withArgs(user.address, amount);

        expect(await staker.userStake(user.address)).to.eq(amount);
        expect(await magic.balanceOf(user.address)).to.eq(ether("99990"));

        // TODO: Check mine status if we do insta-stake
      });
    });

    describe("withdraw", () => {
      it("does not allow a user to withdraw if they have not staked", async () => {
        const {
          users: [user1, user2],
          staker,
        } = ctx;
        await stakeSingle(staker, user1, ether("10"));

        await expect(withdrawSingle(staker, user2)).to.be.revertedWith("No deposit");
      });

      it("does not allow a user to withdraw if there are not enough unlocked coins", async () => {
        const {
          users: [user],
          staker,
        } = ctx;
        await stakeSingle(staker, user, ether("10"));

        await rollSchedule(staker);

        await expect(withdrawSingle(staker, user)).to.be.revertedWith("Cannot unstake enough");
      });

      it("efficiently unstakes locked coins to retain as much reward-earning deposit as possible", async () => {
        const {
          users: [user1, user2],
          staker,
          magic,
          mine,
        } = ctx;

        // Deposit 10, get it staked with another user's 10
        // Stake more than rewards to force a withdraw
        // With 2 stakers, each will earn 7000 MAGIC over lock period
        const amount = ether("20000");
        await stakeMultiple(staker, [
          [user1, amount],
          [user2, amount],
        ]);

        await rollSchedule(staker);

        // Fast-forward and try to withdraw - other 10 should stay
        await rollLock();

        // No rewards because program hasn't started yet
        await expect(withdrawSingle(staker, user1)).to.emit(staker, "UserWithdraw").withArgs(user1.address, amount, 0);

        // User returned all funds
        expect(await magic.balanceOf(user1.address)).to.eq(ether("100000"));

        // Check that rest of stake is still in AtlasMine, not staker
        const depositId = await mine.currentId(staker.address);
        const stakeInfo = await mine.userInfo(staker.address, depositId);
        expect(stakeInfo.originalDepositAmount).to.eq(amount.mul(2));
        expect(stakeInfo.depositAmount).to.eq(amount);
      });

      it("withdrawal distributes the correct amount of pro rata rewards", async () => {
        const {
          users: [user1, user2],
          staker,
          magic,
          start,
        } = ctx;

        // Deposit 10, get it staked with another user's 10
        // Stake more than rewards to force a withdraw
        // With 2 stakers, each will earn 7000 MAGIC over lock period
        const amount = ether("20000");
        await stakeMultiple(staker, [
          [user1, amount],
          [user2, amount],
        ]);

        // Go to start of rewards program
        await rollTo(start);

        // Make a tx to deposit
        await rollSchedule(staker);

        // Fast-forward - 15 days should pass, to 15k rewards total to pool
        // User 1 would deposit half
        await rollLock();

        await expect(withdrawSingle(staker, user1))
          .to.emit(staker, "UserWithdraw")
          .withArgs(user1.address, amount, ether("7500"));

        // User returned all funds + reward
        expect(await magic.balanceOf(user1.address)).to.eq(ether("107500"));
      });

      it("withdrawal distributes the correct amount of pro rata rewards (multiple deposit times)");
    });

    describe("claim", () => {
      it("does not allow a user to claim if there are not enough unlocked coins");
      it("distributes the correct amount of pro rata rewards");
      it("distributes the correct amount of pro rata rewards (multiple users)");
    });
  });

  describe("NFT-boosted staking", () => {
    it("does not allow a non-hoard caller to stake a treasure");
    it("does not allow a non-hoard caller to stake a legion");
    it("allows the hoard to stake a treasure");
    it("allows the hoard to stake a legion");
    it("distributes the correct pro rate rewards with a boost multiplier");
    it("does not allow a non-hoard caller to unstake a treasure");
    it("does not allow a non-hoard caller to unstake a legion");
    it("allows the hoard to unstake a treasure");
    it("allows the hoard to unstake a legion");
  });

  describe("View Functions", () => {
    it("returns the correct amount of user stake");
    it("returns the correct amount of magic controlled by the contract");
    it("returns the correct amount of pending, undeposited stake");
    it("returns the correct amount of withdrawable MAGIC");
  });

  describe("Owner Operations", () => {
    describe("Administration", () => {
      it("does not allow a non-owner to set the reward fee");
      it("allows the owner to set the reward fee");
      it("collects the correct fee when rewards are claimed");
      it("does not allow a non-owner to withdraw collected fees");
      it("allows the owner to withdraw collected fees");
      it("does not allow a non-owner to change the hoard address");
      it("allows the owner to change the hoard address");
    });

    describe("Stake Management", () => {
      it("does not allow a non-owner to unstake to a specified target");
      it("allows an owner to unstake to a specified target");
      it("does not allow a non-owner to unstake all possible stake");
      it("allows an owner to unstake all possible stake");
    });
  });

  describe("Emergency Flows", () => {
    it("does not allow a non-owner to pause the stake schedule");
    it("allows the owner to pause the stake schedule");
    it("does not allow a non-owner to unstake everything from the mine");
    it("does not allow an emergency unstake if new stakes are not paused");
    it("unstakes everything possible from mine");
    it("does not allow a user to emergency withdraw if new stakes are not paused");
    it("allows a user to withdraw after an emergency unstake");
    it("allows a user to emergency withdraw after unstake (no rewards)");
  });
});
