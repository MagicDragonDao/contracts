// SPDX-License-Identifier: MIT
pragma solidity 0.8.10;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IERC20Mintable is IERC20 {
    function mint(address _to, uint256 _amount) external;

    function burn(address _to, uint256 _amount) external;
}

contract magicDRAGON is ERC20, IERC20Mintable {
    address public operator;

    constructor() ERC20("Magic Dragon MAGIC", "dragonMAGIC") {
        operator = msg.sender;
    }

    function setOperator(address _operator) external {
        require(msg.sender == operator, "Not operator");
        operator = _operator;
    }

    function mint(address _to, uint256 _amount) external {
        require(msg.sender == operator, "Not operator");

        _mint(_to, _amount);
    }

    function burn(address _from, uint256 _amount) external {
        require(msg.sender == operator, "Not operator");

        _burn(_from, _amount);
    }
}
