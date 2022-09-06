import hre from "hardhat";
import { ethers } from "hardhat";
import { Artifact } from "hardhat/types";
import { Contract, Signer } from "ethers";

const { deployContract } = hre.waffle;

/**
 * Deploy a contract with the given artifact name
 * Will be deployed by the given deployer address with the given params
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function deploy<T extends Contract>(contractName: string, deployer: Signer, params: any[]): Promise<T> {
    const factory = await ethers.getContractFactory(contractName);
    const deployerFactory = await factory.connect(deployer);
    return <T>await deployerFactory.deploy(...params);
}

export async function deployUpgradeable<T extends Contract>(
    contractName: string,
    deployer: Signer,
    params: any[],
    initFn = "initialize",
): Promise<T> {
    const impl = await deploy(contractName, deployer, []);

    // Deploy proxy
    const proxyAdminFactory = await ethers.getContractFactory("ProxyAdmin");
    const proxyAdmin = await proxyAdminFactory.deploy();

    const proxyFactory = await ethers.getContractFactory("TransparentUpgradeableProxy");
    const proxy = await proxyFactory.deploy(impl.address, proxyAdmin.address, Buffer.from(""));
    const contract = <T>await ethers.getContractAt(contractName, proxy.address);

    await contract[initFn](...params);

    return contract;
}

export async function increaseTime(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
}

export async function setNextBlockTimestamp(epoch: number): Promise<void> {
    await ethers.provider.send("evm_setNextBlockTimestamp", [epoch]);
}
