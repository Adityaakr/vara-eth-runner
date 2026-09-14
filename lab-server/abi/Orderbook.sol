// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;

interface IOrderbook {
    event Cancelled(uint64 indexed id, uint64 seq);

    event Filled(uint64 indexed taker, uint64 indexed maker, uint64 seq, uint64 price, uint64 qty);

    event Placed(uint64 indexed id, uint64 seq, address owner, uint32 side, uint64 price, uint64 qty);

    function create(bool _callReply) external returns (bytes32 messageId);

    function bookCancel(bool _callReply, uint64 id) external returns (bytes32 messageId);

    function bookPlace(bool _callReply, uint32 side, uint64 price, uint64 qty) external returns (bytes32 messageId);

    function bookSeq(bool _callReply) external returns (bytes32 messageId);
}

contract OrderbookAbi is IOrderbook {
    function create(bool _callReply) external returns (bytes32 messageId) {}

    function bookCancel(bool _callReply, uint64 id) external returns (bytes32 messageId) {}

    function bookPlace(bool _callReply, uint32 side, uint64 price, uint64 qty) external returns (bytes32 messageId) {}

    function bookSeq(bool _callReply) external returns (bytes32 messageId) {}
}

interface IOrderbookCallbacks {
    function replyOn_create(bytes32 messageId) external;

    function replyOn_bookCancel(bytes32 messageId, bool reply) external;

    function replyOn_bookPlace(bytes32 messageId, uint64 reply) external;

    function replyOn_bookSeq(bytes32 messageId, uint64 reply) external;

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable;
}

contract OrderbookCaller is IOrderbookCallbacks {
    IOrderbook public immutable VARA_ETH_PROGRAM;

    error UnauthorizedCaller();

    constructor(IOrderbook _varaEthProgram) {
        VARA_ETH_PROGRAM = _varaEthProgram;
    }

    modifier onlyVaraEthProgram() {
        _onlyVaraEthProgram();
        _;
    }

    function _onlyVaraEthProgram() internal view {
        if (msg.sender != address(VARA_ETH_PROGRAM)) {
            revert UnauthorizedCaller();
        }
    }

    function replyOn_create(bytes32 messageId) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_bookCancel(bytes32 messageId, bool reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_bookPlace(bytes32 messageId, uint64 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function replyOn_bookSeq(bytes32 messageId, uint64 reply) external onlyVaraEthProgram {
        // TODO: implement this
    }

    function onErrorReply(bytes32 messageId, bytes calldata payload, bytes4 replyCode) external payable onlyVaraEthProgram {
        // TODO: implement this
    }
}
