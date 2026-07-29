// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/**
 * @title x402NativeQuaiEscrow
 * @notice EIP-3009-compatible authorizations over deposited native QUAI.
 * @dev Deploy one instance per Quai zone. A facilitator calls
 *      transferWithAuthorization and pays gas; the payer controls the exact
 *      destination and value through EIP-712.
 */
contract x402NativeQuaiEscrow {
    string public constant name = "x402 Native QUAI";
    string public constant version = "1";

    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    uint256 private constant SECP256K1_HALF_N = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    mapping(address => uint256) private balances;
    mapping(address => mapping(bytes32 => bool)) private used;
    uint256 private unlocked = 1;

    event Deposit(address indexed account, uint256 value);
    event Withdrawal(address indexed account, uint256 value);
    event Transfer(address indexed from, address indexed to, uint256 value);
    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    error AuthorizationExpired();
    error AuthorizationNotYetValid();
    error AuthorizationAlreadyUsed();
    error InvalidSignature();
    error InsufficientBalance();
    error NativeTransferFailed();
    error ReentrantCall();
    error ZeroAddress();
    error ZeroValue();

    modifier nonReentrant() {
        if (unlocked != 1) revert ReentrantCall();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    receive() external payable {
        _deposit(msg.sender);
    }

    function deposit() external payable {
        _deposit(msg.sender);
    }

    function depositFor(
        address account
    ) external payable {
        if (account == address(0)) revert ZeroAddress();
        _deposit(account);
    }

    function withdraw(
        uint256 value
    ) external nonReentrant {
        if (value == 0) revert ZeroValue();
        uint256 balance = balances[msg.sender];
        if (balance < value) revert InsufficientBalance();
        unchecked {
            balances[msg.sender] = balance - value;
        }
        (bool success,) = payable(msg.sender).call{value: value}("");
        if (!success) revert NativeTransferFailed();
        emit Withdrawal(msg.sender, value);
    }

    function balanceOf(
        address account
    ) external view returns (uint256) {
        return balances[account];
    }

    function authorizationState(
        address authorizer,
        bytes32 nonce
    ) external view returns (bool) {
        return used[authorizer][nonce];
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _transfer(from, to, value, validAfter, validBefore, nonce, v, r, s);
    }

    function transferWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external nonReentrant {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        _transfer(from, to, value, validAfter, validBefore, nonce, v, r, s);
    }

    function _deposit(
        address account
    ) private {
        if (msg.value == 0) revert ZeroValue();
        balances[account] += msg.value;
        emit Deposit(account, msg.value);
    }

    function _transfer(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) private {
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        if (value == 0) revert ZeroValue();
        if (block.timestamp < validAfter) revert AuthorizationNotYetValid();
        if (block.timestamp >= validBefore) revert AuthorizationExpired();
        if (used[from][nonce]) revert AuthorizationAlreadyUsed();
        if (v < 27) v += 27;
        if (v > 28 || uint256(s) > SECP256K1_HALF_N) revert InvalidSignature();

        bytes32 structHash = keccak256(abi.encode(TRANSFER_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this))
        );
        if (ecrecover(keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)), v, r, s) != from) {
            revert InvalidSignature();
        }

        uint256 balance = balances[from];
        if (balance < value) revert InsufficientBalance();
        used[from][nonce] = true;
        unchecked {
            balances[from] = balance - value;
        }
        (bool success,) = payable(to).call{value: value}("");
        if (!success) revert NativeTransferFailed();
        emit AuthorizationUsed(from, nonce);
        emit Transfer(from, to, value);
    }
}
