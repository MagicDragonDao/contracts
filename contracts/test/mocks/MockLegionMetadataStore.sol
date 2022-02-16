// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.10;

import "treasure-staking/contracts/interfaces/ILegionMetadataStore.sol";

contract MockLegionMetadataStore is ILegionMetadataStore {
    function setInitialMetadataForLegion(
        address _owner,
        uint256 _tokenId,
        LegionGeneration _generation,
        LegionClass _class,
        LegionRarity _rarity
    ) external override {}

    function increaseQuestLevel(uint256 _tokenId) external override {}

    function increaseCraftLevel(uint256 _tokenId) external override {}

    function increaseConstellationRank(
        uint256 _tokenId,
        Constellation _constellation,
        uint8 _to
    ) external {}

    function metadataForLegion(uint256 _tokenId) external pure override returns (LegionMetadata memory) {
        // Use first 5 IDs for 1/1s
        if (_tokenId < 5) {
            return
                LegionMetadata(
                    LegionGeneration.GENESIS,
                    LegionClass.ORIGIN,
                    LegionRarity.LEGENDARY,
                    0,
                    0,
                    [0, 0, 0, 0, 0, 0]
                );
        } else if (_tokenId >= 100) {
            return
                LegionMetadata(
                    LegionGeneration.GENESIS,
                    LegionClass.NUMERAIRE,
                    LegionRarity.UNCOMMON,
                    0,
                    0,
                    [0, 0, 0, 0, 0, 0]
                );
        } else {
            return
                LegionMetadata(
                    LegionGeneration.GENESIS,
                    LegionClass.ALL_CLASS,
                    LegionRarity.RARE,
                    0,
                    0,
                    [0, 0, 0, 0, 0, 0]
                );
        }
    }
}
