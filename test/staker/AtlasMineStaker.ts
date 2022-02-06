/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ethers, waffle } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";

const { loadFixture } = waffle;

import { deploy } from "../utils";
import type { AtlasMineStaker } from "../../src/types/AtlasMineStaker";
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
    stakeSequence,
    withdrawSingle,
    rollSchedule,
    rollLock,
    rollTo,
    expectRoundedEqual,
    setup5050Scenario,
    setup7525Scenario,
    withdrawWithRoundedRewardCheck,
    claimWithRoundedRewardCheck,
    rollToPartialWindow,
    claimSingle,
} from "./helpers";

const ether = ethers.utils.parseEther;

describe("Atlas Mine Staking (Pepe Pool)", () => {
    const TOTAL_REWARDS = ether("172800");
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

        const metadataStore = <MockLegionMetadataStore>await deploy("MockLegionMetadataStore", admin, []);

        const mine = <AtlasMine>await deploy("AtlasMine", admin, []);
        await mine.init(magic.address, masterOfCoin.address);
        await mine.setTreasure(treasures.address);
        await mine.setLegion(legions.address);
        await mine.setLegionMetadataStore(metadataStore.address);
        await mine.setUtilizationOverride(ether("1"));

        const staker = <AtlasMineStaker>await deploy("AtlasMineStaker", admin, [
            magic.address,
            mine.address,
            0, // 0 == AtlasMine.Lock.twoWeeks
        ]);

        // Distribute coins and set up staking program
        await magic.mint(admin.address, ether("10000"));
        await magic.mint(masterOfCoin.address, ether("200000"));

        const DAY_SEC = 86400;
        // Put start time in the future - we will fast-forward
        const start = Math.floor(Date.now() / 1000) + 10_000_000;
        const end = start + 200 * DAY_SEC;

        // 0.01 MAGIC per second, 864 per day
        // 200 day staking period == 172800 total MAGIC rewards
        await masterOfCoin.addStream(mine.address, TOTAL_REWARDS, start, end, false);

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
            metadataStore,
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

                await expect(stakeSingle(staker, user, amount))
                    .to.emit(staker, "UserDeposit")
                    .withArgs(user.address, amount);

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
                await expect(withdrawSingle(staker, user1))
                    .to.emit(staker, "UserWithdraw")
                    .withArgs(user1.address, amount, 0);

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
                    users: [user1],
                    staker,
                    magic,
                } = ctx;

                const { stakes } = await setup5050Scenario(ctx);

                // Fast-forward in scenarios - 1.3mm seconds should pass,
                // so 13k MAGIC to pool. User 1 deposited half

                await withdrawWithRoundedRewardCheck(staker, user1, stakes[user1.address], ether("6500"));

                // User returned all funds + reward
                expectRoundedEqual(await magic.balanceOf(user1.address), ether("106500"));
            });

            it("withdrawal distributes the correct amount of pro rata rewards (multiple deposit times)", async () => {
                const {
                    users: [user1, user2],
                    staker,
                    magic,
                } = ctx;

                const { stakes } = await setup7525Scenario(ctx);

                await withdrawWithRoundedRewardCheck(staker, user1, stakes[user1.address], TOTAL_REWARDS.div(4).mul(3));

                await withdrawWithRoundedRewardCheck(staker, user2, stakes[user2.address], TOTAL_REWARDS.div(4));

                // User returned all funds + reward
                expectRoundedEqual(await magic.balanceOf(user1.address), ether("229600"));
                expectRoundedEqual(await magic.balanceOf(user2.address), ether("143200"));
            });
        });

        describe("claim", () => {
            it("does not allow a user to claim if there are not enough unlocked coins", () => {
                // TODO: Should be able to delete after redoing staking to act more like a router
            });

            it("distributes the correct amount of pro rata rewards", async () => {
                const {
                    users: [user],
                    staker,
                    magic,
                } = ctx;

                await setup5050Scenario(ctx);

                await claimWithRoundedRewardCheck(staker, user, ether("6500"));

                // User returned all funds + reward
                expectRoundedEqual(await magic.balanceOf(user.address), ether("86500"));
            });

            it("distributes the correct amount of pro rata rewards (multiple deposit times)", async () => {
                const {
                    users: [user1, user2],
                    staker,
                    magic,
                } = ctx;

                await setup7525Scenario(ctx);

                const totalRewards = TOTAL_REWARDS;

                await claimWithRoundedRewardCheck(staker, user1, totalRewards.div(4).mul(3));

                await claimWithRoundedRewardCheck(staker, user2, totalRewards.div(4));

                // Reward distribued to user
                expectRoundedEqual(await magic.balanceOf(user1.address), ether("209600"));
                expectRoundedEqual(await magic.balanceOf(user2.address), ether("123200"));
            });

            it("should not allow a user to claim twice", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await setup5050Scenario(ctx);

                await claimWithRoundedRewardCheck(staker, user, ether("6500"));

                // Claim again, get very small rewards - 1 second passed
                await claimWithRoundedRewardCheck(staker, user, ether("0.005"));
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

            await staker.connect(admin).setHoard(hoard.address);

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

        it("allows the hoard to stake a treasure", async () => {
            const { staker, treasures } = ctx;
            const tokenId = 103;

            await expect(staker.connect(hoard).stakeTreasure(tokenId, 20)).to.emit(staker, "StakeNFT").withArgs(
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
            const staker2 = <AtlasMineStaker>await deploy("AtlasMineStaker", admin, [
                magic.address,
                mine.address,
                0, // 0 == AtlasMine.Lock.twoWeeks
            ]);

            expect(await mine.boosts(staker2.address)).to.eq(0);

            const amount = ether("10");
            await magic.connect(user).approve(staker2.address, amount);

            await Promise.all([stakeSingle(staker, user, amount), stakeSingle(staker2, user, amount)]);

            // Stake in mine from both stakers
            const tx = await rollSchedule(staker);
            await tx.wait();
            await staker2.stakeScheduled();

            // Go to the end
            await rollTo(end);

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

        it("allows the hoard to unstake a treasure", async () => {
            // Max boost
            const { staker, mine } = ctx;
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
            await staker.connect(hoard).unstakeTreasure(treasureTokenId, 10);

            // total 1316 - 158 =  1158% boost
            expect(await mine.boosts(staker.address)).to.eq(ether("11.58"));
        });

        it("allows the hoard to unstake a legion", async () => {
            // Max boost
            const { staker, mine } = ctx;
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
            await staker.connect(hoard).unstakeLegion(0);

            // total 1316 - 600 =  716% boost
            expect(await mine.boosts(staker.address)).to.eq(ether("7.16"));
        });
    });

    describe("View Functions", () => {
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
            expect(await staker.userStake(user1.address)).to.eq(ether("1"));
            expect(await staker.userStake(user2.address)).to.eq(ether("55"));
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

            // Pending 0 since day hasn't rolled, so can't be deposited
            expect(await staker.totalPendingStake()).to.eq(0);

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
            await ethers.provider.send("evm_mine", []);

            // Should not be able to withdraw anything, staked and locked - but nonzero rewards
            expectRoundedEqual(await staker.totalWithdrawableMagic(), ether("10000"));

            // Roll to end of rewards period, stake unlocked
            await rollTo(end);
            await ethers.provider.send("evm_mine", []);

            // Should get all principal plus rewards, even if unclaimed
            expectRoundedEqual(await staker.totalWithdrawableMagic(), TOTAL_REWARDS.add(ether("10")));

            await staker.connect(admin).unstakeAllFromMine();

            // Should be the same after claim/unstake
            expectRoundedEqual(await staker.totalWithdrawableMagic(), TOTAL_REWARDS.add(ether("10")));

            // Have one user withdraw
            tx = await staker.connect(user2).withdraw();
            await tx.wait();

            // Should have 10 percent of rewards plus deposit withdrawable
            expectRoundedEqual(await staker.totalWithdrawableMagic(), TOTAL_REWARDS.div(10).add(ether("1")));
        });
    });

    describe("Owner Operations", () => {
        describe("Administration", () => {
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

            it("collects the correct fee when rewards are claimed", async () => {
                const {
                    users: [user],
                    admin,
                    staker,
                    magic,
                } = ctx;

                await staker.connect(admin).setFee(200);
                await setup5050Scenario(ctx);

                // Expected rewards
                const rewardAfterFee = ether("6500")
                    .div(10_000)
                    .mul(10_000 - 200);

                await claimWithRoundedRewardCheck(staker, user, rewardAfterFee);

                // User returned all funds + reward
                // Here, they should only get 98% of rewards
                expectRoundedEqual(await magic.balanceOf(user.address), ether("80000").add(rewardAfterFee));
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
                await setup5050Scenario(ctx);

                // Expected rewards
                const rewardAfterFee = ether("6500")
                    .div(10_000)
                    .mul(10_000 - 200);
                const fee = ether("6500").div(10_000).mul(200);

                await claimWithRoundedRewardCheck(staker, user, rewardAfterFee);

                // Make sure admin gets fee upon calling func
                // Also gets fees from other staker
                const preclaimBalance = await magic.balanceOf(admin.address);
                await staker.connect(admin).withdrawFees();
                const postclaimBalance = await magic.balanceOf(admin.address);
                expectRoundedEqual(postclaimBalance.sub(preclaimBalance), fee.mul(2));
            });

            it("does not allow a non-owner to change the hoard address", async () => {
                const {
                    users: [user],
                    staker,
                } = ctx;

                await expect(staker.connect(user).setHoard(user.address)).to.be.revertedWith(
                    "Ownable: caller is not the owner",
                );
            });

            it("allows the owner to change the hoard address", async () => {
                const { admin, staker, users } = ctx;

                await expect(staker.connect(admin).setHoard(users[3].address)).to.not.be.reverted;
            });
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
                await ethers.provider.send("evm_mine", []);

                // Contract should not hold any MAGIC - all staked or pending claim
                expectRoundedEqual(await magic.balanceOf(staker.address), 0);

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
                await ethers.provider.send("evm_mine", []);

                // Contract should not hold any MAGIC - all staked or pending claim
                expectRoundedEqual(await magic.balanceOf(staker.address), 0);

                await staker.connect(admin).unstakeAllFromMine();

                // Staker should now hold all total rewards plus all unstaked deposits (10 unites)
                expectRoundedEqual(await magic.balanceOf(staker.address), TOTAL_REWARDS.add(ether("10")));
            });
        });
    });

    describe("Emergency Flows", () => {
        it("does not allow a non-owner to pause the stake schedule");
        it("allows the owner to pause the stake schedule");
        it("does not allow a non-owner to unstake everything from the mine");
        it("does not allow an emergency unstake if new stakes are not paused");
        it("unstakes everything possible from mine");
        it("does not allow a user to emergency withdraw if new stakes are not paused");
        it("does not allow a user to emergency withdraw if not all stakes can be withdrawn");
        it("allows a user to withdraw after an emergency unstake");
        it("allows a user to emergency withdraw after unstake (no rewards)");
    });

    describe("Advanced Rewards Calculation", () => {
        /**
         * Different advanced scenarios:
         * different deposits at different times
         * user unstakes but then redeposits later
         * some prestaking, some in-flow staking
         * Claiming at different times
         *
         * For each scenario, precalculate and test all outputs
         */
        it("scenario 1");
        it("scenario 2");
        it("scenario 3");
        it("scenario 4");
    });
});
