/// <reference types="@nomicfoundation/hardhat-ethers" />
/// <reference types="@nomicfoundation/hardhat-ethers-chai-matchers" />
// ERC-20 locking and pause sync against real tokens on a fork of Ethereum
// mainnet (ETH_MAINNET_FORK_RPC_URL, or a public RPC): USDC (6 decimals,
// pausable) and WETH (18 decimals, not pausable). USDC is minted and paused
// through its own master minter and pauser, impersonated.
import { expect } from "chai";
import hre from "hardhat";
import {
  NoriProofRequestQueue__factory,
  NoriTokenBridge__factory,
} from "../types/ethers-contracts/index.js";
import {
  DECIMALS,
  LOCKED_ERC20_SLOT_INDEX,
  PAUSE_KEY,
  PAUSE_STATE_PAUSED,
  PAUSE_STATE_SLOT_INDEX,
  PAUSE_STATE_UNPAUSED,
} from "../contracts/NoriTokenBridge.const.js";
import { PROOF_REQUEST_QUEUE_FEE_GRANULARITY_WEI } from "../contracts/NoriProofRequestQueue.const.js";

const { ethers } = await hre.network.getOrCreate("mainnetFork");

/** The mainnet tokens the tests lock. */
const MAINNET = {
  USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  WETH: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
} as const;

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];
const USDC_ABI = [
  ...ERC20_ABI,
  "function masterMinter() view returns (address)",
  "function configureMinter(address minter, uint256 minterAllowedAmount) returns (bool)",
  "function mint(address to, uint256 amount) returns (bool)",
  "function pauser() view returns (address)",
  "function pause()",
  "function paused() view returns (bool)",
];
const WETH_ABI = [...ERC20_ABI, "function deposit() payable"];

const abi = ethers.AbiCoder.defaultAbiCoder();
const usdc = new ethers.Contract(MAINNET.USDC, USDC_ABI, ethers.provider);
const weth = new ethers.Contract(MAINNET.WETH, WETH_ABI, ethers.provider);

/** One bridge unit of a token with `decimals`, in its own units. */
const tokenUnit = (decimals: bigint) => 10n ** (decimals - BigInt(DECIMALS));

/** A token address as a collection key: left-padded to 32 bytes. */
const tokenKey = (token: string) => ethers.zeroPadValue(token, 32);

/** A signer for `address`, impersonated and given ETH for gas. */
async function impersonate(address: string) {
  await ethers.provider.send("hardhat_setBalance", [address, ethers.toBeHex(ethers.parseEther("10"))]);
  return ethers.getImpersonatedSigner(address);
}

/** Mints `amount` USDC to `account` through USDC's own master minter. */
async function mintUsdc(account: { address: string }, amount: bigint) {
  const masterMinter = await impersonate(await usdc.masterMinter());
  await (await (usdc.connect(masterMinter) as typeof usdc).configureMinter(account.address, amount)).wait();
  const minter = await impersonate(account.address);
  await (await (usdc.connect(minter) as typeof usdc).mint(account.address, amount)).wait();
}

describe("NoriTokenBridge ERC-20 locking on a mainnet fork", () => {
  async function deployFixture(proofRequestQueueFee = 0n) {
    const [operator, user, treasury] = await ethers.getSigners();
    const proofQueue = await new NoriProofRequestQueue__factory(operator).deploy(
      operator.address,
      treasury.address,
      proofRequestQueueFee
    );
    const bridge = await new NoriTokenBridge__factory(operator).deploy(
      operator.address,
      await proofQueue.getAddress(),
      treasury.address
    );
    const codeChallenge = BigInt(ethers.sha256(user.address));
    return { bridge, proofQueue, operator, user, treasury, codeChallenge };
  }

  it("keeps PAUSE_KEY and the pause states in step with the contract", async () => {
    const { bridge } = await deployFixture();
    expect(await bridge.PAUSE_KEY()).to.equal(PAUSE_KEY);
    expect(await bridge.PAUSE_STATE_UNPAUSED()).to.equal(PAUSE_STATE_UNPAUSED);
    expect(await bridge.PAUSE_STATE_PAUSED()).to.equal(PAUSE_STATE_PAUSED);
  });

  it("locks USDC 1:1 in bridge units and requests a proof of its slot", async () => {
    const { bridge, proofQueue, user, codeChallenge } = await deployFixture();
    const amount = 1_000n * 10n ** (await usdc.decimals());
    await mintUsdc(user, amount);
    await (await (usdc.connect(user) as typeof usdc).approve(await bridge.getAddress(), amount)).wait();

    await expect(bridge.connect(user).lockERC20(MAINNET.USDC, amount, codeChallenge))
      .to.emit(bridge, "ERC20Locked")
      .withArgs(user.address, MAINNET.USDC, codeChallenge, amount, 0n);
    expect(await usdc.balanceOf(await bridge.getAddress())).to.equal(amount);
    expect(await bridge.lockedERC20(MAINNET.USDC, codeChallenge)).to.equal(amount);
    expect(await bridge.totalLockedERC20BU(MAINNET.USDC)).to.equal(amount);

    const request = await proofQueue.requests(0n);
    expect(request.target).to.equal(await bridge.getAddress());
    expect(request.collectionKeysCount).to.equal(2);
    expect(request.collectionKeys[0]).to.equal(ethers.toBeHex(codeChallenge, 32));
    expect(request.collectionKeys[1]).to.equal(tokenKey(MAINNET.USDC));
    const slotKey = ethers.keccak256(
      abi.encode(
        ["uint256", "bytes32"],
        [codeChallenge, ethers.keccak256(abi.encode(["address", "uint256"], [MAINNET.USDC, LOCKED_ERC20_SLOT_INDEX]))]
      )
    );
    expect(request.slotKey).to.equal(slotKey);
    expect(BigInt(await ethers.provider.getStorage(await bridge.getAddress(), slotKey))).to.equal(amount);
  });

  it("scales an 18-decimal token (WETH) to bridge units", async () => {
    const { bridge, user, codeChallenge } = await deployFixture();
    const unit = tokenUnit(await weth.decimals());
    const amount = ethers.parseEther("1.5");
    await (await (weth.connect(user) as typeof weth).deposit({ value: amount + 1n })).wait();
    await (await (weth.connect(user) as typeof weth).approve(await bridge.getAddress(), amount + 1n)).wait();

    await (await bridge.connect(user).lockERC20(MAINNET.WETH, amount, codeChallenge)).wait();
    expect(await bridge.lockedERC20(MAINNET.WETH, codeChallenge)).to.equal(amount / unit);

    await expect(bridge.connect(user).lockERC20(MAINNET.WETH, 1n, codeChallenge))
      .to.be.revertedWithCustomError(bridge, "InvalidTokenUnitMultiple")
      .withArgs(1n, unit);
  });

  it("keeps the rate fee in the token and pays it out to the fee recipient", async () => {
    const { bridge, operator, user, treasury, codeChallenge } = await deployFixture();
    await (await bridge.connect(operator).setLockFeeRate(1_000)).wait();
    const amount = 1_000n * 10n ** (await usdc.decimals());
    await mintUsdc(user, amount);
    await (await (usdc.connect(user) as typeof usdc).approve(await bridge.getAddress(), amount)).wait();

    const [queueFeeWei, fee, net] = await bridge.previewLockERC20(MAINNET.USDC, amount);
    expect(queueFeeWei).to.equal(0n);
    expect(fee + net).to.equal(amount);
    await (await bridge.connect(user).lockERC20(MAINNET.USDC, amount, codeChallenge)).wait();
    expect(await bridge.lockedERC20(MAINNET.USDC, codeChallenge)).to.equal(net);
    expect(await bridge.accumulatedTokenFees(MAINNET.USDC)).to.equal(fee);

    await expect(bridge.connect(treasury).withdrawTokenFees(MAINNET.USDC))
      .to.emit(bridge, "TokenFeesWithdrawn")
      .withArgs(treasury.address, MAINNET.USDC, fee);
    expect(await usdc.balanceOf(treasury.address)).to.equal(fee);
    expect(await bridge.accumulatedTokenFees(MAINNET.USDC)).to.equal(0n);
  });

  it("pays the queue fee in ETH, exactly", async () => {
    const queueFee = 200n * PROOF_REQUEST_QUEUE_FEE_GRANULARITY_WEI;
    const { bridge, proofQueue, user, codeChallenge } = await deployFixture(queueFee);
    const amount = 10n ** (await usdc.decimals());
    await mintUsdc(user, amount);
    await (await (usdc.connect(user) as typeof usdc).approve(await bridge.getAddress(), amount)).wait();

    await expect(bridge.connect(user).lockERC20(MAINNET.USDC, amount, codeChallenge))
      .to.be.revertedWithCustomError(bridge, "QueueFeeMismatch")
      .withArgs(0n, queueFee);
    await (await bridge.connect(user).lockERC20(MAINNET.USDC, amount, codeChallenge, { value: queueFee })).wait();
    expect(await ethers.provider.getBalance(await proofQueue.getAddress())).to.equal(queueFee);
  });

  it("rejects the pause key as a codeChallenge", async () => {
    const { bridge, user } = await deployFixture();
    await expect(
      bridge.connect(user).lockERC20(MAINNET.USDC, 1n, BigInt(PAUSE_KEY))
    ).to.be.revertedWithCustomError(bridge, "ReservedCodeChallenge");
  });

  it("syncs USDC's pause state into its slot and requests a proof of it", async () => {
    const { bridge, proofQueue, user } = await deployFixture();
    const slotKey = ethers.keccak256(abi.encode(["address", "uint256"], [MAINNET.USDC, PAUSE_STATE_SLOT_INDEX]));
    const pauseStateWord = async () => BigInt(await ethers.provider.getStorage(await bridge.getAddress(), slotKey));

    await expect(bridge.connect(user).syncPause(MAINNET.USDC)).to.emit(bridge, "PauseSynced").withArgs(MAINNET.USDC, false);
    expect(await pauseStateWord()).to.equal(PAUSE_STATE_UNPAUSED);
    const request = await proofQueue.requests(0n);
    expect(request.slotKey).to.equal(slotKey);
    expect(request.collectionKeysCount).to.equal(2);
    expect(request.collectionKeys[0]).to.equal(PAUSE_KEY);
    expect(request.collectionKeys[1]).to.equal(tokenKey(MAINNET.USDC));

    const pauser = await impersonate(await usdc.pauser());
    await (await (usdc.connect(pauser) as typeof usdc).pause()).wait();
    await expect(bridge.connect(user).syncPause(MAINNET.USDC)).to.emit(bridge, "PauseSynced").withArgs(MAINNET.USDC, true);
    expect(await pauseStateWord()).to.equal(PAUSE_STATE_PAUSED);
    expect(await bridge.pauseState(MAINNET.USDC)).to.equal(PAUSE_STATE_PAUSED);
  });

  it("rejects syncing a token with no paused()", async () => {
    const { bridge, user } = await deployFixture();
    await expect(bridge.connect(user).syncPause(MAINNET.WETH))
      .to.be.revertedWithCustomError(bridge, "TokenNotPausable")
      .withArgs(MAINNET.WETH);
  });
});
