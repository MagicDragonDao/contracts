/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ethers, waffle } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";

const { loadFixture } = waffle;

import { deploy, deployUpgradeable } from "../utils";
import type { DrMAGIC } from "../../src/types/DrMAGIC";
import type { DragonTributeUpgradeable as DragonTribute } from "../../src/types/DragonTributeUpgradeable";
import type { TestERC20 } from "../../src/types/TestERC20";

interface TestContext {
    magic: TestERC20;
    drmagic: DrMAGIC;
    tribute: DragonTribute;
    admin: SignerWithAddress;
    depositor: SignerWithAddress;
    withdrawer: SignerWithAddress;
    other: SignerWithAddress;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const WITHDRAWER_ROLE = "0x5d8e12c39142ff96d79d04d15d1ba1269e4fe57bb9d26f43523628b34ba108ec";

describe("DragonTribute", () => {
    let ctx: TestContext;
    const amount = ethers.utils.parseEther("1000");

    const fixture = async (): Promise<TestContext> => {
        const [admin, depositor, withdrawer, other] = await ethers.getSigners();

        const drmagic = <DrMAGIC>await deploy("drMAGIC", admin, []);
        const magic = <TestERC20>await deploy("TestERC20", admin, []);
        await magic.mint(depositor.address, amount);

        // deploy tribute contract
        const tribute = <DragonTribute>(
            await deployUpgradeable("DragonTributeUpgradeable", admin, [magic.address, drmagic.address])
        );

        await drmagic.connect(admin).grantRole(MINTER_ROLE, tribute.address);
        await magic.connect(depositor).approve(tribute.address, amount);

        return {
            magic,
            drmagic,
            tribute,
            admin,
            depositor,
            withdrawer,
            other,
        };
    };

    beforeEach(async () => {
        ctx = await loadFixture(fixture);
    });

    describe("initializing", () => {
        it("reverts if the MAGIC token address is initialized to 0", async () => {
            const { admin, drmagic } = ctx;

            const impl = await deploy("DragonTributeUpgradeable", admin, []);

            // Deploy proxy
            const proxyAdminFactory = await ethers.getContractFactory("ProxyAdmin");
            const proxyAdmin = await proxyAdminFactory.deploy();

            const proxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy");
            const proxy = await proxyFactory.deploy(impl.address, proxyAdmin.address, Buffer.from(""));
            const tribute = <DragonTribute>await ethers.getContractAt("DragonTributeUpgradeable", proxy.address);

            await expect(tribute.initialize(ZERO_ADDRESS, drmagic.address)).to.be.revertedWith(
                "Invalid magic token address",
            );
        });

        it("reverts if the drMAGIC token address is initialized to 0", async () => {
            const { admin, magic } = ctx;

            const impl = await deploy("DragonTributeUpgradeable", admin, []);

            // Deploy proxy
            const proxyAdminFactory = await ethers.getContractFactory("ProxyAdmin");
            const proxyAdmin = await proxyAdminFactory.deploy();

            const proxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy");
            const proxy = await proxyFactory.deploy(impl.address, proxyAdmin.address, Buffer.from(""));
            const tribute = <DragonTribute>await ethers.getContractAt("DragonTributeUpgradeable", proxy.address);

            await expect(tribute.initialize(magic.address, ZERO_ADDRESS)).to.be.revertedWith(
                "Invalid drMagic token address",
            );
        });

        it("reverts if already initialized", async () => {
            const { tribute, magic, drmagic } = ctx;

            // Try to initialize existing contract
            await expect(tribute.initialize(magic.address, drmagic.address)).to.be.revertedWith(
                "Initializable: contract is already initialized",
            );
        });
    });

    describe("depositing", () => {
        it("does not allow deposits if the mint ratio is 0", async () => {
            const { admin, tribute, depositor } = ctx;

            await tribute.connect(admin).setMintRatio(0);

            await expect(tribute.connect(depositor).deposit(amount)).to.be.revertedWith("New deposits paused");
        });

        it("does not allow a 0 deposit", async () => {
            const { tribute, depositor } = ctx;

            await expect(tribute.connect(depositor).deposit(0)).to.be.revertedWith("Deposit amount 0");
        });

        it("deposits MAGIC and receives drMAGIC", async () => {
            const { tribute, depositor, magic, drmagic } = ctx;

            await expect(tribute.connect(depositor).deposit(amount))
                .to.emit(tribute, "Deposit")
                .withArgs(depositor.address, amount, amount);

            expect(await magic.balanceOf(depositor.address)).to.eq(0);
            expect(await magic.balanceOf(tribute.address)).to.eq(amount);
            expect(await drmagic.balanceOf(depositor.address)).to.eq(amount);
        });

        it("deposits MAGIC and another user receives drMAGIC", async () => {
            const { tribute, depositor, magic, drmagic, other } = ctx;

            await expect(tribute.connect(depositor).depositFor(amount, other.address))
                .to.emit(tribute, "Deposit")
                .withArgs(other.address, amount, amount);

            expect(await magic.balanceOf(depositor.address)).to.eq(0);
            expect(await magic.balanceOf(tribute.address)).to.eq(amount);
            expect(await drmagic.balanceOf(other.address)).to.eq(amount);
        });
    });

    describe("withdrawing", async () => {
        beforeEach(async () => {
            const { tribute, admin, depositor, withdrawer } = ctx;

            // Make a deposit
            await tribute.connect(depositor).deposit(amount);

            // Add withdraw perms
            await expect(tribute.connect(admin).grantRole(WITHDRAWER_ROLE, withdrawer.address)).to.emit(
                tribute,
                "RoleGranted",
            );
        });

        it("does not allow a non-withdrawer to withdraw", async () => {
            const { tribute, depositor } = ctx;

            await expect(tribute.connect(depositor).withdrawMagic(amount, depositor.address)).to.be.revertedWith(
                "AccessControl",
            );
        });

        it("does not allow a non-admin to set a withdrawer", async () => {
            const { tribute, withdrawer, other } = ctx;

            await expect(tribute.connect(withdrawer).grantRole(WITHDRAWER_ROLE, other.address)).to.be.revertedWith(
                "AccessControl",
            );
        });

        it("does not allow 0 withdrawal", async () => {
            const { tribute, withdrawer } = ctx;

            await expect(tribute.connect(withdrawer).withdrawMagic(0, withdrawer.address)).to.be.revertedWith(
                "Withdraw amount 0",
            );
        });

        it("withdraws magic", async () => {
            const { magic, tribute, withdrawer } = ctx;

            const magicBalance = await magic.balanceOf(tribute.address);
            expect(magicBalance).to.eq(amount);

            await expect(tribute.connect(withdrawer).withdrawMagic(amount, withdrawer.address))
                .to.emit(tribute, "WithdrawMagic")
                .withArgs(withdrawer.address, withdrawer.address, amount);

            expect(await magic.balanceOf(withdrawer.address)).to.eq(amount);
            expect(await magic.balanceOf(tribute.address)).to.eq(0);
        });

        it("withdraws the max amount of magic", async () => {
            const { magic, tribute, withdrawer } = ctx;
            const MAX_UINT = ethers.BigNumber.from(2).pow(256).sub(1);

            const magicBalance = await magic.balanceOf(tribute.address);
            expect(magicBalance).to.eq(amount);

            await expect(tribute.connect(withdrawer).withdrawMagic(MAX_UINT, withdrawer.address))
                .to.emit(tribute, "WithdrawMagic")
                .withArgs(withdrawer.address, withdrawer.address, amount);

            expect(await magic.balanceOf(withdrawer.address)).to.eq(amount);
            expect(await magic.balanceOf(tribute.address)).to.eq(0);
        });

        it("withdraws magic to another address", async () => {
            const { magic, tribute, withdrawer, other } = ctx;
            const MAX_UINT = ethers.BigNumber.from(2).pow(256).sub(1);

            const magicBalance = await magic.balanceOf(tribute.address);
            expect(magicBalance).to.eq(amount);

            await expect(tribute.connect(withdrawer).withdrawMagic(MAX_UINT, other.address))
                .to.emit(tribute, "WithdrawMagic")
                .withArgs(withdrawer.address, other.address, amount);

            expect(await magic.balanceOf(withdrawer.address)).to.eq(0);
            expect(await magic.balanceOf(other.address)).to.eq(amount);
            expect(await magic.balanceOf(tribute.address)).to.eq(0);
        });
    });

    describe("setMintRatio", async () => {
        const n = 100;
        const newRatio = ethers.utils.parseEther(n.toString());

        it("does not allow a non-admin to set the mint ratio", async () => {
            const { tribute, depositor } = ctx;

            await expect(tribute.connect(depositor).setMintRatio(newRatio)).to.be.revertedWith("AccessControl");
        });

        it("sets the mint ratio", async () => {
            const { magic, drmagic, tribute, admin, depositor } = ctx;
            const half = amount.div(2);

            // Deposit, get 1-1
            await expect(tribute.connect(depositor).deposit(half))
                .to.emit(tribute, "Deposit")
                .withArgs(depositor.address, half, half);

            await expect(tribute.connect(admin).setMintRatio(newRatio))
                .to.emit(tribute, "SetMintRatio")
                .withArgs(newRatio);

            // Deposit, got 100-1
            await expect(tribute.connect(depositor).deposit(half))
                .to.emit(tribute, "Deposit")
                .withArgs(depositor.address, half, half.mul(n));

            expect(await magic.balanceOf(depositor.address)).to.eq(0);
            expect(await magic.balanceOf(tribute.address)).to.eq(amount);

            const expectedDrMagic = half.add(half.mul(newRatio).div(ethers.utils.parseEther("1")));

            expect(await drmagic.balanceOf(depositor.address)).to.eq(expectedDrMagic);
        });
    });
});
