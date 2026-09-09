// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title 每期发放「应得名单」的 Merkle 根存证
 *
 * 用途：mining_rig2 的产出发放是**链下分配 + 链上支付** —— 链下按规则计提、
 * 管理员审核，再由 BatchDistributor 打款。链上只留下一笔转账，
 * 看不到规则、名单或依据，第三方无法验证「谁该拿多少」。
 * 本合约把每一期的应得名单承诺（Merkle root）钉在链上，
 * 用户拿自己的证明即可**独立核验**自己的份额，而不必自付 gas 去领取。
 *
 * 🔴 **根提交的是「应得」，不是「已付」。**
 *    广播前的地址复核会把失效明细跳过（地址被解绑/用户被封），
 *    而绑定关系随时可变 —— 包括根已上链之后、最后一笔转账发出之前。
 *    只要这个窗口存在，根就不可能恒等于实付。
 *    所以：`实付 = 根 − 跳过`，跳过名单由平台在链下公开。
 *    对外措辞的上限是「该期应得名单的承诺已上链，任何人可独立核验自己的份额」。
 *
 * ⚠️ **本合约不提供「已发布份额 owner 动不了」的保证。**
 *    那是 TRCMiningDistributor（Merkle 领取）才有的性质。
 *    这里只做存证：让分配变得可验证，但金库余额 owner 依然随时可取走。
 *    别把两者混为一谈。
 *
 * ⚠️ **刻意保持极小**：只有 publishRoot 一个写函数，没有 update / delete /
 *    暂停 / 备注。可覆盖的根等于没有承诺；而每多一个函数，
 *    「owner 还能对这个合约做什么」就多一分需要审计的余地 ——
 *    这个合约的全部价值就在于它小到一眼能看完。
 *
 * 叶子编码（与链下 OpenZeppelin merkle-tree 库的 StandardMerkleTree 一致）：
 *     leaf = keccak256(keccak256(abi.encode(address account, uint256 amount)))
 * 验证用 OpenZeppelin MerkleProof.verify(proof, root, leaf) 即可，本合约不代劳
 * —— 验证是纯计算，放在链上只会让每个想核验的人白付一次 gas。
 */
contract PayoutRootRegistry is Ownable {
    struct Period {
        bytes32 root; //        槽 0
        uint128 totalAmount; // ┐
        uint32 count; //        ├ 槽 1（打包，省一次 SSTORE）
        uint64 publishedAt; //  ┘
    }

    /// periodId => 该期的承诺。periodId 用链下 PayoutBatch.seq，与发放幂等键同源
    mapping(uint256 => Period) public periods;

    event RootPublished(
        uint256 indexed periodId,
        bytes32 root,
        uint128 totalAmount,
        uint32 count
    );

    constructor(address owner_) Ownable(owner_) {}

    /**
     * 发布某一期的应得名单承诺。
     *
     * @param periodId    链下 PayoutBatch.seq
     * @param root        名单的 Merkle 根
     * @param totalAmount 该期应得总额（最小单位），便于第三方核对量级
     * @param count       该期应得人数
     *
     * ⚠️ **一期只能发布一次，发布后永远不可更改。**
     *    这既是承诺的全部意义，也意味着算错了没有任何补救 ——
     *    链下必须先跑一遍重算比对再调这个函数。
     */
    function publishRoot(
        uint256 periodId,
        bytes32 root,
        uint128 totalAmount,
        uint32 count
    ) external onlyOwner {
        require(periods[periodId].root == bytes32(0), "Already published");
        // 空根/空名单一律当链下算错了拦下，不静默写进去
        require(root != bytes32(0), "Empty root");
        require(count > 0, "Empty period");
        require(totalAmount > 0, "Zero total");

        periods[periodId] = Period(root, totalAmount, count, uint64(block.timestamp));
        emit RootPublished(periodId, root, totalAmount, count);
    }

    /// 该期是否已发布。链下重试前先读这个，避免撞 "Already published" revert
    function isPublished(uint256 periodId) external view returns (bool) {
        return periods[periodId].root != bytes32(0);
    }
}
