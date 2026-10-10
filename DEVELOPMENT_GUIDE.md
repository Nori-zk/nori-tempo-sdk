# Local Development Setup

## Dependencies

Rust (for the proof submitter, the processor and the bridge head), Node.js (for the contracts package and the TypeScript SDK) and Foundry (for the local Tempo node and `cast`).

Rust installs through rustup: https://rustup.rs. Node.js installs from https://nodejs.org (version 20 or later).

Foundry installs through `foundryup`, as Tempo's docs describe (https://tempo.xyz/developers/docs/sdk/foundry):

```bash
curl -L https://foundry.paradigm.xyz | bash
```

*Output ends like this:*

```
foundryup-init: foundryup was installed successfully!
foundryup-init: 
foundryup-init: To get started, add foundryup to your PATH:
foundryup-init: 
foundryup-init:   export PATH="$PATH:/home/<user>/.foundry/bin"
foundryup-init: 
foundryup-init: Then run 'foundryup' to install Foundry.
```

Put Foundry's bin directory on PATH, then install Foundry itself:

```bash
echo 'export PATH="$PATH:$HOME/.foundry/bin"' >> ~/.bashrc
source ~/.bashrc
foundryup
```

*Output ends like this. The version will differ:*

```
foundryup: use - forge 1.8.5 (51a52c59cf 2026-10-05T17:18:54.332175693Z)
foundryup: use - cast 1.8.5 (51a52c59cf 2026-10-05T17:18:54.332175693Z)
foundryup: use - anvil 1.8.5 (51a52c59cf 2026-10-05T17:18:54.332175693Z)
foundryup: use - chisel 1.8.5 (51a52c59cf 2026-10-05T17:18:54.332175693Z)
foundryup: use - solar 0.2.0-dev (83214bb 2026-10-05T17:18:44.969371011Z)
foundryup: done!
```

Sanity-check that everything landed:

```bash
rustc --version && node --version && npm --version && anvil --version | head -1 && cast --version | head -1
```

*Output looks like this. Exact versions will differ:*

```
rustc 1.98.0 (88d9e12ae 2026-08-18)
v24.18.0
11.16.0
anvil Version: 1.8.5
cast Version: 1.8.5
```

## Local Tempo node

`anvil --network tempo` is the local node used for development and tests. It runs Tempo's protocol locally: the `TIP20Factory` precompile at `0x20Fc000000000000000000000000000000000000`, pathUSD at `0x20C0000000000000000000000000000000000000`, and fees paid in pathUSD. The contracts deploy and the tests run against it without touching Moderato or mainnet.

### Start

```bash
anvil --network tempo
```

*Output looks like this (the banner and the ten dev accounts' keys are trimmed). The dev accounts and keys are Foundry's well-known test mnemonic, the same every time:*

```
Available Accounts
==================

(0) 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 (10000.000000000000000000 ETH)
(1) 0x70997970C51812dc3A010C7d01b50e0d17dc79C8 (10000.000000000000000000 ETH)
...

Private Keys
==================

(0) 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
(1) 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
...

Wallet
==================
Mnemonic:          test test test test test test test test test test test junk
Derivation path:   m/44'/60'/0'/0/


Tempo Fee Payer
==================
0xa0Ee7A142d267C1f36714E4a8F75612F20a79720


Chain ID
==================

31337

Base Fee
==================

20000000000
```

It listens on `http://127.0.0.1:8545`. The ETH balances shown are not what pays fees on Tempo: each dev account also holds pathUSD, which does.

### Stop

The node runs in the foreground. Shut it down with Ctrl+C in the terminal where it runs.

### Fork Moderato

To run against Moderato's state locally (its deployed contracts and balances), fork it:

```bash
anvil --network tempo --fork-url https://rpc.moderato.tempo.xyz
```

*Its output adds the fork, and the chain id is Moderato's. The block number differs every time:*

```
Fork
==================
Endpoint:       https://rpc.moderato.tempo.xyz/
Block number:   38853850
...
Chain ID:       42431
```

## cast

`cast` talks to the node from the command line. The commands below run against the local node started above.

### Check the node

```bash
cast chain-id --rpc-url http://127.0.0.1:8545
cast block-number --rpc-url http://127.0.0.1:8545
```

*Output looks like this. The block number grows as transactions land:*

```
31337
105
```

### Check the fee token balance

Fees are paid in pathUSD. Dev account 0's pathUSD balance:

```bash
cast call 0x20C0000000000000000000000000000000000000 'balanceOf(address)(uint256)' 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 --rpc-url http://127.0.0.1:8545
```

*Output looks like this:*

```
18446744073709551615 [1.844e19]
```

### Create a TIP-20

The bridged token is a TIP-20 created through `TIP20Factory`, with pathUSD as its quote token and the creator as its admin. This is what the deploy does:

```bash
cast send 0x20Fc000000000000000000000000000000000000 \
  'createToken(string,string,string,address,address,bytes32)' \
  nETH nETH ETH 0x20C0000000000000000000000000000000000000 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
  0x0000000000000000000000000000000000000000000000000000000000000001 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  --rpc-url http://127.0.0.1:8545
```

`cast` first warns that `ETH` is not an ISO 4217 currency code: a TIP-20's currency is fixed at creation, and only `USD` tokens can pay fees. The bridged token is not a fee token, so answer `y`. *The rest of the output looks like this (trimmed to the status and gas):*

```
gasUsed              2560758
status               1 (success)
```

The token's address comes from the creator and the salt. Read it without sending first, with the same arguments through `cast call ... 'createToken(...)(address)' ... --from <creator>`.

### Grant ISSUER_ROLE and mint

A TIP-20's roles are the keccak256 of their names. The admin grants `ISSUER_ROLE`, which the bridge contract holds so it can mint:

```bash
cast send <token> 'grantRole(bytes32,address)' $(cast keccak ISSUER_ROLE) <account> \
  --private-key <admin key> --rpc-url http://127.0.0.1:8545
```

*Output includes:*

```
status               1 (success)
```

Only an `ISSUER_ROLE` holder can mint; anyone else's `mint` reverts with `Unauthorized`. A role check takes the account first: `hasRole(address,bytes32)`.

## Contracts (`tempo/`)

The Tempo contracts are a Hardhat package. Its SP1 verifier comes from Succinct's sp1-contracts, pinned in `tempo/foundry.lock` (tag `v6.1.1`) and cloned into the gitignored `tempo/lib/` by `npm run lib`, which `build` and `test` run first. `tempo/remappings.txt` maps `sp1-contracts/` into it.

### Build

```bash
npm run build -w tempo
```

*Output includes:*

```
Compiled 7 Solidity files with solc 0.8.28 (evm target: cancun)
```

### Test

The tests run against the local Tempo node, so start `anvil --network tempo` first, in another terminal. They import `@nori-zk/tempo-zk-utils`, so build it first (`npm run build -w tempo-zk-utils`). They deploy the real verifier, create the bridged token through `TIP20Factory`, deploy the bridge with the store hash and queue address decoded from the first example proof, and verify the example proofs in `tempo/test/test_examples/`:

```bash
npm run test -w tempo
```

*Output ends like this:*

```
  55 passing (17s)
```
