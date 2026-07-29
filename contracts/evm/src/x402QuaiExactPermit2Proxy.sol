// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";

interface IERC20PermitQuai {
    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;
}

/**
 * @notice Solidity 0.8.19 exact Permit2 proxy for Quai zone deployments.
 * @dev Its public ABI matches x402ExactPermit2Proxy. It uses a storage
 *      reentrancy guard because Quai deployment bytecode is compiled with
 *      Solidity 0.8.19 rather than the canonical proxy's transient guard.
 */
contract x402QuaiExactPermit2Proxy {
    string public constant WITNESS_TYPE_STRING =
        "Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)";
    bytes32 public constant WITNESS_TYPEHASH = keccak256("Witness(address to,uint256 validAfter)");

    ISignatureTransfer public immutable PERMIT2;
    uint256 private unlocked = 1;

    event Settled();
    event SettledWithPermit();
    event EIP2612PermitFailedWithReason(address indexed token, address indexed owner, string reason);
    event EIP2612PermitFailedWithPanic(address indexed token, address indexed owner, uint256 errorCode);
    event EIP2612PermitFailedWithData(address indexed token, address indexed owner, bytes data);

    error InvalidPermit2Address();
    error InvalidDestination();
    error PaymentTooEarly();
    error InvalidOwner();
    error InvalidAmount();
    error Permit2612AmountMismatch();
    error ReentrancyGuardReentrantCall();

    struct EIP2612Permit {
        uint256 value;
        uint256 deadline;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    struct Witness {
        address to;
        uint256 validAfter;
    }

    modifier nonReentrant() {
        if (unlocked != 1) revert ReentrancyGuardReentrantCall();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    constructor(
        address permit2
    ) {
        if (permit2 == address(0)) revert InvalidPermit2Address();
        PERMIT2 = ISignatureTransfer(permit2);
    }

    function settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external nonReentrant {
        _settle(permit, owner, witness, signature);
        emit Settled();
    }

    function settleWithPermit(
        EIP2612Permit calldata permit2612,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) external nonReentrant {
        _executePermit(permit.permitted.token, owner, permit2612, permit.permitted.amount);
        _settle(permit, owner, witness, signature);
        emit SettledWithPermit();
    }

    function _settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address owner,
        Witness calldata witness,
        bytes calldata signature
    ) private {
        if (permit.permitted.amount == 0) revert InvalidAmount();
        if (owner == address(0)) revert InvalidOwner();
        if (witness.to == address(0)) revert InvalidDestination();
        if (block.timestamp < witness.validAfter) revert PaymentTooEarly();

        ISignatureTransfer.SignatureTransferDetails memory details =
            ISignatureTransfer.SignatureTransferDetails({to: witness.to, requestedAmount: permit.permitted.amount});
        bytes32 witnessHash = keccak256(abi.encode(WITNESS_TYPEHASH, witness.to, witness.validAfter));
        PERMIT2.permitWitnessTransferFrom(permit, details, owner, witnessHash, WITNESS_TYPE_STRING, signature);
    }

    function _executePermit(
        address token,
        address owner,
        EIP2612Permit calldata permit2612,
        uint256 amount
    ) private {
        if (permit2612.value != amount) revert Permit2612AmountMismatch();
        try IERC20PermitQuai(token)
            .permit(
                owner, address(PERMIT2), permit2612.value, permit2612.deadline, permit2612.v, permit2612.r, permit2612.s
            ) {}
        catch Error(string memory reason) {
            emit EIP2612PermitFailedWithReason(token, owner, reason);
        } catch Panic(uint256 errorCode) {
            emit EIP2612PermitFailedWithPanic(token, owner, errorCode);
        } catch (bytes memory data) {
            emit EIP2612PermitFailedWithData(token, owner, data);
        }
    }
}
