// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * ⚠️ **Test only. Do not deploy this to any network.**
 *
 * PayoutRootRegistry deliberately does not verify proofs on chain: verification is
 * pure computation, and putting it on chain would only make everyone who wants to
 * check their share pay gas for the privilege. But that leaves one claim untested —
 * that our leaf encoding and our proofs are accepted by the standard Solidity
 * verifier. The off-chain verifier that is "equivalent to Solidity" is hand-written,
 * and whether it really is equivalent can only be established by running the real
 * MerkleProof.verify against it.
 *
 * This thin wrapper exists for exactly that: the tests feed proofs generated off
 * chain into the genuine OpenZeppelin library, and only a pass counts as agreement.
 */
contract MerkleProofChecker {
    /// Leaf encoding matches the off-chain StandardMerkleTree: keccak256(keccak256(abi.encode(account, amount)))
    function leafOf(address account, uint256 amount) public pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
    }

    function verify(
        bytes32[] calldata proof,
        bytes32 root,
        address account,
        uint256 amount
    ) external pure returns (bool) {
        return MerkleProof.verify(proof, root, leafOf(account, amount));
    }
}
