# TRC Contracts

Source code for TRC (Trade Credit) and its supporting contracts. **Every source file here corresponds to a
contract that is deployed and source-verified on Ethereum mainnet** — so that anyone can compile it, diff it,
and run its tests themselves, instead of taking our word for it.

中文版：[README.zh-CN.md](./README.zh-CN.md)

## Deployed on mainnet

| Contract | Address | Role |
|---|---|---|
| **TRC** (`AdvancedERC20`) | [`0x76371918bc75470CEE749685dC57bd6c3B8e82f2`](https://etherscan.io/address/0x76371918bc75470CEE749685dC57bd6c3B8e82f2#code) | The token. 1,000,000,000 total supply, 8 decimals, **no mint function** |
| **BatchDistributor** | [`0x31567650f1d7672358B1265FCd95d36A7c7A0825`](https://etherscan.io/address/0x31567650f1d7672358B1265FCd95d36A7c7A0825#code) | Payout vault: transfers TRC to users in batches, with an on-chain idempotency key |
| **PayoutRootRegistry** | [`0x9B0e969d5bE6E15C75fFdDA882be7eF96157E6eC`](https://etherscan.io/address/0x9B0e969d5bE6E15C75fFdDA882be7eF96157E6eC#code) | Merkle root commitment for each period's entitlement list; one write per period |
| **TokenVesting** | [`0x2C279f6f89eb1cb1D00F90DE4f1afaf89fE6aEb7`](https://etherscan.io/address/0x2C279f6f89eb1cb1D00F90DE4f1afaf89fE6aEb7#code) | Lockup for the team & advisor allocation (100,000,000 TRC), `revocable = false` |

Exact deployment parameters — constructor arguments, deployment transactions and blocks, owners — are in
[`deployments.json`](./deployments.json).

## Verify it yourself

```bash
npm install
npm test                 # 53 tests
npm run verify:onchain   # compiles, then compares against Ethereum mainnet
```

`verify:onchain` is the one that matters. It reads the deployed code back from a public node
and checks it against a local compile, contract by contract:

```
✓ TRC  0x76371918bc75470CEE749685dC57bd6c3B8e82f2
    runtime bytecode : identical (6607 bytes)
    metadata hash    : 75c7853ba512c581374ac83d1933ed45a2740984ff6fb16ea4c6e67fc93a7df1

✓ BatchDistributor  0x31567650f1d7672358B1265FCd95d36A7c7A0825
    runtime bytecode : identical (2376 bytes)
    immutables masked: @166+32, @320+32, @573+32, @777+32, @1187+32, @1103+32, @1881+32
    metadata hash    : bb5ec30484547da517ab869740d1c811bdb8aa710f5daaae44ba0cb6ba4362dd

✓ PayoutRootRegistry  0x9B0e969d5bE6E15C75fFdDA882be7eF96157E6eC
    runtime bytecode : identical (1131 bytes)
    metadata hash    : a44e07c4dc20c5f55ff1d4c292ef1cf8e6e4b3ed399c59ff62e3e737bb670a6c

✓ TokenVesting  0x2C279f6f89eb1cb1D00F90DE4f1afaf89fE6aEb7
    runtime bytecode : identical (4336 bytes)
    immutables masked: @241+32, @982+32, @1624+32, @2145+32, @3971+32
    metadata hash    : 44bb77b2ceec340f1413ebcdb31e0dccbef6fedbb73d6f169d4a6a806d5845db

All 4 contracts match the source in this repository.
```

The script is read-only — it signs nothing and sends nothing. Point it at your own node with
`MAINNET_RPC_URL=... npm run verify:onchain` if you would rather not trust ours. It makes two
comparisons per contract and both must pass:

- **The full runtime bytecode**, with immutable slots masked out. Immutables are written into
  the code at construction time (the token address a distributor is bound to, for instance),
  so those bytes legitimately differ from a fresh compile. Their positions come from the
  compiler's own `immutableReferences` output, not from guesswork, and each masked slot is
  printed so you can see exactly what was excluded. Every other byte must match.
- **The metadata hash** that solc appends to the bytecode. It is a hash of the source files,
  so it is what ties this repository's text to the contract on chain.

You can also compare by hand: open any Etherscan link in the table above, go to
**Contract → Code**, and diff it against the corresponding file in `src/`.

### Reproducing the build requires exact versions

Three settings have to match the ones used at deployment, and getting any of them wrong makes
the bytecode differ:

| | Value | If it is wrong |
|---|---|---|
| solc | `0.8.20` | different compiler, different output |
| `evmVersion` | **`paris`** | 0.8.20 defaults to `shanghai`, which emits `PUSH0` — the whole bytecode changes |
| `@openzeppelin/contracts` | **`5.4.0`**, pinned exactly | a `^5.4.0` range resolves to newer releases whose ERC20/SafeERC20 differ |

All three are pinned in `hardhat.config.ts` and `package.json`. They are pinned because we got
each of them wrong first, and `verify:onchain` is what caught it.

## What these contracts can and cannot do

Each of the following is a fact you can confirm by reading the source. It is listed here so you know what to
go and check.

- **TRC has no mint function.** `_mint` runs exactly once, in the constructor; the total supply is fixed
  permanently after that.
- **The TRC owner still holds real powers.** `setBlacklist` can freeze any address unconditionally
  (**not only DEX addresses — ordinary wallet-to-wallet transfers are blocked too**); `setTaxes` can levy up
  to 25% on DEX buys and 25% on DEX sells, plus up to a 25% liquidity tax; `setTradingEnabled(false)` can
  disable DEX trading. The contract inherits OpenZeppelin `Ownable`, which offers only an all-or-nothing
  `renounceOwnership()` — **there is no way to give up one of these powers and keep the others**.
- **`BatchDistributor.batchTransfer` is `onlyOwner`**, and the owner can `withdraw` the contract's balance at
  any time. It gives recipients **no on-chain guarantee whatsoever**; it is a gas-saving batch transfer tool,
  nothing more.
- **PayoutRootRegistry neither holds nor moves any tokens.** It only stores Merkle roots. Verification is
  deliberately *not* done on chain: it is pure computation, and putting it on chain would only make everyone
  who wants to check their share pay gas for the privilege.
- **A TokenVesting beneficiary cannot be changed once written.** There is no `setBeneficiary` among the
  contract's functions.

## Why the comments in `src/*.sol` are in Chinese

The four deployed contracts are kept **byte-for-byte identical to the source verified on
Etherscan**, comments included. That is not an oversight, and it is the one thing in this
repository that must not be "tidied up".

Solidity embeds a metadata hash in the deployed bytecode, and that hash covers the source
file — comments and all. Editing a single comment changes it. Adding one character to one
comment in `BatchDistributor.sol` gives:

```
on chain  bb5ec30484547da517ab869740d1c811bdb8aa710f5daaae44ba0cb6ba4362dd
local     ab4bcb25352016e698e4ee8aff87c431e0fbb70360d89684667e79b94afac135
```

`verify:onchain` fails immediately. So translating those comments would mean this source no
longer reproduces the bytecode that is actually on chain — and the verification above, the
only reason this repository exists, would fail for everyone who ran it. A readable comment is
not worth that.

Everything that is *not* part of the deployed bytecode is in English: this README, the tests,
`deployments.json`, the build config, the verification script, and the test-only helper
contract. The contract logic is readable from the code itself, and every guarantee it makes is
described in English by a test.

If these contracts are ever redeployed, the comments will be written in English from the start.

## No third-party security audit has been performed

Publicly verifiable and audited are two different things, and we do not present the former as the latter.
When an audit is completed, the auditor, the date, and a link to the report will appear here.

## Not in this repository

The platform's backend and frontend source are not here — they contain hot-wallet handling, risk-control
criteria, and other parts that should not be public. This repository contains only the on-chain contracts,
that is, the part anyone could already read from a block explorer.

## License

MIT — see [`LICENSE`](./LICENSE).
