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
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";

describe("DragonTribute", () => {
    let ctx: TestContext;
    const amount = ethers.utils.parseEther("1000");

    const fixture = async (): Promise<TestContext> => {
        const [admin, depositor, withdrawer] = await ethers.getSigners();

        const drmagic = <DrMAGIC>await deploy("drMAGIC", admin, []);
        const magic = <TestERC20>await deploy("TestERC20", admin, []);

        // deploy tribute contract
        const tribute = <DragonTribute>(
            await deployUpgradeable("DragonTributeUpgradeable", admin, [magic.address, drmagic.address])
        );

        // grant tribute contract minter access
        await drmagic.connect(admin).grantRole(MINTER_ROLE, tribute.address);

        return {
            magic,
            drmagic,
            tribute,
            admin,
            depositor,
            withdrawer,
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

    // describe("depositing");
    // describe("withdrawing");
    // describe("setMintRatio");
});
