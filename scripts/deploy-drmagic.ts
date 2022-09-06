import { ethers } from "hardhat";

import { SECTION_SEPARATOR, SUBSECTION_SEPARATOR } from "./constants";

import type { DragonTributeUpgradeable } from "../src/types/DragonTributeUpgradeable";

const MINTER_ROLE = "0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6";
const WITHDRAWER_ROLE = "0x5d8e12c39142ff96d79d04d15d1ba1269e4fe57bb9d26f43523628b34ba108ec";
const ADMIN_ROLE = "0xa49807205ce4d355092ef5a8a18f56e8913cf4a201fbe287825b095693c21775";

export async function main(): Promise<void> {
    await deploy();
}

export async function deploy(): Promise<void> {
    console.log(SECTION_SEPARATOR);
    const signers = await ethers.getSigners();
    console.log("Deployer address: ", signers[0].address);
    console.log("Deployer balance: ", (await signers[0].getBalance()).toString());
    console.log(SECTION_SEPARATOR);

    const MAGIC = "0x539bde0d7dbd336b79148aa742883198bbf60342";
    const MULTISIG = "0x4deFaa0B91EA699F0Da90DEC276bbaa629015140";

    // Deploy drMAGIC token
    const tokenFactory = await ethers.getContractFactory("drMAGIC");
    const drmagic = await tokenFactory.attach("0xAca264F8D4e3CD6F5114e0aD10DB465b3924C5B7");
    const drmagic = await tokenFactory.deploy();
    await drmagic.deployed();

    console.log("drMAGIC deployed to", drmagic.address);

    const factory = await ethers.getContractFactory("DragonTributeUpgradeable");
    const tribute = <DragonTributeUpgradeable>await factory.deploy({
        gasLimit: 75_000_000,
    });

    await tribute.deployed();

    console.log("Tribute implementation deployed to:", tribute.address);

    // Deploy proxy, use existing proxy admin
    const PROXY_ADMIN = "0xED72e229Ef1Bdffa211200b2a5EAC3F08d6352F7";
    const proxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy");
    const proxy = await proxyFactory.deploy(tribute.address, PROXY_ADMIN, Buffer.from(""));
    await proxy.deployed();

    console.log("Proxy deployed to:", proxy.address);

    const proxTribute = <DragonTributeUpgradeable>await ethers.getContractAt("DragonTributeUpgradeable", proxy.address);

    // Initialize both impl and proxy
    await proxTribute.initialize(MAGIC, drmagic.address);

    console.log(SUBSECTION_SEPARATOR);
    console.log("Tribute contracts initialized.");

    // Give depositor mint perms on drMAGIC
    await drmagic.grantRole(MINTER_ROLE, proxTribute.address);

    // Set wallets as withdrawers
    const wallets = [MULTISIG];
    for (const w of wallets) await proxTribute.grantRole(WITHDRAWER_ROLE, w);

    console.log(SUBSECTION_SEPARATOR);
    console.log("Withdraw roles granted to:");
    console.log(wallets.join("\n"));

    // Transfer token admin to multisig
    await drmagic.grantRole(ADMIN_ROLE, MULTISIG);
    await drmagic.renounceRole(ADMIN_ROLE, signers[0].address);

    console.log(SUBSECTION_SEPARATOR);
    console.log("Granted drMAGIC admin role to:", MULTISIG);
    console.log(signers[0].address, "renounced admin role.");

    // Transfer tribute admin to multisig
    await proxTribute.grantRole(ADMIN_ROLE, MULTISIG);
    await proxTribute.renounceRole(ADMIN_ROLE, signers[0].address);

    console.log(SUBSECTION_SEPARATOR);
    console.log("Granted tribute admin role to:", MULTISIG);
    console.log(signers[0].address, "renounced admin role.");
}

// We recommend this pattern to be able to use async/await everywhere
// and properly handle errors.
if (require.main === module) {
    main()
        .then(() => process.exit(0))
        .catch((error: Error) => {
            console.error(error);
            process.exit(1);
        });
}
