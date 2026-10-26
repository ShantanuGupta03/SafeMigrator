// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// TESTNET-ONLY sample assets for demonstrating Safe Migrator. Not audited; never deploy to mainnet.
// Each contract mints its demo supply to the deployer in the constructor (one transaction each).

contract SampleToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory name_, string memory symbol_, uint8 decimals_, uint256 supply) {
        name = name_;
        symbol = symbol_;
        decimals = decimals_;
        _mint(msg.sender, supply);
    }

    function transfer(address to, uint256 amount) external virtual returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _transfer(from, to, amount);
        return true;
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal virtual {
        require(to != address(0), "zero");
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// 1% of every transfer is burned: the receiver gets less than was sent.
contract FeeOnTransferToken is SampleToken {
    constructor(uint256 supply) SampleToken("Fee Demo Token", "FEED", 18, supply) {}

    function _transfer(address from, address to, uint256 amount) internal override {
        require(to != address(0), "zero");
        require(balanceOf[from] >= amount, "balance");
        uint256 fee = amount / 100;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        totalSupply -= fee;
        emit Transfer(from, to, amount - fee);
        if (fee > 0) emit Transfer(from, address(0), fee);
    }
}

/// Every transfer reverts (models paused / blocklisted / restricted tokens).
contract RestrictedToken is SampleToken {
    constructor(uint256 supply) SampleToken("Restricted Demo Token", "RSTD", 18, supply) {}

    function transfer(address, uint256) external pure override returns (bool) {
        revert("RestrictedToken: transfers paused");
    }
}

interface IERC721Receiver {
    function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4);
}

contract SampleNFT {
    string public name;
    string public symbol;
    bool public immutable soulbound;
    mapping(uint256 => address) internal _owners;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    constructor(string memory name_, string memory symbol_, bool soulbound_, uint256 count) {
        name = name_;
        symbol = symbol_;
        soulbound = soulbound_;
        for (uint256 i = 1; i <= count; i++) {
            _owners[i] = msg.sender;
            emit Transfer(address(0), msg.sender, i);
        }
        balanceOf[msg.sender] = count;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd || id == 0x01ffc9a7 || id == 0x5b5e139f;
    }

    function ownerOf(uint256 id) public view returns (address o) {
        o = _owners[id];
        require(o != address(0), "nonexistent");
    }

    function tokenURI(uint256) external pure returns (string memory) {
        return "";
    }

    function approve(address to, uint256 id) external {
        address o = ownerOf(id);
        require(msg.sender == o || isApprovedForAll[o][msg.sender], "auth");
        getApproved[id] = to;
        emit Approval(o, to, id);
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
        emit ApprovalForAll(msg.sender, op, ok);
    }

    function transferFrom(address from, address to, uint256 id) public {
        require(!soulbound, "SampleNFT: soulbound");
        require(from == ownerOf(id), "from");
        require(to != address(0), "zero");
        require(msg.sender == from || isApprovedForAll[from][msg.sender] || getApproved[id] == msg.sender, "auth");
        delete getApproved[id];
        balanceOf[from]--;
        balanceOf[to]++;
        _owners[id] = to;
        emit Transfer(from, to, id);
    }

    function safeTransferFrom(address from, address to, uint256 id) external {
        safeTransferFrom(from, to, id, "");
    }

    function safeTransferFrom(address from, address to, uint256 id, bytes memory data) public {
        transferFrom(from, to, id);
        if (to.code.length > 0) {
            require(IERC721Receiver(to).onERC721Received(msg.sender, from, id, data) == 0x150b7a02, "unsafe receiver");
        }
    }
}

interface IERC1155Receiver {
    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external returns (bytes4);
    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata) external returns (bytes4);
}

contract SampleMultiToken {
    mapping(uint256 => mapping(address => uint256)) private _balances;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    string public name = "Sample Multi Token";
    string public symbol = "SM1155";

    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);
    event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values);
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);

    constructor() {
        uint256[] memory ids = new uint256[](3);
        uint256[] memory amounts = new uint256[](3);
        for (uint256 i = 0; i < 3; i++) {
            ids[i] = i + 1;
            amounts[i] = 10 ** (2 - i) * 5; // 500, 50, 5
            _balances[i + 1][msg.sender] = amounts[i];
        }
        emit TransferBatch(msg.sender, address(0), msg.sender, ids, amounts);
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0xd9b67a26 || id == 0x01ffc9a7;
    }

    function uri(uint256) external pure returns (string memory) {
        return "";
    }

    function setApprovalForAll(address op, bool ok) external {
        isApprovedForAll[msg.sender][op] = ok;
        emit ApprovalForAll(msg.sender, op, ok);
    }

    function balanceOf(address account, uint256 id) external view returns (uint256) {
        return _balances[id][account];
    }

    function balanceOfBatch(address[] calldata accounts, uint256[] calldata ids) external view returns (uint256[] memory out) {
        require(accounts.length == ids.length, "length");
        out = new uint256[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) out[i] = _balances[ids[i]][accounts[i]];
    }

    function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes calldata data) external {
        require(msg.sender == from || isApprovedForAll[from][msg.sender], "auth");
        require(to != address(0), "zero");
        require(_balances[id][from] >= amount, "balance");
        _balances[id][from] -= amount;
        _balances[id][to] += amount;
        emit TransferSingle(msg.sender, from, to, id, amount);
        if (to.code.length > 0) {
            require(IERC1155Receiver(to).onERC1155Received(msg.sender, from, id, amount, data) == 0xf23a6e61, "unsafe receiver");
        }
    }

    function safeBatchTransferFrom(
        address from,
        address to,
        uint256[] calldata ids,
        uint256[] calldata amounts,
        bytes calldata data
    ) external {
        require(msg.sender == from || isApprovedForAll[from][msg.sender], "auth");
        require(to != address(0), "zero");
        require(ids.length == amounts.length, "length");
        for (uint256 i = 0; i < ids.length; i++) {
            require(_balances[ids[i]][from] >= amounts[i], "balance");
            _balances[ids[i]][from] -= amounts[i];
            _balances[ids[i]][to] += amounts[i];
        }
        emit TransferBatch(msg.sender, from, to, ids, amounts);
        if (to.code.length > 0) {
            require(
                IERC1155Receiver(to).onERC1155BatchReceived(msg.sender, from, ids, amounts, data) == 0xbc197c81,
                "unsafe receiver"
            );
        }
    }
}
