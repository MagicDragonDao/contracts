import "@nomiclabs/hardhat-ethers";
import { ethers } from "hardhat";
import qs from "qs";
import fetch, { HeadersInit } from "node-fetch";
import fs from "fs";
import * as csv from "csv-writer";

import mineAbi from "../artifacts/treasure-staking/contracts/AtlasMine.sol/AtlasMine.json";
import { Contract, BigNumberish } from "ethers";
import { AtlasMineStakerUpgradeable } from "../src/types/AtlasMineStakerUpgradeable";
import { AtlasMine } from "../src/types/AtlasMine";
import { assert } from "console";

import { SECTION_SEPARATOR } from "./constants";

const { TENDERLY_USER, TENDERLY_PROJECT, TENDERLY_ACCESS_KEY } = process.env;

const TENDERLY_FORK_API = `https://api.tenderly.co/api/v1/account/${TENDERLY_USER}/project/${TENDERLY_PROJECT}/fork`;

// TODO: update this based on last "Harvest" event from AM
const STAKER_ADDR = "0xA094629baAE6aF0C43F17F434B975337cBDb3C42";
const MINE_ADDR = "0xA0A89db1C899c49F98E6326b764BAFcf167fC2CE";
const PROXY_ADMIN = "0xED72e229Ef1Bdffa211200b2a5EAC3F08d6352F7";
const MULTISIG = "0x4deFaa0B91EA699F0Da90DEC276bbaa629015140";

const START_BLOCK = 17787057;
const depositHwm = "19491849143700000000000000";

export async function main(): Promise<void> {
    await logSubmittedReimbursements();
}

export async function logSubmittedReimbursements(): Promise<void> {
    const submissions = fs.readFileSync("./form_answers.csv", "utf-8");
    const lines = submissions.split("\n");
    const addresses = lines
        .map(l => {
            const tokens = l.split(",");
            return tokens[tokens.length - 2];
        })
        .slice(2)
        .filter((v, i, a) => a.findIndex(t => t === v) === i);

    let totalAmount = ethers.BigNumber.from(0);
    const output: string[] = [];

    const rewards = fs.readFileSync("users.csv", "utf-8");
    const rewardLines = rewards.split("\n").slice(1);

    rewardLines.forEach(l => {
        const tokens = l.split(",");
        const [address, amount] = tokens;

        if (addresses.includes(address)) {
            console.log(`${address} ${amount}`);
            output.push(`,${address},${amount},,MAGIC`);
            totalAmount = totalAmount.add(ethers.utils.parseEther(amount));
        }
    });

    console.log();
    console.log("Total amount:", ethers.utils.formatEther(totalAmount));

    fs.writeFileSync("reimbursements.csv", output.join("\n"));
}

export async function determineWithdrawerRewards(totalRewards: BigNumberish): Promise<void> {
    const withdrawalRewards: Record<string, string>[] = [];
    const userRewards: Record<string, string> = {};

    const { number: startBlock, timestamp: startTimestamp } = await ethers.provider.getBlock(START_BLOCK);
    const { number: currentBlock, timestamp: currentTimestamp } = await ethers.provider.getBlock("latest");

    const stakerFactory = await ethers.getContractFactory("AtlasMineStakerUpgradeable");
    const staker = await stakerFactory.attach(STAKER_ADDR);

    const totalTimeElapsed = currentTimestamp - startTimestamp;
    const rewardsPerSecond = ethers.BigNumber.from(totalRewards).div(totalTimeElapsed);

    const allTxs = await getAllTxs();

    for (const tx of allTxs) {
        // If not a withdrawal tx, continue
        if (!tx.functionName.includes("withdraw")) {
            continue;
        }

        // If withdrawal tx, get receipt
        const receipt = await ethers.provider.getTransactionReceipt(tx.hash);
        const secondsSinceStart = Number(tx.timeStamp) - startTimestamp;

        // Figure out amount withdrawn from logs
        for (const log of receipt.logs) {
            if (log.address !== STAKER_ADDR) continue;

            const payload = staker.interface.parseLog(log);

            if (payload.name !== "UserWithdraw") continue;

            const [user, , stakeAmount] = payload.args;

            const reward = rewardsPerSecond.mul(secondsSinceStart).mul(stakeAmount).div(depositHwm);

            withdrawalRewards.push({
                timestamp: tx.timeStamp,
                tx: tx.hash,
                user: user,
                amountWithdrawn: stakeAmount,
                reward: reward.toString(),
            });

            if (!userRewards[user]) {
                userRewards[user] = reward.toString();
            } else {
                userRewards[user] = reward.add(userRewards[user]).toString();
            }
        }
    }

    const wCsvWriter = csv.createObjectCsvWriter({
        path: "./withdraws.csv",
        header: [
            { id: "timestamp", title: "timestamp" },
            { id: "tx", title: "tx" },
            { id: "user", title: "user" },
            { id: "amountWithdrawn", title: "amountWithdrawn" },
            { id: "reward", title: "reward" },
        ],
    });

    const uCsvWriter = csv.createArrayCsvWriter({
        path: "./users.csv",
        header: ["user", "reward"],
    });

    fs.writeFileSync("withdraw-rewards.json", JSON.stringify(withdrawalRewards, null, 4));
    fs.writeFileSync("user-rewards.json", JSON.stringify(userRewards, null, 4));

    const userEntries = Object.entries(userRewards).map(entry => [entry[0], ethers.utils.formatEther(entry[1])]);

    const withdrawlCsvData: any = withdrawalRewards.map(obj => {
        return {
            timestamp: new Date(Number(obj.timestamp) * 1000).toISOString(),
            tx: obj.tx,
            user: obj.user,
            amountWithdrawn: ethers.utils.formatEther(obj.amountWithdrawn),
            reward: ethers.utils.formatEther(obj.reward),
        };
    });

    // await wCsvWriter.writeRecords(withdrawlCsvData);
    // await uCsvWriter.writeRecords(userEntries);
}

export async function simulateHarvest(): Promise<BigNumberish> {
    const { number: currentBlock } = await ethers.provider.getBlock("latest");

    console.log(SECTION_SEPARATOR);

    let res = await fetch(TENDERLY_FORK_API, {
        method: "POST",
        body: JSON.stringify({
            network_id: 42161, // arb
            block_number: currentBlock,
        }),
        headers: <HeadersInit>{
            "X-Access-Key": TENDERLY_ACCESS_KEY,
        },
    });

    res = await res.json();

    const forkId = (<any>res).simulation_fork.id;
    const forkRPC = `https://rpc.tenderly.co/fork/${forkId}`;

    const provider = new ethers.providers.JsonRpcProvider(forkRPC);
    const signer = await provider.getSigner();
    const signerAddr = await signer.getAddress();

    await provider.send("tenderly_addBalance", [
        [signerAddr, MULTISIG],
        ethers.utils.hexValue(ethers.utils.parseEther("100")), // hex encoded wei amount
    ]);

    console.log("Created fork");
    console.log(SECTION_SEPARATOR);

    const stakerFactory = await ethers.getContractFactory("AtlasMineStakerUpgradeable", {
        provider,
        signer,
    });

    // const impl = await stakerFactory.deploy();
    // await impl.deployed();

    // const proxyAdminAbi = [
    //     "function upgrade(address proxy, address implementation)",
    //     "function getProxyImplementation(address proxy) view returns (address)",
    // ];

    // // Deploy new contract
    // const proxyAdmin = new ethers.Contract(PROXY_ADMIN, proxyAdminAbi, signer);
    // const upgradeTx = await proxyAdmin.populateTransaction.upgrade(STAKER_ADDR, impl.address);

    // const upgradeParams = {
    //     to: PROXY_ADMIN,
    //     from: MULTISIG,
    //     data: upgradeTx.data,
    //     gas: ethers.utils.hexValue(3000000),
    //     gasPrice: ethers.utils.hexValue(1),
    //     value: ethers.utils.hexValue(0),
    // };

    // await provider.send("eth_sendTransaction", [upgradeParams]);

    // Should be upgraded
    // const reportedImpl = await proxyAdmin.getProxyImplementation(STAKER_ADDR);
    // assert(impl.address === reportedImpl, "New implementation not updated");

    console.log("Deployed");
    console.log(SECTION_SEPARATOR);

    // Set infinite accrual window
    const staker = await stakerFactory.attach(STAKER_ADDR);
    const accrueTx = await staker.populateTransaction.setAccrualWindows([0, 24]);

    const accrueParams = {
        to: STAKER_ADDR,
        from: MULTISIG,
        data: accrueTx.data,
        gas: ethers.utils.hexValue(3000000),
        gasPrice: ethers.utils.hexValue(1),
        value: ethers.utils.hexValue(0),
    };

    await provider.send("eth_sendTransaction", [accrueParams]);

    console.log("Set windows");
    console.log(SECTION_SEPARATOR);

    // Accrue all rewards
    // Keep track of all harvested from MineHarvest events
    const mineFactory = await ethers.getContractFactory("AtlasMine", { provider, signer });
    const mine = <AtlasMine>await mineFactory.attach(MINE_ADDR);

    const depositIds = await mine.getAllUserDepositIds(STAKER_ADDR);
    const harvestTx = await staker.populateTransaction.accrue(depositIds);

    const harvestParams = {
        to: STAKER_ADDR,
        from: MULTISIG,
        data: harvestTx.data,
        gas: ethers.utils.hexValue(3000000000),
        gasPrice: ethers.utils.hexValue(1),
        value: ethers.utils.hexValue(0),
    };

    const txhash = await provider.send("eth_sendTransaction", [harvestParams]);
    const receipt = await provider.getTransactionReceipt(txhash);
    fs.writeFileSync("hreceipt.json", JSON.stringify(receipt, null, 4));

    console.log("Harvested");
    console.log(SECTION_SEPARATOR);

    const { logs } = receipt;
    let harvested = ethers.BigNumber.from(0);

    for (const log of logs) {
        if (log.address !== MINE_ADDR) continue;

        const payload = mine.interface.parseLog(log);

        if (payload.name !== "Harvest") continue;
        if (payload.args[0] !== STAKER_ADDR) continue;

        const amount = payload.args[2];

        harvested = harvested.add(amount);
    }

    // Figure out amount harvested
    console.log("Total harvested:");
    console.log(ethers.utils.formatEther(harvested));

    const forkUrl = `https://api.tenderly.co/api/v1/account/${TENDERLY_USER}/project/${TENDERLY_PROJECT}/fork/${forkId}`;
    await fetch(forkUrl, { method: "DELETE" });

    console.log("\nDeleted fork.");
    console.log(SECTION_SEPARATOR);

    return harvested;
}

export async function getDepositHwm(): Promise<void> {
    const stakerFactory = await ethers.getContractFactory("AtlasMineStakerUpgradeable");
    const staker = <AtlasMineStakerUpgradeable>await stakerFactory.attach(STAKER_ADDR);

    const txs = await getAllTxs();
    const blocksToCheck = await txs.map(tx => tx.blockNumber).filter((v, i, a) => a.indexOf(v) === i);

    let depositHwm = ethers.utils.parseEther("0");

    for (const block of blocksToCheck) {
        const deposits = await staker.totalStaked({ blockTag: Number(block) });

        if (deposits.gt(depositHwm)) {
            depositHwm = deposits;
        }
    }
}

export async function getAllTxs(): Promise<any[]> {
    let txs: any[] = [];
    let done = false;
    let lastBlock = START_BLOCK;

    while (!done) {
        // Find all transasctions on magic contract
        const query = qs.stringify({
            apikey: process.env.ARBISCAN_API_KEY,
            module: "account",
            action: "txlist",
            address: STAKER_ADDR,
            startblock: lastBlock,
        });

        const res = await fetch(`https://api.arbiscan.io/api?${query}`);
        const data = <any>await res.json();

        const { result: pageTxs } = data;

        txs.push(...pageTxs);

        if (pageTxs.length < 10000) {
            done = true;
        } else {
            lastBlock = pageTxs[pageTxs.length - 1].blockNumber;
        }
    }

    txs = txs.filter((v, i, a) => a.findIndex(t => t.hash === v.hash) === i);

    console.log("TOTAL TXS", txs.length);
    fs.writeFileSync("txlist.json", JSON.stringify(txs, null, 4));

    return txs;
}

export async function getLastHarvest(): Promise<void> {
    const blockRange = 50_000;

    const mine = new Contract(MINE_ADDR, mineAbi.abi, ethers.provider);
    const filter = mine.filters.Harvest(STAKER_ADDR);
    const { number: currentBlock } = await ethers.provider.getBlock("latest");

    let events: any[] = [];
    let done = false;
    let lastBlock = START_BLOCK;

    while (!done) {
        let endBlock = Math.min(lastBlock + blockRange, currentBlock);

        // Find all transasctions on magic contract
        const rangeEvents = await mine.queryFilter(filter, lastBlock, endBlock);

        events.push(...rangeEvents);

        if (endBlock == currentBlock) {
            done = true;
        } else {
            lastBlock += blockRange;
        }
    }

    events = events.filter((v, i, a) => a.findIndex(e => e.transactionHash === v.transactionHash) === i).reverse();

    // const events = await mine.queryFilter(filter, START_BLOCK);

    console.log("Events", events.length);
    fs.writeFileSync("eventlist.json", JSON.stringify(events, null, 4));
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
