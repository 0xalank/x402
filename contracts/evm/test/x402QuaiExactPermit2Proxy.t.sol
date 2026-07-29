// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {x402ExactPermit2Proxy} from "../src/x402ExactPermit2Proxy.sol";
import {x402QuaiExactPermit2Proxy} from "../src/x402QuaiExactPermit2Proxy.sol";
import {MockPermit2} from "./mocks/MockPermit2.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MockERC20Permit} from "./mocks/MockERC20Permit.sol";

contract X402QuaiExactPermit2ProxyTest is Test {
    MockPermit2 private permit2;
    x402QuaiExactPermit2Proxy private proxy;
    address private payer;
    address private recipient;

    function setUp() public {
        vm.warp(1_000_000);
        payer = makeAddr("payer");
        recipient = makeAddr("recipient");
        permit2 = new MockPermit2();
        proxy = new x402QuaiExactPermit2Proxy(address(permit2));
        permit2.setShouldActuallyTransfer(true);
    }

    function test_settleTransfersExactAmount() public {
        MockERC20 token = new MockERC20("Token", "TKN", 18);
        token.mint(payer, 10 ether);
        vm.prank(payer);
        token.approve(address(permit2), type(uint256).max);

        proxy.settle(_permit(address(token), 1 ether), payer, _witness(), _signature());

        assertEq(token.balanceOf(recipient), 1 ether);
    }

    function test_publicSettlementSelectorsMatchCanonicalProxy() public pure {
        assertEq(x402QuaiExactPermit2Proxy.settle.selector, x402ExactPermit2Proxy.settle.selector);
        assertEq(x402QuaiExactPermit2Proxy.settleWithPermit.selector, x402ExactPermit2Proxy.settleWithPermit.selector);
    }

    function test_settleWithPermitApprovesAndTransfersAtomically() public {
        MockERC20Permit token = new MockERC20Permit("Permit", "PMT", 18);
        token.mint(payer, 10 ether);
        x402QuaiExactPermit2Proxy.EIP2612Permit memory approval = x402QuaiExactPermit2Proxy.EIP2612Permit({
            value: 1 ether, deadline: block.timestamp + 60, r: bytes32(uint256(1)), s: bytes32(uint256(2)), v: 27
        });

        proxy.settleWithPermit(approval, _permit(address(token), 1 ether), payer, _witness(), _signature());

        assertEq(token.balanceOf(recipient), 1 ether);
    }

    function test_settleWithPermitRejectsAmountMismatch() public {
        MockERC20Permit token = new MockERC20Permit("Permit", "PMT", 18);
        x402QuaiExactPermit2Proxy.EIP2612Permit memory approval = x402QuaiExactPermit2Proxy.EIP2612Permit({
            value: 2 ether, deadline: block.timestamp + 60, r: bytes32(uint256(1)), s: bytes32(uint256(2)), v: 27
        });

        vm.expectRevert(x402QuaiExactPermit2Proxy.Permit2612AmountMismatch.selector);
        proxy.settleWithPermit(approval, _permit(address(token), 1 ether), payer, _witness(), _signature());
    }

    function _permit(
        address token,
        uint256 amount
    ) private view returns (ISignatureTransfer.PermitTransferFrom memory) {
        return ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: token, amount: amount}),
            nonce: 1,
            deadline: block.timestamp + 60
        });
    }

    function _witness() private view returns (x402QuaiExactPermit2Proxy.Witness memory) {
        return x402QuaiExactPermit2Proxy.Witness({to: recipient, validAfter: block.timestamp - 1});
    }

    function _signature() private pure returns (bytes memory) {
        return abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));
    }
}
