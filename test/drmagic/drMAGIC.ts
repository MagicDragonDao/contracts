/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { ethers, waffle } from "hardhat";
import { SignerWithAddress } from "@nomiclabs/hardhat-ethers/signers";
import { expect } from "chai";

const { loadFixture } = waffle;

import { deploy } from "../utils";
import type { DrMAGIC } from "../../src/types/DrMAGIC";

interface TestContext {
    drmagic: DrMAGIC;
    admin: SignerWithAddress;
    minter: SignerWithAddress;
    burner: SignerWithAddress;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";

describe("drMAGIC Token", () => {
    let ctx: TestContext;
    const amount = ethers.utils.parseEther("1000");

    const fixture = async (): Promise<TestContext> => {
        const [admin, minter, burner] = await ethers.getSigners();

        const drmagic = <DrMAGIC>await deploy("drMAGIC", admin, []);

        return {
            drmagic,
            admin,
            minter,
            burner,
        };
    };

    beforeEach(async () => {
        ctx = await loadFixture(fixture);
    });

    describe("mint", () => {
        it("does not allow a non-minter to mint", async () => {
            const { drmagic, admin } = ctx;

            await expect(drmagic.connect(admin).mint(admin.address, amount)).to.be.revertedWith("AccessControl");
        });

        it("does not allow a non-admin to grant mint permissions", async () => {
            const { drmagic, minter } = ctx;

            await expect(drmagic.connect(minter).grantRole(MINTER_ROLE, minter.address)).to.be.revertedWith(
                "AccessControl",
            );
        });

        it("allows an admin to grant mint permissions", async () => {
            const { drmagic, admin, minter } = ctx;

            await expect(drmagic.connect(admin).grantRole(MINTER_ROLE, minter.address)).to.emit(drmagic, "RoleGranted");
        });

        it("allows a minter to mint tokens", async () => {
            const { drmagic, admin, minter } = ctx;

            await drmagic.connect(admin).grantRole(MINTER_ROLE, minter.address);

            await expect(drmagic.connect(minter).mint(minter.address, amount))
                .to.emit(drmagic, "Transfer")
                .withArgs(ZERO_ADDRESS, minter.address, amount);
        });
    });

    describe("burn", () => {
        beforeEach(async () => {
            const { drmagic, admin, minter } = ctx;

            await drmagic.connect(admin).grantRole(MINTER_ROLE, minter.address);
            await drmagic.connect(minter).mint(minter.address, amount);
        });

        it("does not allow a non-burner to burn");
        it("does not allow a non-admin to grant burn permissions");
        it("allows an admin to grant burn permissions");
        it("allows a burner to burn tokens");
    });

    describe("admin", () => {
        it("does not allow a non-admin to grant the admin role");
        it("allows an admin to grant the admin role");
    });
});
