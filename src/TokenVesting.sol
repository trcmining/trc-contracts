// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title TokenVesting
 * @dev 代币锁仓/线性释放合约
 *
 * 功能：
 * - 创建锁仓计划 (cliff + vesting period)
 * - 线性释放
 * - 多受益人支持
 * - 可撤销（可选）
 *
 * 生成于 Multi-Chain Token Builder
 */
contract TokenVesting is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct VestingSchedule {
        bool initialized;       // 是否已初始化
        address beneficiary;    // 受益人
        uint256 cliff;          // 悬崖期结束时间
        uint256 start;          // 开始时间
        uint256 duration;       // 释放周期
        uint256 slicePeriodSeconds; // 释放间隔（秒）
        bool revocable;         // 是否可撤销
        uint256 amountTotal;    // 总锁仓量
        uint256 released;       // 已释放量
        bool revoked;           // 是否已撤销
    }

    // 代币地址
    IERC20 public immutable token;

    // 锁仓计划 ID => 计划详情
    mapping(bytes32 => VestingSchedule) public vestingSchedules;
    
    // 受益人 => 锁仓计划数量
    mapping(address => uint256) public holdersVestingCount;
    
    // 锁仓计划总数
    uint256 public vestingSchedulesTotalCount;
    
    // 已锁仓总量
    uint256 public vestingSchedulesTotalAmount;

    // 事件
    event VestingScheduleCreated(
        bytes32 indexed vestingScheduleId,
        address indexed beneficiary,
        uint256 amount,
        uint256 start,
        uint256 cliff,
        uint256 duration
    );
    event Released(bytes32 indexed vestingScheduleId, uint256 amount);
    event Revoked(bytes32 indexed vestingScheduleId, uint256 refundAmount);

    constructor(address tokenAddress) Ownable(msg.sender) {
        require(tokenAddress != address(0), "Invalid token address");
        token = IERC20(tokenAddress);
    }

    /**
     * @dev 创建锁仓计划
     * @param beneficiary 受益人地址
     * @param start 开始时间（Unix 时间戳）
     * @param cliffDuration 悬崖期（秒）
     * @param duration 总释放周期（秒）
     * @param slicePeriodSeconds 释放间隔（秒）
     * @param revocable 是否可撤销
     * @param amount 锁仓代币数量
     */
    function createVestingSchedule(
        address beneficiary,
        uint256 start,
        uint256 cliffDuration,
        uint256 duration,
        uint256 slicePeriodSeconds,
        bool revocable,
        uint256 amount
    ) external onlyOwner {
        require(beneficiary != address(0), "Invalid beneficiary");
        require(amount > 0, "Amount must be > 0");
        require(duration > 0, "Duration must be > 0");
        require(slicePeriodSeconds > 0, "Slice period must be > 0");
        require(slicePeriodSeconds <= duration, "Slice period > duration");
        require(getWithdrawableAmount() >= amount, "Insufficient tokens");

        bytes32 vestingScheduleId = computeVestingScheduleIdForAddressAndIndex(
            beneficiary,
            holdersVestingCount[beneficiary]
        );

        uint256 cliff = start + cliffDuration;

        vestingSchedules[vestingScheduleId] = VestingSchedule({
            initialized: true,
            beneficiary: beneficiary,
            cliff: cliff,
            start: start,
            duration: duration,
            slicePeriodSeconds: slicePeriodSeconds,
            revocable: revocable,
            amountTotal: amount,
            released: 0,
            revoked: false
        });

        vestingSchedulesTotalAmount += amount;
        vestingSchedulesTotalCount++;
        holdersVestingCount[beneficiary]++;

        emit VestingScheduleCreated(
            vestingScheduleId,
            beneficiary,
            amount,
            start,
            cliff,
            duration
        );
    }

    /**
     * @dev 领取已解锁的代币
     */
    function release(bytes32 vestingScheduleId, uint256 amount) external nonReentrant {
        VestingSchedule storage schedule = vestingSchedules[vestingScheduleId];
        
        require(schedule.initialized, "Schedule not found");
        require(!schedule.revoked, "Schedule revoked");
        
        bool isBeneficiary = msg.sender == schedule.beneficiary;
        bool isOwner = msg.sender == owner();
        require(isBeneficiary || isOwner, "Not authorized");

        uint256 vestedAmount = computeReleasableAmount(vestingScheduleId);
        require(vestedAmount >= amount, "Not enough vested tokens");

        schedule.released += amount;
        vestingSchedulesTotalAmount -= amount;
        
        token.safeTransfer(schedule.beneficiary, amount);

        emit Released(vestingScheduleId, amount);
    }

    /**
     * @dev 撤销锁仓计划（仅限可撤销的计划）
     */
    function revoke(bytes32 vestingScheduleId) external onlyOwner {
        VestingSchedule storage schedule = vestingSchedules[vestingScheduleId];
        
        require(schedule.initialized, "Schedule not found");
        require(schedule.revocable, "Not revocable");
        require(!schedule.revoked, "Already revoked");

        // 先释放已解锁的部分给受益人
        uint256 vestedAmount = computeReleasableAmount(vestingScheduleId);
        if (vestedAmount > 0) {
            schedule.released += vestedAmount;
            // ⚠️ 这一行原先漏了，与 release() 不一致（2026-09-07 修）。
            //    漏掉的后果：这部分币已经离开合约，却仍被计在 vestingSchedulesTotalAmount 里，
            //    而 getWithdrawableAmount() = balance - vestingSchedulesTotalAmount ——
            //    于是它被少算，那部分余额永久卡在合约里，owner 也提不出来。
            //    方向是保守的（owner 少能提，不会多提），但账本身是错的。
            vestingSchedulesTotalAmount -= vestedAmount;
            token.safeTransfer(schedule.beneficiary, vestedAmount);
            emit Released(vestingScheduleId, vestedAmount);
        }

        // 计算未释放的部分
        uint256 unreleased = schedule.amountTotal - schedule.released;
        vestingSchedulesTotalAmount -= unreleased;
        schedule.revoked = true;

        emit Revoked(vestingScheduleId, unreleased);
    }

    /**
     * @dev 提取未锁定的代币
     */
    function withdraw(uint256 amount) external onlyOwner nonReentrant {
        require(getWithdrawableAmount() >= amount, "Not enough withdrawable");
        token.safeTransfer(owner(), amount);
    }

    // ======== 查询函数 ========

    /**
     * @dev 计算可领取的代币数量
     */
    function computeReleasableAmount(bytes32 vestingScheduleId) public view returns (uint256) {
        VestingSchedule storage schedule = vestingSchedules[vestingScheduleId];
        return computeVestedAmount(schedule) - schedule.released;
    }

    /**
     * @dev 计算已解锁的代币数量
     */
    function computeVestedAmount(VestingSchedule memory schedule) internal view returns (uint256) {
        if (schedule.revoked) {
            return schedule.released;
        }
        
        uint256 currentTime = block.timestamp;
        
        if (currentTime < schedule.cliff) {
            return 0;
        } else if (currentTime >= schedule.start + schedule.duration) {
            return schedule.amountTotal;
        } else {
            uint256 timeFromStart = currentTime - schedule.start;
            uint256 secondsPerSlice = schedule.slicePeriodSeconds;
            uint256 vestedSlicePeriods = timeFromStart / secondsPerSlice;
            uint256 vestedSeconds = vestedSlicePeriods * secondsPerSlice;
            uint256 vestedAmount = (schedule.amountTotal * vestedSeconds) / schedule.duration;
            return vestedAmount;
        }
    }

    /**
     * @dev 获取可提取的代币数量
     */
    function getWithdrawableAmount() public view returns (uint256) {
        return token.balanceOf(address(this)) - vestingSchedulesTotalAmount;
    }

    /**
     * @dev 计算锁仓计划 ID
     */
    function computeVestingScheduleIdForAddressAndIndex(
        address holder,
        uint256 index
    ) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(holder, index));
    }

    /**
     * @dev 获取锁仓计划详情
     */
    function getVestingSchedule(bytes32 vestingScheduleId) external view returns (VestingSchedule memory) {
        return vestingSchedules[vestingScheduleId];
    }

    /**
     * @dev 获取受益人的锁仓计划 ID
     */
    function getVestingScheduleByAddressAndIndex(
        address holder,
        uint256 index
    ) external view returns (VestingSchedule memory) {
        return vestingSchedules[computeVestingScheduleIdForAddressAndIndex(holder, index)];
    }
}
