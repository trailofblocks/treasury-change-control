# Treasury Change Control

A review desk for ERC-20 transfers from Safe v1.4.1. Draft or import a proposal, inspect its decoded transaction, apply treasury policy, and approve the exact Safe hash. After the Safe owners execute that transaction, the reviewer can attach a verified on-chain receipt.

[Review console screenshot](docs/desk-executed.png) · [Local Safe execution proof](docs/local-proof.json) · [Sepolia hash comparison](docs/sepolia-hash-check.json)

## Run the demo

Requires Node.js 24+ and [Foundry Anvil](https://getfoundry.sh/anvil/overview). Set `ANVIL_PATH` if Anvil is outside your PATH.

```sh
npm ci
npm run demo
```

Open [the local desk](http://127.0.0.1:8897/). It starts an isolated local chain, deploys a real two-owner Safe and a test ERC-20 token, and seeds an open, blocked, and executed proposal. Pick **November settlement**, switch to **Reviewer**, and approve it. Switch to **Proposer**, revise the amount, and see the prior approval disappear from the new revision. The original decision remains in **Audit trail**. The demo uses public fixture accounts and an in-memory database.

## Connect an owned Sepolia Safe

1. Copy [the example policy](examples/sepolia-policy.example.json) to a local JSON file. Fill in your deployed Safe v1.4.1 address, HTTPS Sepolia RPC, registered test token, its decimals and per-transfer limit, and its allowed recipients. The example addresses are placeholders.
2. Set `TREASURY_CONFIG` to that file and provide separate random role tokens in `TREASURY_PROPOSER_TOKEN` and `TREASURY_REVIEWER_TOKEN`. Each token accepts 24–256 URL-safe characters. Set `TREASURY_DB` to a persistent path or use the default `.local/treasury.sqlite`. Run `npm start`.
3. Draft a transfer with the current Safe nonce, or select **Import Safe JSON** and paste the complete Safe transaction from the proposal. A reviewer approves and downloads the signing packet. Its transaction fields and hash can be compared to the proposal that the Safe owners sign through their normal Safe workflow. Compare the complete hash before signing and use a fresh export after any change.
4. After the owners execute the exact proposal directly through the Safe, take the on-chain transaction hash and select **Verify execution** in the desk. Once the configured confirmation depth is reached, the desk records the Safe success log, ERC-20 transfer log, canonical block, and explorer link.

The supported transaction shape is a direct `transfer(address,uint256)` call with zero ETH and zero Safe gas reimbursement fields. Imports use `safe`, `chainId`, `to`, `value`, `data`, `operation`, `safeTxGas`, `baseGas`, `gasPrice`, `gasToken`, `refundReceiver`, and `nonce`. All uint256 values are decimal strings. `safeTxHash` is optional and is checked when supplied. The **Transaction** tab contains the exact importable shape. The signing packet wraps those fields in `tx` and carries the policy fingerprint and review metadata. [Safe signing and execution workflow](https://docs.safe.global/sdk/protocol-kit/guides/execute-transactions)

## How approval is enforced

- **Transaction identity.** The EIP-712 hash covers the complete Safe transaction, Safe address, and chain ID. Approval and export compare that hash with the contract’s calculation and check the current nonce at a single block height. [Safe contract hash API](https://docs.safe.global/reference-smart-account/transactions/getTransactionHash)
- **Policy.** The desk checks canonical ERC-20 calldata, the token registry, allowed recipients, and the per-transfer limit. A changed transaction revision, policy, or consumed nonce prevents reuse of a previous export approval.
- **Durability.** SQLite stores the revision, review decision, and audit entry in transactions. Revision checks run again after asynchronous RPC reads, which prevents an in-flight approval from attaching to a concurrent edit.
- **Execution evidence.** A direct Safe execution must match the approved calldata and EIP-712 hash. The receipt must contain the matching Safe success event and exactly one matching transfer from the configured token. The desk verifies confirmation depth and canonical block hash when attaching the receipt.

The desk’s approval is an off-chain team decision. Authorization to move funds remains with the Safe owners and its on-chain signing threshold. Previously downloaded packets retain their original bytes. Configure known Safe and token contracts and use a trusted RPC. The workspace supports one credential per role and records role identity. It accepts local Anvil and Sepolia.

## Container deployment

The image runs the connected desk as a non-root user. Supply the policy as a read-only file, the role tokens through your secret environment, and a persistent volume for SQLite. Bind the demo port to loopback or expose the desk through a managed HTTPS reverse proxy with restricted access. A typical local container run uses:

```sh
docker build -t treasury-change-control .
docker run --rm -p 127.0.0.1:8897:8897 \
  --env-file .env -e TREASURY_CONFIG=/config/policy.json \
  -v "${PWD}/policy.json:/config/policy.json:ro" \
  -v treasury-data:/data treasury-change-control
```

## Verification

```sh
npm test
npm run proof
npm exec -- playwright install chromium
npm run test:browser
npm run sepolia:check
```

- Unit and HTTP tests exercise role separation, each transaction hash field, policy rules, a concurrent edit during approval, and receipt validation.
- The Anvil proof uses published Safe v1.4.1 contract artifacts. It rejects a one-owner signature attempt, executes a transfer with both owners, checks the exact token balance delta, and verifies receipt, nonce, and recovery after a forced desk-process restart. The test token includes its Solidity source and a checksum-linked Solidity 0.8.36 artifact targeting Shanghai. The Safe package is consumed as JSON artifacts, so its legacy ethers peer is excluded from the install.
- The Playwright test drives approval, recipient changes, export, real receipt verification, and JSON import through the UI. It captures desktop and mobile screenshots. Set `TREASURY_BROWSER_EXECUTABLE` to use an installed Chromium-based browser.
- The Sepolia command compares the local hash to the result from the published Safe singleton using read-only calls. Set `TREASURY_SEPOLIA_RPC_URL` to use your own read endpoint. The live signed-transfer workflow requires an owned, funded Sepolia Safe and its signers.
