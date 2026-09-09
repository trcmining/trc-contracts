// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title 批量发放合约（平台主动派发）
 *
 * ⚠️ 2026-09-05 由 `DataBatchDistributor` 改名而来。旧名是 DATA 时期的遗留，
 *    而本合约与任何具体代币无关 —— 发什么币由构造函数的 `token_` 决定。
 *    改名是在**部署之前**做的：合约名会永久挂在区块浏览器上，
 *    叫 DataBatchDistributor 会让每个接手的人都以为它随 DATA 一起作废了
 *    （项目方本人就这么问过一次）。
 *
 * 用途：把结算好的日/周产出一次性打给一批地址，省掉逐笔转账每笔 21000 的 base gas。
 *
 * ⚠️ 与 TRCMiningDistributor 的定位区别，别混淆：
 *   那一个是 Merkle 领取，提供「已发布的份额 owner 动不了」的硬保证，面向矿工做承诺；
 *   这一个是纯运维工具，**不向接收方提供任何链上保证** —— owner 随时可以 withdraw
 *   走全部余额。它解决的只是「怎么便宜地发出去」，不解决「凭什么相信会发」。
 *   两者资金池分开放，职责不重叠。
 */
contract BatchDistributor is Ownable {
    using SafeERC20 for IERC20;

    /// 发放的代币，部署后不可更换
    IERC20 public immutable token;

    /// 单批最大笔数。链下按更小的 chunk 切分，这里只是兜底，防止塞爆区块 gas 上限
    uint256 public immutable maxBatchSize;

    /**
     * batchId => 是否已发放。
     *
     * 幂等键：链下系统等回执超时后重试是常态，而重试时那笔交易可能其实已经成功。
     * 没有这道锁，一次超时重试就会把同一批钱发两遍 —— 这类事故在发放系统里最常见，
     * 且发出去要不回来。batchId 用链下 PayoutBatch 的主键传入即可。
     */
    mapping(uint256 => bool) public batchSent;

    event BatchSent(uint256 indexed batchId, uint256 count, uint256 total);
    event Withdrawn(address indexed to, uint256 amount);
    event TokenRescued(address indexed token, address indexed to, uint256 amount);

    constructor(address token_, address owner_, uint256 maxBatchSize_) Ownable(owner_) {
        require(token_ != address(0), "Invalid token");
        require(maxBatchSize_ > 0, "Invalid max batch size");
        token = IERC20(token_);
        maxBatchSize = maxBatchSize_;
    }

    /**
     * 批量发放
     *
     * @param batchId    链下批次 ID，同时作为幂等键，同一个 ID 只能成功一次
     * @param recipients 收款地址，与 amounts 一一对应
     * @param amounts    对应金额（最小单位）
     *
     * 任一笔失败整笔 revert：不做 try/catch 跳过。部分成功在链下无法表达
     * ——「一个批次 = 一条记录 = 一个状态」，半成功状态没法对账，重试也说不清该重试谁。
     */
    function batchTransfer(
        uint256 batchId,
        address[] calldata recipients,
        uint256[] calldata amounts
    ) external onlyOwner {
        uint256 len = recipients.length;
        require(len > 0, "Empty batch");
        require(len == amounts.length, "Length mismatch");
        require(len <= maxBatchSize, "Batch too large");
        require(!batchSent[batchId], "Batch already sent");

        batchSent[batchId] = true;

        uint256 total;
        for (uint256 i = 0; i < len; i++) {
            address to = recipients[i];
            uint256 amount = amounts[i];
            // 零地址会烧掉这笔钱，零金额是链下算错了 —— 都当数据错误拦下，不静默放行
            require(to != address(0), "Zero recipient");
            require(amount > 0, "Zero amount");
            total += amount;
            token.safeTransfer(to, amount);
        }

        emit BatchSent(batchId, len, total);
    }

    /// 取回未发放的余额
    function withdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        token.safeTransfer(to, amount);
        emit Withdrawn(to, amount);
    }

    /// 取回误转进来的其他代币
    function rescueToken(address token_, address to, uint256 amount) external onlyOwner {
        require(token_ != address(token), "Use withdraw");
        require(to != address(0), "Invalid recipient");
        IERC20(token_).safeTransfer(to, amount);
        emit TokenRescued(token_, to, amount);
    }

    /// 合约当前持有的可发放余额
    function balance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
