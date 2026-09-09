# TRC Contracts

TRC（Trade Credit）及其配套合约的源码。**这里的每一份源码都对应以太坊主网上一个已开源验证的合约**
—— 目的是让任何人都能自己编译、自己比对、自己跑测试，而不必相信我们的说法。

English: [README.md](./README.md)

## 主网已部署合约

| 合约 | 地址 | 作用 |
|---|---|---|
| **TRC**（`AdvancedERC20`） | [`0x76371918bc75470CEE749685dC57bd6c3B8e82f2`](https://etherscan.io/address/0x76371918bc75470CEE749685dC57bd6c3B8e82f2#code) | 代币本身。总量 10 亿、8 位小数，**无 mint 函数** |
| **BatchDistributor** | [`0x31567650f1d7672358B1265FCd95d36A7c7A0825`](https://etherscan.io/address/0x31567650f1d7672358B1265FCd95d36A7c7A0825#code) | 发放金库：按批把 TRC 转给用户，带链上幂等键 |
| **PayoutRootRegistry** | [`0x9B0e969d5bE6E15C75fFdDA882be7eF96157E6eC`](https://etherscan.io/address/0x9B0e969d5bE6E15C75fFdDA882be7eF96157E6eC#code) | 每期「应得名单」的 Merkle 根存证，一期只能写一次 |
| **TokenVesting** | [`0x2C279f6f89eb1cb1D00F90DE4f1afaf89fE6aEb7`](https://etherscan.io/address/0x2C279f6f89eb1cb1D00F90DE4f1afaf89fE6aEb7#code) | 团队与顾问份额（1 亿枚）的锁仓，`revocable = false` |

准确的部署参数（构造函数入参、部署交易、部署区块、owner）见 [`deployments.json`](./deployments.json)。
⚠️ 那份登记表是**英文的单一副本**，刻意不做中文版 —— 它是白皮书和 README 引用的数据源头，
复制成两份必然漂移，而漂移的后果是照着它核对的人得出「地址是编的」这个结论。

## 自己核对

```bash
npm install
npm test                 # 53 条测试
npm run verify:onchain   # 编译，然后与以太坊主网逐字节比对
```

关键是 `verify:onchain`。它把链上部署的代码读回来，与本地编译结果逐个合约比对：

```
✓ TRC  0x76371918bc75470CEE749685dC57bd6c3B8e82f2
    runtime bytecode : identical (6607 bytes)
    metadata hash    : 75c7853ba512c581374ac83d1933ed45a2740984ff6fb16ea4c6e67fc93a7df1
…
All 4 contracts match the source in this repository.
```

脚本是**只读**的：不签名、不发交易。不想信我们用的节点，就
`MAINNET_RPC_URL=... npm run verify:onchain` 换成你自己的。每个合约比两样，两样都得过：

- **完整 runtime 字节码**，其中 immutable 槽位被遮蔽。immutable 是构造时才写进代码的
  （比如金库绑定的代币地址），这些字节与全新编译的结果本来就该不同。槽位由编译器自己输出的
  `immutableReferences` 给出，不是猜的，且每个被遮蔽的槽都会打印出来给你看排除了什么。
  其余每一个字节必须相同。
- **solc 附在字节码末尾的 metadata 哈希**。它是源文件的哈希，正是把这个仓库里的文本
  与链上合约绑在一起的那个东西。

也可以手工比：打开上表任一 Etherscan 链接的 **Contract → Code**，与 `src/` 下对应文件逐字比对。

### 复现构建必须版本完全一致

三个设置必须与部署时相同，错一个字节码就对不上：

| | 取值 | 错了会怎样 |
|---|---|---|
| solc | `0.8.20` | 编译器不同，输出就不同 |
| `evmVersion` | **`paris`** | 0.8.20 默认 `shanghai`，会发 `PUSH0`，整段字节码都变 |
| `@openzeppelin/contracts` | **`5.4.0`**，精确钉死 | `^5.4.0` 会解析到更新的版本，其 ERC20 / SafeERC20 已不同 |

三个都钉在 `hardhat.config.ts` 与 `package.json` 里。之所以钉，是因为这三样我们**一开始全错了**，
而发现它们的正是 `verify:onchain`。

## 这些合约能做什么、不能做什么

这几条是读源码就能确认的事实，写在这里是为了让你知道该去查什么：

- **TRC 没有增发函数。** `_mint` 只在构造函数里执行一次，总量此后永久固定。
- **TRC 的 owner 仍有权限**：`setBlacklist` 可以无条件冻结任意地址（**不限于 DEX，普通钱包间转账同样会被拦**）、
  `setTaxes` 可对 DEX 交易买卖各收最高 25% 另加最高 25% 流动性税、`setTradingEnabled(false)` 可关闭 DEX 交易。
  合约继承 OpenZeppelin `Ownable`，只有「全部放弃」这一个开关，**没有单独关闭某一项权限的办法**。
- **BatchDistributor 的 `batchTransfer` 是 `onlyOwner`**，且 owner 可以 `withdraw` 取走合约里的余额 ——
  它**不向收款方提供任何链上保证**，只是省 gas 的批量转账工具。
- **PayoutRootRegistry 不持有也不转移任何代币**，只存 Merkle 根。它刻意不在链上做验证 ——
  验证是纯计算，放链上只会让每个想核验的人白付一次 gas。
- **TokenVesting 的受益人上链后不可更改**（十个函数里没有 `setBeneficiary`）。

## `src/*.sol` 里的注释为什么是中文

四份已部署的合约与 **Etherscan 上已验证的源码保持逐字节一致**，注释也不例外。
这不是遗漏，而是这个仓库里唯一**不能"顺手整理"**的东西。

Solidity 会把一段 metadata 哈希嵌进部署字节码，而那个哈希覆盖整个源文件、**包括注释**。
改一个注释就会变。在 `BatchDistributor.sol` 的一条注释里加一个字符：

```
链上  bb5ec30484547da517ab869740d1c811bdb8aa710f5daaae44ba0cb6ba4362dd
本地  ab4bcb25352016e698e4ee8aff87c431e0fbb70360d89684667e79b94afac135
```

`verify:onchain` 当场就红。也就是说，把那些注释译成英文，这份源码就不再能复现链上真正跑着的
字节码，上面那道核验——这个仓库存在的唯一理由——会对每个照做的人失败。一条读得懂的注释不值这个价。

凡是**不进部署字节码**的部分都已是英文：README、测试、`deployments.json`、构建配置、
核验脚本，以及那个仅供测试的辅助合约。合约逻辑本身读代码即可，它做出的每一条保证都有英文测试描述。

将来若重新部署这些合约，注释会从一开始就用英文写。

## 尚未做过第三方安全审计

代码公开可验证与经过审计是两回事，我们不把前者说成后者。
一旦完成审计，审计方、日期与报告链接会写在这里。

## 不在本仓库内

平台的后端与前端源码不在这里 —— 那里面有热钱包处理、风控判据等不适合公开的部分。
本仓库只包含链上合约，也就是任何人本来就能从区块浏览器读到的那部分。

## 许可

MIT，见 [`LICENSE`](./LICENSE)。
