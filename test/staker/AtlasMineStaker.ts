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

const ether = ethers.utils.parseEther;

interface TestContext {
  signers: SignerWithAddress[];
  admin: SignerWithAddress;
  stakers: SignerWithAddress[];
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
    const [admin, ...stakers] = signers.slice(0, 5);

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

    await magic.mint(admin.address, ether("10000"));
    await magic.mint(masterOfCoin.address, ether("20000"));

    const DAY_SEC = 86400;
    const start = Math.floor(Date.now() / 1000);
    const end = start + 140 * DAY_SEC;

    // 140 day program, 1000 MAGIC distributed per day
    await masterOfCoin.addStream(mine.address, ether("140000"), start, end, false);

    return {
      signers,
      admin,
      stakers,
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
      it("does not allow a user to stake if their specified amount is 0");
      it("does not allow a user to stake if their deposit is too small");
      it("allows a user to stake");
    });

    describe("withdraw", () => {
      it("does not allow a user to withdraw if they have not staked");
      it("does not allow a user to withdraw if there are not enough unlocked coins");
      it("efficiently unstakes locked coins to retain as much reward-earning deposit as possible");
      it("withdrawal distributes the correct amount of pro rata rewards");
      it("withdrawal distributes the correct amount of pro rata rewards (multiple stakers)");
    });

    describe("claim", () => {
      it("does not allow a user to claim if there are not enough unlocked coins");
      it("distributes the correct amount of pro rata rewards");
      it("distributes the correct amount of pro rata rewards (multiple stakers)");
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
