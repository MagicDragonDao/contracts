/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ethers, waffle } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";

const { loadFixture } = waffle;

import { deploy, expectRoundedEqual, ether } from "../utils";
import type { TestERC20, BasicDragonStash, StreamingDragonStash } from "../../src/types";

interface TestContext {
    magic: TestERC20;
    admin: SignerWithAddress;
    puller: SignerWithAddress;
    other: SignerWithAddress;
    basicStash: BasicDragonStash;
    streamingStash: StreamingDragonStash;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

describe("DragonStash", () => {
    let ctx: TestContext;

    const amount = ether("1000");

    const fixture = async (): Promise<TestContext> => {
        const [admin, puller, other] = await ethers.getSigners();

        const magic = <TestERC20>await deploy("TestERC20", admin, []);
        await magic.mint(admin.address, amount);

        // deploy stash contracts
        const basicStash = <BasicDragonStash>await deploy("BasicDragonStash", admin, [magic.address, puller.address]);

        const streamingStash = <StreamingDragonStash>(
            await deploy("StreamingDragonStash", admin, [magic.address, puller.address])
        );

        return {
            magic,
            admin,
            puller,
            other,
            basicStash,
            streamingStash,
        };
    };

    describe("Deployment", () => {
        const stashTypes = ["BasicDragonStash", "StreamingDragonStash"];

        it("reverts if a zero address is passed for the token", async () => {
            const [user] = await ethers.getSigners();

            for (const name of stashTypes) {
                const factory = await ethers.getContractFactory(name);

                await expect(factory.deploy(ZERO_ADDRESS, user.address)).to.be.revertedWith("No token");
            }
        });

        it("reverts if a zero address is passed for the puller", async () => {
            const [user] = await ethers.getSigners();
            const magic = <TestERC20>await deploy("TestERC20", user, []);

            for (const name of stashTypes) {
                const factory = await ethers.getContractFactory(name);

                await expect(factory.deploy(magic.address, ZERO_ADDRESS)).to.be.revertedWith("No puller");
            }
        });
    });

    describe("Basic Stash", () => {
        let token: TestERC20;

        beforeEach(async () => {
            ctx = await loadFixture(fixture);

            const { basicStash, magic, admin } = ctx;
            await magic.mint(basicStash.address, amount);

            // Create another token for rescue
            token = <TestERC20>await deploy("TestERC20", admin, []);
            await token.mint(basicStash.address, amount);
        });

        it("reverts if an address besides the puller requests tokens", async () => {
            const { basicStash, other } = ctx;

            await expect(basicStash.connect(other).request()).to.be.revertedWith("Not puller");
        });

        it("sends its entire balance when tokens are requested", async () => {
            const { basicStash, puller, magic } = ctx;
            const balanceBefore = await magic.balanceOf(puller.address);

            await expect(basicStash.connect(puller).request())
                .to.emit(basicStash, "Send")
                .withArgs(puller.address, amount);

            const balanceAfter = await magic.balanceOf(puller.address);

            expect(balanceAfter.sub(balanceBefore)).to.eq(amount);
        });

        it("reverts if a non-owner attempts to set the puller", async () => {
            const { basicStash, other } = ctx;

            await expect(basicStash.connect(other).setPuller(other.address)).to.be.revertedWith("Ownable");
        });

        it("allows the contract owner to change the puller", async () => {
            const { basicStash, admin, puller, other } = ctx;

            await expect(basicStash.connect(admin).setPuller(other.address))
                .to.emit(basicStash, "SetPuller")
                .withArgs(other.address);

            await expect(basicStash.connect(puller).request()).to.be.revertedWith("Not puller");

            await expect(basicStash.connect(other).request())
                .to.emit(basicStash, "Send")
                .withArgs(other.address, amount);
        });

        it("reverts if a non-owner attempts to rescue tokens", async () => {
            const { basicStash, other } = ctx;

            await expect(basicStash.connect(other).rescue(token.address, other.address)).to.be.revertedWith("Ownable");
        });

        it("reverts if an owner attempts to rescue the stash token", async () => {
            const { basicStash, admin, magic } = ctx;

            await expect(basicStash.connect(admin).rescue(magic.address, admin.address)).to.be.revertedWith(
                "Cannot rescue stash token",
            );
        });

        it("allows an owner to rescue tokens", async () => {
            const { basicStash, admin, other } = ctx;

            const balanceBefore = await token.balanceOf(other.address);

            await expect(basicStash.connect(admin).rescue(token.address, other.address))
                .to.emit(basicStash, "Rescue")
                .withArgs(token.address, amount, other.address);

            const balanceAfter = await token.balanceOf(other.address);

            expect(balanceAfter.sub(balanceBefore)).to.eq(amount);
        });
    });

    describe("Streaming Stash", () => {
        const STREAM_DURATION = 100_000; // 100000 seconds

        beforeEach(async () => {
            ctx = await loadFixture(fixture);

            const { streamingStash, magic } = ctx;
            await magic.mint(streamingStash.address, amount);
        });

        it("does not send any tokens if a stream has not started", async () => {
            const { magic, streamingStash, puller } = ctx;
            // Contract owns coins, but will not distribute them
            expect(await magic.balanceOf(streamingStash.address)).to.eq(amount);
            expect(await magic.balanceOf(puller.address)).to.eq(0);

            await expect(streamingStash.connect(puller).request()).to.be.revertedWith("No stream");
        });

        it("reverts if an address besides the puller requests tokens", async () => {
            const { streamingStash, admin, other } = ctx;

            // Advance halfway through the stream
            await streamingStash.connect(admin).startStream(amount, STREAM_DURATION);
            await ethers.provider.send("evm_increaseTime", [STREAM_DURATION / 2]);

            await expect(streamingStash.connect(other).request()).to.be.revertedWith("Not puller");
        });

        it("sends tokens based on pro rata progress through the stream", async () => {
            const { magic, streamingStash, admin, puller } = ctx;

            expect(await magic.balanceOf(puller.address)).to.eq(0);

            // Advance halfway through the stream
            await streamingStash.connect(admin).startStream(amount, STREAM_DURATION);
            await ethers.provider.send("evm_increaseTime", [STREAM_DURATION / 2]);

            const tx = await streamingStash.connect(puller).request();
            const receipt = await tx.wait();

            expect(receipt?.events?.length).to.be.gt(0);
            const e = receipt.events?.find(e => e.event === "Send");

            expect(e).to.not.be.undefined;
            expect(e?.args?.[0]).to.eq(puller.address);
            expectRoundedEqual(e?.args?.[1], amount.div(2));

            expect(await magic.balanceOf(puller.address)).to.eq(amount.div(2));
        });

        it("sends all tokens if a stream has ended", async () => {
            const { magic, streamingStash, admin, puller } = ctx;

            expect(await magic.balanceOf(puller.address)).to.eq(0);

            // Advance halfway through the stream
            await streamingStash.connect(admin).startStream(amount, STREAM_DURATION);
            await ethers.provider.send("evm_increaseTime", [STREAM_DURATION / 2]);
            await streamingStash.connect(puller).request();

            const lastBlock = await ethers.provider.getBlock("latest");
            expect(await streamingStash.lastPull()).to.eq(lastBlock.timestamp);

            // Advance to the end of the stream - should get rest of the half
            await ethers.provider.send("evm_increaseTime", [STREAM_DURATION]);

            const tx = await streamingStash.connect(puller).request();
            const receipt = await tx.wait();

            expect(receipt?.events?.length).to.be.gt(0);
            const e = receipt.events?.find(e => e.event === "Send");

            expect(e).to.not.be.undefined;
            expect(e?.args?.[0]).to.eq(puller.address);
            expectRoundedEqual(e?.args?.[1], amount.div(2));

            expect(await magic.balanceOf(puller.address)).to.eq(amount);
            expect(await streamingStash.lastPull()).to.eq(await streamingStash.streamEnd());

            // Advance again, make sure no emissions
            await ethers.provider.send("evm_increaseTime", [STREAM_DURATION]);

            await expect(streamingStash.connect(puller).request()).to.not.emit(streamingStash, "Send");

            expect(await streamingStash.lastPull()).to.eq(await streamingStash.streamEnd());

            expect(await magic.balanceOf(puller.address)).to.eq(amount);
        });

        it("allows the puller to collect tokens across multiple stream periods", async () => {
            const { streamingStash, admin, magic, puller } = ctx;
            await magic.mint(streamingStash.address, amount);
            const total = amount.mul(2);

            await streamingStash.connect(admin).startStream(amount, STREAM_DURATION);

            // Move halfway through the stream and start a new stream
            // Amount should now be 1.5x (since half left over)
            await ethers.provider.send("evm_increaseTime", [STREAM_DURATION / 2]);
            await streamingStash.connect(admin).startStream(amount, STREAM_DURATION);

            // Move halfway again and claim tokens - should get 5/8 of total tokens,
            // 2/8 of total from the first half, and 3/8 of total from second half
            // (1/2 time at a total 6/8 tokens)
            await ethers.provider.send("evm_increaseTime", [STREAM_DURATION / 2]);

            await expect(streamingStash.connect(puller).request())
                .to.emit(streamingStash, "Send")
                .withArgs(puller.address, total.div(8).mul(5).toString());

            expect(await magic.balanceOf(puller.address)).to.eq(total.div(8).mul(5));

            // Advance to the end of the stream - should get rest of the half
            await ethers.provider.send("evm_increaseTime", [STREAM_DURATION]);

            await expect(streamingStash.connect(puller).request())
                .to.emit(streamingStash, "Send")
                .withArgs(puller.address, total.div(8).mul(3).toString());

            expect(await magic.balanceOf(puller.address)).to.eq(total);
            expect(await streamingStash.lastPull()).to.eq(await streamingStash.streamEnd());
        });

        it("does not allow a non-owner to start a new stream", async () => {
            const { streamingStash, other } = ctx;

            await expect(streamingStash.connect(other).startStream(amount, STREAM_DURATION)).to.be.revertedWith(
                "Ownable",
            );
        });

        it("does not allow a contract owner to start a stream with zero duration", async () => {
            const { streamingStash, admin } = ctx;

            await expect(streamingStash.connect(admin).startStream(amount, 0)).to.be.revertedWith("No duration");
        });

        it("allows a contract owner to start a new stream", async () => {
            const { streamingStash, admin } = ctx;

            await expect(streamingStash.connect(admin).startStream(amount, STREAM_DURATION))
                .to.emit(streamingStash, "StartStream")
                .withArgs(amount, STREAM_DURATION);

            const expectedEmissionRate = amount.mul(ether("1")).div(STREAM_DURATION);
            expect(await streamingStash.tokensPerSecond()).to.eq(expectedEmissionRate);

            const lastBlock = await ethers.provider.getBlock("latest");
            expect(await streamingStash.streamStart()).to.eq(lastBlock.timestamp);
            expect(await streamingStash.streamEnd()).to.eq(lastBlock.timestamp + STREAM_DURATION);
            expect(await streamingStash.lastPull()).to.eq(lastBlock.timestamp);
        });

        it("does not allow a new stream to start if the stash cannot fund the stream", async () => {
            const { streamingStash, admin } = ctx;

            // Try to start with funded amount * 2
            await expect(streamingStash.connect(admin).startStream(amount.mul(2), STREAM_DURATION)).to.be.revertedWith(
                "Not enough tokens",
            );
        });

        it("adds leftover tokens from old stream to new stream", async () => {
            const { streamingStash, admin, magic } = ctx;
            await magic.mint(streamingStash.address, amount);

            await expect(streamingStash.connect(admin).startStream(amount, STREAM_DURATION))
                .to.emit(streamingStash, "StartStream")
                .withArgs(amount, STREAM_DURATION);

            // Move halfway through the stream and start a new stream
            // Amount should now be 1.5x (since half left over)
            await ethers.provider.send("evm_increaseTime", [STREAM_DURATION / 2]);

            const tx = await streamingStash.connect(admin).startStream(amount, STREAM_DURATION);
            const receipt = await tx.wait();

            expect(receipt?.events?.length).to.be.gt(0);

            const startEvent = receipt.events?.find(e => e.event === "StartStream");
            expect(startEvent).to.not.be.undefined;
            expectRoundedEqual(startEvent?.args?.[0], amount.div(2).mul(3));
            expect(startEvent?.args?.[1]).to.eq(STREAM_DURATION);

            const expectedEmissionRate = amount.div(2).mul(3).mul(ether("1")).div(STREAM_DURATION);
            expect(await streamingStash.tokensPerSecond()).to.eq(expectedEmissionRate);

            const lastBlock = await ethers.provider.getBlock("latest");
            expect(await streamingStash.streamStart()).to.eq(lastBlock.timestamp);
            expect(await streamingStash.streamEnd()).to.eq(lastBlock.timestamp + STREAM_DURATION);
            expect(await streamingStash.lastPull()).to.eq(lastBlock.timestamp);
            expect(await streamingStash.previouslyAccrued()).to.eq(amount.div(2));
        });

        it("does not allow a non-owner to stop a stream", async () => {
            const { streamingStash, admin, other } = ctx;

            await streamingStash.connect(admin).startStream(amount, STREAM_DURATION);

            await expect(streamingStash.connect(other).stopStream()).to.be.revertedWith("Ownable");
        });

        it("does not allow a stream to be stopped if a stream has never started", async () => {
            const { streamingStash, admin } = ctx;

            await expect(streamingStash.connect(admin).stopStream()).to.be.revertedWith("Stream over");
        });

        it("does not allow a stream to be stopped if a stream is over", async () => {
            const { streamingStash, admin } = ctx;

            await streamingStash.connect(admin).startStream(amount, STREAM_DURATION);

            // Advance past the end of the stream
            await ethers.provider.send("evm_increaseTime", [STREAM_DURATION + 1000]);
            await ethers.provider.send("evm_mine", []);

            await expect(streamingStash.connect(admin).stopStream()).to.be.revertedWith("Stream over");
        });

        it("stops a stream and returns leftover tokens to the owner", async () => {
            const { streamingStash, admin, magic } = ctx;

            await streamingStash.connect(admin).startStream(amount, STREAM_DURATION);

            // Advance halfway through the stream
            await ethers.provider.send("evm_increaseTime", [STREAM_DURATION / 2]);

            const balanceBefore = await magic.balanceOf(admin.address);

            await expect(streamingStash.connect(admin).stopStream()).to.emit(streamingStash, "StopStream");

            const balanceAfter = await magic.balanceOf(admin.address);

            expect(balanceAfter.sub(balanceBefore)).to.eq(amount.div(2));
        });
    });
});
