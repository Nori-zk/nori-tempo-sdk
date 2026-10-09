# Nori Token Bridge - Ethereum Contracts (Nori Tempo Bridge)

## Installation

`npm install`

## Configuration

All scripts read from `.env`. The full set of env vars:

```bash
# Ethereum =================================================================
# Deployer/operator private key (bare hex, no 0x prefix)
ETH_PRIVATE_KEY=deadbeef...
# Execution JSON-RPC endpoint
ETH_RPC_URL=https://ethereum-sepolia.core.chainstack.com/<api-key>
# Network label: hardhat, sepolia, mainnet, hoodi
ETH_NETWORK=sepolia

# Bridge operator ===========================================================
# Safe address or EOA to serve as bridge operator; defaults to deployer if unset
NORI_ETH_BRIDGE_OPERATOR_ADDRESS=0x...

# Fee configuration =========================================================
# Treasury address for fee withdrawal. If provided, set as the initial feeRecipient
# at deployment; otherwise it can be configured later via `setFeeRecipient`.
NORI_ETH_BRIDGE_FEE_RECIPIENT_ADDRESS=0x...
# Lock fee rate, 1 unit = 0.001%, e.g. 500 = 0.5% (optional, set post-deploy)
NORI_ETH_BRIDGE_LOCK_FEE_RATE=500
# Flat per-deposit proof request queue fee in wei (optional, defaults to 0).
# Multiple of 10^12 wei, keep well below the 0.001 ETH minimum deposit.
NORI_ETH_BRIDGE_PROOF_REQUEST_QUEUE_FEE_WEI=200000000000000

# Deploy outputs (written by deploy task) ====================================
# Deployed contract addresses
NORI_ETH_TOKEN_BRIDGE_ADDRESS=0x...
NORI_ETH_PROOF_QUEUE_ADDRESS=0x...

# Testing ====================================================================
# Set to true to enable the test facilities: lockTokens, lockERC20, fundFromHolder
NORI_ETH_TOKEN_BRIDGE_TEST_MODE=true
# Chain the mainnetFork network forks (test:fork, node:fork); defaults to a
# public mainnet RPC
ETH_MAINNET_FORK_RPC_URL=https://ethereum-rpc.publicnode.com
# Block to fork at (optional; needs an archive RPC); defaults to the latest
ETH_MAINNET_FORK_BLOCK=
```

## Testing

`npm run test` runs `test/` on Hardhat's in-process network: 126 passing.

`npm run test:fork` runs `test-fork/`, the ERC-20 tests on real mainnet USDC (pausable, 6 decimals) and WETH (18 decimals, no `paused()`), on the `mainnetFork` network: a local fork of `ETH_MAINNET_FORK_RPC_URL`. They need network access, so they are not part of `npm run test`: 8 passing.

## Build

`npm run build`

## Deploy

Deploys two contracts in sequence: NoriProofRequestQueue and NoriTokenBridge.

Requires:

- `ETH_PRIVATE_KEY`
- `ETH_RPC_URL`
- `ETH_NETWORK`
- `NORI_ETH_BRIDGE_OPERATOR_ADDRESS` (optional, defaults to deployer)
- `NORI_ETH_BRIDGE_FEE_RECIPIENT_ADDRESS` (optional; if set, applied at construction)
- `NORI_ETH_BRIDGE_LOCK_FEE_RATE` (optional)
- `NORI_ETH_BRIDGE_PROOF_REQUEST_QUEUE_FEE_WEI` (optional, defaults to 0)

```bash
npm run deploy
```

You will see output something like:

```sh
Running on network "sepolia"
Using RPC URL: https://ethereum-sepolia.core.chainstack.com/<api-key>
One private key loaded for deployment.
Deploying with account: 0xC7e910807Dd2E3F49B34EfE7133cfb684520Da69
Deployer balance: 40.718863431964256704 ETH
Network: sepolia (chainId: 11155111)
Configuration:
  NORI_ETH_BRIDGE_OPERATOR_ADDRESS: (defaulting to deployer)
  NORI_ETH_BRIDGE_FEE_RECIPIENT_ADDRESS: (not set)
  NORI_ETH_BRIDGE_LOCK_FEE_RATE: (not set)
  NORI_ETH_BRIDGE_PROOF_REQUEST_QUEUE_FEE_WEI: (not set, defaulting to 0)
Deploying NoriProofRequestQueue...
NoriProofRequestQueue deployed to: 0x...
Gas used: 123456
Deploying NoriTokenBridge...
NoriTokenBridge deployed to: 0x142B9d3fE3Caa2CE9DaA607A262Dc8561C694006
Deployed in block: 10511301
Gas used: 296589
Wrote .env.nori-eth-token-bridge
Environment variables for future use:
NORI_ETH_TOKEN_BRIDGE_ADDRESS=0x142B9d3fE3Caa2CE9DaA607A262Dc8561C694006
NORI_ETH_PROOF_QUEUE_ADDRESS=0x...
NORI_ETH_BRIDGE_OPERATOR_ADDRESS=0xC7e910807Dd2E3F49B34EfE7133cfb684520Da69
```

A file `.env.nori-eth-token-bridge` will have been created with the deployed contract addresses. `NORI_ETH_TOKEN_BRIDGE_ADDRESS` and `NORI_ETH_PROOF_QUEUE_ADDRESS` are the `ethTokenBridgeAddressHex` and `ethProofQueueAddressHex` the Tempo bridge's deploy takes (`tempo/`, `npm run deploy`).

## Lock (for testing purposes)

Make sure your .env is set to deploy to the correct testing network. Copy `NORI_ETH_TOKEN_BRIDGE_ADDRESS` from `.env.nori-eth-token-bridge`. Also you must add `NORI_ETH_TOKEN_BRIDGE_TEST_MODE=true` to run this test facility.

Requires:

- `ETH_PRIVATE_KEY`
- `ETH_RPC_URL`
- `ETH_NETWORK`
- `NORI_ETH_TOKEN_BRIDGE_ADDRESS`
- `NORI_ETH_TOKEN_BRIDGE_TEST_MODE=true`

`npm run test:lock <codeChallengeHex> <amountInETH (min 0.001, max 0.005, defaults to 0.001)>`

The code challenge is `sha256` of the Tempo recipient's 20-byte address; the recipient claims the mint by calling `mint` from that address.

e.g. `npm run test:lock 0x1edc891c0ea28b6157e8460304e20a534f3b29a9dbb2d499a58fa2d1de6b3c4a 0.001`

One can (again for testing purposes) lock periodically in a loop, every 383 seconds (approximately once every consensus period):

`npm run test:lock-loop <codeChallengeHex>`

**Caution** this is just a test facility, don't lock real ETH using this process.

## Lock an ERC-20 (for testing purposes)

Approves the bridge for the amount and calls `lockERC20`, paying exactly the proof request queue fee in ETH. The bridge keeps the rate fee in the token and credits the rest, in bridge units (`10^(decimals - 6)` token units each), to `lockedERC20[token][codeChallenge]`; the recipient mints the token's TIP-20 mirror on Tempo with `mintERC20`. The amount must be a whole number of bridge units, and tokens with fewer than 6 decimals or a fee on transfer are refused.

Requires:

- `ETH_PRIVATE_KEY` (holding the token)
- `ETH_RPC_URL`
- `ETH_NETWORK`
- `NORI_ETH_TOKEN_BRIDGE_ADDRESS`
- `NORI_ETH_TOKEN_BRIDGE_TEST_MODE=true`

`npm run test:lock-erc20 <tokenAddress> <codeChallengeHex> <amountInWholeTokens>`

The code challenge is `sha256` of the Tempo recipient's 20-byte address, as for `test:lock`.

e.g. 25.5 USDC on a local mainnet fork, with a 1% lock fee rate:

```sh
npm run test:lock-erc20 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 0x96e6760225b23fdf7760696e50f3d53a79bc982b586e9bab53737a0d0a032c6b 25.5
```

```
[LockERC20] Locking 25.5 of 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48: fee 255000, net 25245000 (token units), queue fee 0.0 ETH
[LockERC20] Locked in block 26156440, tx 0x2907f85be072d0c7e932cb0ad8e75dd1e4c3c96f434fe3d44ef431abd8428f16
[LockERC20] Locked so far for the code challenge (bridge units): 25245000
```

## Sync an ERC-20's pause state

Copies the ERC-20's `paused()` into the bridge (`pauseState[token]`: 1 unpaused, 2 paused) and requests a proof of it, paying exactly the proof request queue fee in ETH. Once the batch covering it is committed on Tempo, `applyPause` pauses or unpauses the token's mirror. Anyone can run it; run it after every `Paused` or `Unpaused` event of a mirrored token. A token without `paused()` reverts with `TokenNotPausable`.

Requires:

- `ETH_PRIVATE_KEY`
- `ETH_RPC_URL`
- `ETH_NETWORK`
- `NORI_ETH_TOKEN_BRIDGE_ADDRESS`

`npm run sync-pause <tokenAddress>`

e.g. USDC, then WETH (no `paused()`), on a local mainnet fork:

```
[SyncPause] Synced 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48: paused false, block 26156441, tx 0x8c3a704d3709ccb7981d40ad85794b7a7553b067e1f54f9a296c34136239e585
ProviderError: VM Exception while processing transaction: reverted with custom error 'TokenNotPausable("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")'
```

## Withdraw token fees

Withdraws the rate fees kept in one ERC-20 to the fee recipient. Must be called by the fee recipient address.

Requires:

- `ETH_PRIVATE_KEY`
- `ETH_RPC_URL`
- `ETH_NETWORK`
- `NORI_ETH_TOKEN_BRIDGE_ADDRESS`

`npm run withdraw-token-fees <tokenAddress>`

e.g. the 1% kept from the 25.5 USDC lock above:

```
[WithdrawTokenFees] Fee recipient: 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
[WithdrawTokenFees] Accumulated fees in 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48: 255000 (token units)
[WithdrawTokenFees] Withdrawn in block 26156442, tx 0x6d5394257e41d00a4f09539e90e2bba295d0d0b6a70c3ccee90408fbf2080773
```

## ERC-20s on a local mainnet fork

`npm run node:fork -- --port 18645` starts a local node forked from Ethereum mainnet (`ETH_MAINNET_FORK_RPC_URL`, `ETH_MAINNET_FORK_BLOCK`), where real tokens such as USDC and WETH can be locked. Point the scripts at it with `ETH_NETWORK=localfork`, `ETH_RPC_URL=http://127.0.0.1:18645` and a dev key such as Hardhat's account 0 (`0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`), deploy with `npm run deploy`, and load `.env.nori-eth-token-bridge`.

The dev account holds no tokens on the fork. `test:fund-from-holder` transfers some from an account that holds them, impersonated through the node's cheatcodes; it needs `NORI_ETH_TOKEN_BRIDGE_TEST_MODE=true` and `ETH_RPC_URL` pointing at the fork:

`npm run test:fund-from-holder <tokenAddress> <holderAddress> <amountInWholeTokens>`

```
[FundFromHolder] Signer 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 now holds 100000000 of 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (token units)
```

`npm run test:erc20-fork-flow` runs all of this in one go (`scripts/erc20-fork-check.sh`): a fork on port 18645, deploy, 100 USDC from Binance's hot wallet (`ERC20_FORK_HOLDER` to choose another), a 1% fee rate, a 25.5 USDC lock, a pause sync of USDC and of WETH (refused), and the fee withdrawal. It stops at the first step whose output is wrong, then stops the node and deletes the deploy output; it refuses to start while a `.env.nori-eth-token-bridge` exists.

```
Starting a mainnet fork on port 18645
  deploy: NoriTokenBridge deployed to: 0x5C1e3B42d490c108cDca1c404a7A13F9879469a0
  fund: Signer 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 now holds 100000000 of 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 (token units)
  fee-recipient: Confirmed in block: 26156441
  fee-rate: Confirmed in block: 26156442
  lock: Locked so far for the code challenge (bridge units): 25245000
  sync-usdc: Synced 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48: paused false, block 26156445, tx 0x6383a3501a1cff899d2894cca14855e306fcfcddf509b24c2ed0ff7bb277225f
  sync-weth: ProviderError: VM Exception while processing transaction: reverted with custom error 'TokenNotPausable("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2")'
  withdraw: Withdrawn in block 26156446, tx 0x3bedfc30f42e2c16a3913ed0b35552e517cef5f2606be3a7ad9f85d8b6709441
All steps passed
```

## Get total deposited

Requires:

- `ETH_RPC_URL`
- `ETH_NETWORK`
- `NORI_ETH_TOKEN_BRIDGE_ADDRESS`

`npm run get-deposited <codeChallengeHex>`

e.g. `npm run get-deposited 0x1edc891c0ea28b6157e8460304e20a534f3b29a9dbb2d499a58fa2d1de6b3c4a`

## Fee info

Query the current fee configuration: lock fee rate, proof request queue fee, fee recipients, accumulated fees, and bridge operator.

Requires:

- `ETH_RPC_URL`
- `ETH_NETWORK`
- `NORI_ETH_TOKEN_BRIDGE_ADDRESS`

```bash
npm run get-fee-info
```

## Set fee rate

Set the lock fee rate. The rate is expressed in units of 0.001%, so 500 = 0.5%, max 10000 = 10%. Must be called by the bridge operator.

Requires:

- `ETH_PRIVATE_KEY`
- `ETH_RPC_URL`
- `ETH_NETWORK`
- `NORI_ETH_TOKEN_BRIDGE_ADDRESS`

```bash
npm run set-fee-rate 500
```

## Set fee recipient

Set the treasury address that receives accumulated fees via `withdrawFees()`. Must be called by the bridge operator.

Requires:

- `ETH_PRIVATE_KEY`
- `ETH_RPC_URL`
- `ETH_NETWORK`
- `NORI_ETH_TOKEN_BRIDGE_ADDRESS`

```bash
npm run set-fee-recipient 0x...
```

## Withdraw fees

Withdraw accumulated protocol fees to the fee recipient. Must be called by the fee recipient address.

Requires:

- `ETH_PRIVATE_KEY`
- `ETH_RPC_URL`
- `ETH_NETWORK`
- `NORI_ETH_TOKEN_BRIDGE_ADDRESS`

```bash
npm run withdraw-fees
```

## Set bridge operator

Rotate the bridge operator to a new address. Must be called by the current bridge operator.

Requires:

- `ETH_PRIVATE_KEY`
- `ETH_RPC_URL`
- `ETH_NETWORK`
- `NORI_ETH_TOKEN_BRIDGE_ADDRESS`

```bash
npm run set-bridge-operator 0x...
```

## Package details

This package exports `noriTokenBridgeJson` and `noriProofRequestQueueJson`, the Hardhat artifact JSON objects for the compiled contracts (ABI, bytecode, etc.), plus the generated ethers typings and factories from `types/ethers-contracts`.

It is provided as an ES module export, allowing you to import it using ES module syntax.
