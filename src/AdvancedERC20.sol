// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title AdvancedERC20
 * @dev 高级 ERC20 代币合约模板
 *
 * 功能：
 * - 自动税费系统 (买入/卖出/流动性税)
 * - 反机器人保护 (交易限额/持有限额/冷却时间)
 * - 黑名单机制
 * - 可销毁
 *
 * 生成于 Multi-Chain Token Builder
 */
contract AdvancedERC20 is ERC20, ERC20Burnable, Ownable {
    uint8 private _decimals;
    
    // ======== 税费配置 ========
    uint256 public buyTax;       // 买入税 (基点)
    uint256 public sellTax;      // 卖出税 (基点)
    uint256 public liquidityTax; // 流动性税 (基点)
    address public taxReceiver;
    address public liquidityReceiver;
    
    // ======== 反机器人配置 ========
    uint256 public maxTxAmount;      // 单笔最大交易量
    uint256 public maxWalletAmount;  // 钱包最大持有量
    uint256 public tradingDelay;     // 交易冷却时间(秒)
    bool public tradingEnabled;      // 是否开启交易
    
    // 交易时间记录
    mapping(address => uint256) public lastTxTime;
    
    // DEX 交易对
    mapping(address => bool) public isDexPair;
    
    // 免税/免限制地址
    mapping(address => bool) public isExcludedFromTax;
    mapping(address => bool) public isExcludedFromLimit;
    
    // 黑名单
    mapping(address => bool) public isBlacklisted;
    
    // 常量
    uint256 public constant MAX_TAX = 2500; // 最大 25% 税率
    
    // 事件
    event TaxUpdated(uint256 buyTax, uint256 sellTax, uint256 liquidityTax);
    event LimitsUpdated(uint256 maxTxAmount, uint256 maxWalletAmount, uint256 tradingDelay);
    event DexPairUpdated(address pair, bool status);
    event TradingEnabled(bool enabled);
    event BlacklistUpdated(address account, bool blacklisted);
    event ExcludedFromTax(address account, bool excluded);
    event ExcludedFromLimit(address account, bool excluded);

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        uint256 totalSupply_,
        address recipient_,
        uint256 buyTax_,
        uint256 sellTax_,
        uint256 liquidityTax_,
        address taxReceiver_,
        uint256 maxTxAmount_,
        uint256 maxWalletAmount_,
        uint256 tradingDelay_
    ) ERC20(name_, symbol_) Ownable(msg.sender) {
        require(recipient_ != address(0), "Invalid recipient");
        require(buyTax_ <= MAX_TAX, "Buy tax too high");
        require(sellTax_ <= MAX_TAX, "Sell tax too high");
        require(liquidityTax_ <= MAX_TAX, "Liquidity tax too high");
        
        _decimals = decimals_;
        
        // 税费设置
        buyTax = buyTax_;
        sellTax = sellTax_;
        liquidityTax = liquidityTax_;
        taxReceiver = taxReceiver_ != address(0) ? taxReceiver_ : msg.sender;
        liquidityReceiver = taxReceiver;
        
        // 反机器人设置
        uint256 supply = totalSupply_ * 10 ** decimals_;
        maxTxAmount = maxTxAmount_ > 0 ? maxTxAmount_ * 10 ** decimals_ : supply;
        maxWalletAmount = maxWalletAmount_ > 0 ? maxWalletAmount_ * 10 ** decimals_ : supply;
        tradingDelay = tradingDelay_;
        tradingEnabled = true;
        
        // 免除 owner 和重要地址
        isExcludedFromTax[msg.sender] = true;
        isExcludedFromTax[taxReceiver] = true;
        isExcludedFromTax[recipient_] = true;
        isExcludedFromLimit[msg.sender] = true;
        isExcludedFromLimit[taxReceiver] = true;
        isExcludedFromLimit[recipient_] = true;
        
        if (totalSupply_ > 0) {
            _mint(recipient_, supply);
        }
    }

    function decimals() public view virtual override returns (uint8) {
        return _decimals;
    }

    // ======== 管理函数 ========
    
    function setDexPair(address pair, bool status) external onlyOwner {
        isDexPair[pair] = status;
        emit DexPairUpdated(pair, status);
    }

    function setTaxes(uint256 buyTax_, uint256 sellTax_, uint256 liquidityTax_) external onlyOwner {
        require(buyTax_ <= MAX_TAX && sellTax_ <= MAX_TAX && liquidityTax_ <= MAX_TAX, "Tax too high");
        buyTax = buyTax_;
        sellTax = sellTax_;
        liquidityTax = liquidityTax_;
        emit TaxUpdated(buyTax_, sellTax_, liquidityTax_);
    }

    function setTaxReceivers(address taxReceiver_, address liquidityReceiver_) external onlyOwner {
        require(taxReceiver_ != address(0), "Invalid receiver");
        taxReceiver = taxReceiver_;
        liquidityReceiver = liquidityReceiver_ != address(0) ? liquidityReceiver_ : taxReceiver_;
    }

    function setLimits(uint256 maxTxAmount_, uint256 maxWalletAmount_, uint256 tradingDelay_) external onlyOwner {
        maxTxAmount = maxTxAmount_ * 10 ** _decimals;
        maxWalletAmount = maxWalletAmount_ * 10 ** _decimals;
        tradingDelay = tradingDelay_;
        emit LimitsUpdated(maxTxAmount_, maxWalletAmount_, tradingDelay_);
    }

    function removeLimits() external onlyOwner {
        maxTxAmount = totalSupply();
        maxWalletAmount = totalSupply();
        tradingDelay = 0;
        emit LimitsUpdated(totalSupply(), totalSupply(), 0);
    }

    function setTradingEnabled(bool enabled) external onlyOwner {
        tradingEnabled = enabled;
        emit TradingEnabled(enabled);
    }

    function setBlacklist(address account, bool blacklisted) external onlyOwner {
        isBlacklisted[account] = blacklisted;
        emit BlacklistUpdated(account, blacklisted);
    }

    function setExcludedFromTax(address account, bool excluded) external onlyOwner {
        isExcludedFromTax[account] = excluded;
        emit ExcludedFromTax(account, excluded);
    }

    function setExcludedFromLimit(address account, bool excluded) external onlyOwner {
        isExcludedFromLimit[account] = excluded;
        emit ExcludedFromLimit(account, excluded);
    }

    // ======== 核心转账逻辑 ========

    function _update(address from, address to, uint256 amount) internal virtual override {
        // 铸造/销毁直接通过
        if (from == address(0) || to == address(0)) {
            super._update(from, to, amount);
            return;
        }

        // 黑名单检查
        require(!isBlacklisted[from] && !isBlacklisted[to], "Blacklisted");

        // 判断是否为 DEX 交易
        bool isBuy = isDexPair[from];
        bool isSell = isDexPair[to];
        bool isDexTx = isBuy || isSell;

        // 交易开关检查（仅 DEX 交易）
        if (isDexTx && !isExcludedFromLimit[from] && !isExcludedFromLimit[to]) {
            require(tradingEnabled, "Trading not enabled");
        }

        // 反机器人限制（仅 DEX 交易）
        if (isDexTx && !isExcludedFromLimit[from] && !isExcludedFromLimit[to]) {
            // 交易量限制
            require(amount <= maxTxAmount, "Exceeds max tx");
            
            // 买入时检查钱包持有量限制
            if (isBuy) {
                require(balanceOf(to) + amount <= maxWalletAmount, "Exceeds max wallet");
            }
            
            // 冷却时间检查
            if (tradingDelay > 0) {
                require(block.timestamp >= lastTxTime[from] + tradingDelay, "Cooling down");
                require(block.timestamp >= lastTxTime[to] + tradingDelay, "Cooling down");
            }
        }

        // 更新交易时间
        lastTxTime[from] = block.timestamp;
        lastTxTime[to] = block.timestamp;

        // 税费计算（仅 DEX 交易且非免税地址）
        if (isDexTx && !isExcludedFromTax[from] && !isExcludedFromTax[to]) {
            uint256 taxAmount = 0;
            uint256 liquidityAmount = 0;
            
            if (isBuy) {
                taxAmount = (amount * buyTax) / 10000;
                liquidityAmount = (amount * liquidityTax) / 10000;
            } else if (isSell) {
                taxAmount = (amount * sellTax) / 10000;
                liquidityAmount = (amount * liquidityTax) / 10000;
            }

            uint256 transferAmount = amount - taxAmount - liquidityAmount;
            
            super._update(from, to, transferAmount);
            
            if (taxAmount > 0) {
                super._update(from, taxReceiver, taxAmount);
            }
            if (liquidityAmount > 0) {
                super._update(from, liquidityReceiver, liquidityAmount);
            }
        } else {
            super._update(from, to, amount);
        }
    }
}
