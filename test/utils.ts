import hre from "hardhat";
import chai, { expect } from "chai";
import { ethers } from "hardhat";
import { solidity } from "ethereum-waffle";
import { Contract, Signer, BigNumberish } from "ethers";

chai.use(solidity);

export const ether = ethers.utils.parseEther;

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const shuffle = function shuffle<T>(array: T[]): T[] {
    let currentIndex = array.length,
        randomIndex;

    // While there remain elements to shuffle...
    while (currentIndex != 0) {
        // Pick a remaining element...
        randomIndex = Math.floor(Math.random() * currentIndex);
        currentIndex--;

        // And swap it with the current element.
        [array[currentIndex], array[randomIndex]] = [array[randomIndex], array[currentIndex]];
    }

    return array;
};

/////////////////////////////////////////////////////////////////////////////////
///                                MATCHERS                                   ///
/////////////////////////////////////////////////////////////////////////////////

export const expectRoundedEqual = (num: BigNumberish, target: BigNumberish, pctWithin = 5): void => {
    num = ethers.BigNumber.from(num);
    target = ethers.BigNumber.from(target);

    // Tolerable precision is 0.1%. Precision is lost in the magic mine in both
    // calculating NFT reward boosts, timing per second, and needing to go through
    // accrual windows
    const precision = 100;
    const denom = ether("1").div(precision);

    if (target.eq(0)) {
        expect(num).to.be.lte(ether("1"));
    } else if (num.eq(0)) {
        expect(target).to.be.lte(ether("1"));
    } else {
        // Expect it to be less than 2% diff
        const lowerBound = target.div(denom).mul(denom.div(100).mul(100 - pctWithin));
        const upperBound = target.div(denom).mul(denom.div(100).mul(100 + pctWithin));

        expect(num).to.be.gte(lowerBound);
        expect(num).to.be.lte(upperBound);
    }
};
