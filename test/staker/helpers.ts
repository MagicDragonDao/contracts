import { BigNumberish, ContractTransaction } from "ethers";

import { setNextBlockTimestamp } from "../utils";

import type { SignerWithAddress } from "@nomiclabs/hardhat-ethers/dist/src/signer-with-address";
import type { AtlasMineStaker } from "../../src/types/AtlasMineStaker";

export type StakeParams = [SignerWithAddress, BigNumberish];

export const stakeSingle = async (
  staker: AtlasMineStaker,
  user: SignerWithAddress,
  amount: BigNumberish,
): Promise<ContractTransaction> => {
  return staker.connect(user).deposit(amount);
};

export const stakeMultiple = async (staker: AtlasMineStaker, stakes: StakeParams[]): Promise<ContractTransaction[]> => {
  const promises = stakes.map(s => stakeSingle(staker, ...s));
  return Promise.all(promises);
};

export const stakeSequence = async (staker: AtlasMineStaker, stakes: StakeParams[]): Promise<ContractTransaction> => {
  // Only returns final transaction
  let tx: ContractTransaction;
  for (const s of stakes) {
    tx = await stakeSingle(staker, ...s);
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return tx!;
};

export const withdrawSingle = async (
  staker: AtlasMineStaker,
  user: SignerWithAddress,
): Promise<ContractTransaction> => {
  return staker.connect(user).withdraw();
};

export const rollSchedule = async (
  staker: AtlasMineStaker,
  start = Math.floor(Date.now() / 1000),
): Promise<ContractTransaction> => {
  const ONE_DAY_SEC = 86400;
  const nextTimestamp = start + ONE_DAY_SEC;
  await setNextBlockTimestamp(nextTimestamp);

  return staker.stakeScheduled();
};

// TODO: Assumes 2-week lock. Make flexible if we test differnet locks
export const rollLock = async (start = Math.floor(Date.now() / 1000)): Promise<void> => {
  const ONE_DAY_SEC = 86400;
  const nextTimestamp = start + ONE_DAY_SEC * 15;
  await setNextBlockTimestamp(nextTimestamp);
};

export const rollToPartialWindow = async (start: number, end: number, ratio: number): Promise<void> => {
  const diff = (end - start) * ratio;
  await setNextBlockTimestamp(start + diff);
};

export const rollTo = async (time: number): Promise<void> => {
  await setNextBlockTimestamp(time);
};
