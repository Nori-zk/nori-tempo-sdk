#!/usr/bin/env bash
# ERC-20 locking, pause sync and token fees end to end on a local fork of
# Ethereum mainnet, through this package's npm scripts:
#
#   1. node:fork                 a local mainnet fork on port 18645
#   2. deploy                    a proof request queue and NoriTokenBridge
#   3. test:fund-from-holder     100 real USDC to the dev account, from a holder
#   4. set-fee-recipient / set-fee-rate   the dev account, 1%
#   5. test:lock-erc20           25.5 USDC for sha256(dev account)
#   6. sync-pause                USDC (pausable) succeeds; WETH (no paused()) is refused
#   7. withdraw-token-fees       the 1% kept in USDC
#
# Exits non-zero at the first step whose output is not what it should be.
#
# Usage: npm run test:erc20-fork-flow -w ethereum
#   ETH_MAINNET_FORK_RPC_URL  chain to fork (default: a public mainnet RPC, see hardhat.config.ts)
#   ERC20_FORK_HOLDER         an account holding USDC on that chain (default: Binance's hot wallet)
#
# Needs: npm install && npm run build -w ethereum, curl, a free port 18645.
# On exit it stops the node and deletes the deploy output. It runs only
# when no .env.nori-eth-token-bridge exists, as deploy writes that file.

set -euo pipefail
cd "$(dirname "$0")/.."

PORT=18645
USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
WETH=0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2
HOLDER=${ERC20_FORK_HOLDER:-0x28C6c06298d514Db089934071355E5743bf21d60}
# Hardhat's public test account 0
DEV=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
DEV_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOY_OUTPUT=.env.nori-eth-token-bridge
LOG=$(mktemp "${TMPDIR:-/tmp}/erc20-fork-node.XXXXXX")

if [ -e "$DEPLOY_OUTPUT" ]; then
    echo "$DEPLOY_OUTPUT exists; move it aside first (deploy would overwrite it)"
    exit 1
fi
if lsof -i ":$PORT" >/dev/null 2>&1; then echo "Port $PORT is busy"; exit 1; fi

cleanup() {
    for pid in $(lsof -t -i ":$PORT" 2>/dev/null); do kill "$pid" 2>/dev/null || true; done
    rm -f "$DEPLOY_OUTPUT" "$LOG"
}
trap cleanup EXIT

# The fork's settings; set (even empty) wins over .env, so deploy uses its defaults
export ETH_NETWORK=localfork ETH_RPC_URL=http://127.0.0.1:$PORT ETH_PRIVATE_KEY=$DEV_KEY
export NORI_ETH_TOKEN_BRIDGE_TEST_MODE=true NORI_ETH_BRIDGE_OPERATOR_ADDRESS= \
    NORI_ETH_BRIDGE_FEE_RECIPIENT_ADDRESS= NORI_ETH_BRIDGE_LOCK_FEE_RATE= \
    NORI_ETH_BRIDGE_PROOF_REQUEST_QUEUE_FEE_WEI=0

# Runs an npm script and checks its output matches a pattern, printing the matching lines
step() {
    local name=$1 pattern=$2
    shift 2
    local out
    out=$(npm run -s "$@" 2>&1 | sed -E 's/\x1b\[[0-9;]*m//g') || true
    if ! grep -qE "$pattern" <<<"$out"; then
        echo "FAILED: $name"
        echo "$out" | tail -20
        exit 1
    fi
    grep -E "$pattern" <<<"$out" | sed -E 's/^.*\] //' | sed "s/^/  $name: /"
}

echo "Starting a mainnet fork on port $PORT"
npm run -s node:fork -- --port "$PORT" >"$LOG" 2>&1 &
for _ in $(seq 1 90); do
    curl -s -X POST -H 'content-type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' "$ETH_RPC_URL" | grep -q result && break
    sleep 1
done

step deploy "NoriTokenBridge deployed to" deploy
set -a
. "./$DEPLOY_OUTPUT"
set +a
step fund "now holds 100000000 " test:fund-from-holder -- "$USDC" "$HOLDER" 100
step fee-recipient "Confirmed in block" set-fee-recipient -- "$DEV"
step fee-rate "Confirmed in block" set-fee-rate -- 1000
CODE_CHALLENGE=0x$(node -e "process.stdout.write(require('crypto').createHash('sha256').update(Buffer.from('${DEV#0x}', 'hex')).digest('hex'))")
step lock "Locked so far for the code challenge \(bridge units\): 25245000" test:lock-erc20 -- "$USDC" "$CODE_CHALLENGE" 25.5
step sync-usdc "Synced .*paused false" sync-pause -- "$USDC"
step sync-weth "TokenNotPausable" sync-pause -- "$WETH"
step withdraw "Withdrawn in block" withdraw-token-fees -- "$USDC"

echo "All steps passed"
