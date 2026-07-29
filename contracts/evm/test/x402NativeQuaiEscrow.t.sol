// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {x402NativeQuaiEscrow} from "../src/x402NativeQuaiEscrow.sol";

contract X402NativeQuaiEscrowTest is Test {
    uint256 private constant SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    x402NativeQuaiEscrow private escrow;
    uint256 private payerKey = 0xA11CE;
    address private payer;
    address private recipient = makeAddr("recipient");

    function setUp() public {
        vm.chainId(9);
        vm.warp(1_000_000);
        payer = vm.addr(payerKey);
        escrow = new x402NativeQuaiEscrow();
        vm.deal(payer, 10 ether);
        vm.prank(payer);
        escrow.deposit{value: 2 ether}();
    }

    function test_transferWithAuthorizationIsExactAndPermissionless() public {
        bytes32 nonce = keccak256("payment");
        (uint8 v, bytes32 r, bytes32 s) = _sign(recipient, 1 ether, nonce);

        vm.prank(makeAddr("facilitator"));
        escrow.transferWithAuthorization(
            payer, recipient, 1 ether, block.timestamp - 1, block.timestamp + 60, nonce, v, r, s
        );

        assertEq(recipient.balance, 1 ether);
        assertEq(escrow.balanceOf(payer), 1 ether);
        assertTrue(escrow.authorizationState(payer, nonce));
    }

    function test_rejectsReplay() public {
        bytes32 nonce = keccak256("payment");
        (uint8 v, bytes32 r, bytes32 s) = _sign(recipient, 1 ether, nonce);
        escrow.transferWithAuthorization(
            payer, recipient, 1 ether, block.timestamp - 1, block.timestamp + 60, nonce, v, r, s
        );

        vm.expectRevert(x402NativeQuaiEscrow.AuthorizationAlreadyUsed.selector);
        escrow.transferWithAuthorization(
            payer, recipient, 1 ether, block.timestamp - 1, block.timestamp + 60, nonce, v, r, s
        );
    }

    function test_rejectsChangedDestination() public {
        bytes32 nonce = keccak256("payment");
        (uint8 v, bytes32 r, bytes32 s) = _sign(recipient, 1 ether, nonce);

        vm.expectRevert(x402NativeQuaiEscrow.InvalidSignature.selector);
        escrow.transferWithAuthorization(
            payer, makeAddr("attacker"), 1 ether, block.timestamp - 1, block.timestamp + 60, nonce, v, r, s
        );
    }

    function test_rejectsMalleableHighSSignature() public {
        bytes32 nonce = keccak256("high-s");
        (uint8 v, bytes32 r, bytes32 s) = _sign(recipient, 1 ether, nonce);

        vm.expectRevert(x402NativeQuaiEscrow.InvalidSignature.selector);
        escrow.transferWithAuthorization(
            payer,
            recipient,
            1 ether,
            block.timestamp - 1,
            block.timestamp + 60,
            nonce,
            v == 27 ? 28 : 27,
            r,
            bytes32(SECP256K1_N - uint256(s))
        );
    }

    function test_ownerCanWithdrawUnusedBalance() public {
        vm.prank(payer);
        escrow.withdraw(2 ether);

        assertEq(escrow.balanceOf(payer), 0);
        assertEq(payer.balance, 10 ether);
    }

    function _sign(
        address to,
        uint256 value,
        bytes32 nonce
    ) private view returns (uint8 v, bytes32 r, bytes32 s) {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("x402 Native QUAI")),
                keccak256(bytes("1")),
                block.chainid,
                address(escrow)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(TRANSFER_TYPEHASH, payer, to, value, block.timestamp - 1, block.timestamp + 60, nonce)
        );
        return vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
    }
}
