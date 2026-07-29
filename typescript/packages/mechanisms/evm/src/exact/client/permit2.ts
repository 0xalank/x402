import { PaymentRequirements, PaymentPayloadResult } from "@x402/core/types";
import { encodeFunctionData, getAddress } from "viem";
import {
  PERMIT2_ADDRESS,
  x402ExactPermit2ProxyAddress,
  erc20ApproveAbi,
  erc20AllowanceAbi,
} from "../../constants";
import type { ExactEvmContractAddresses } from "../../contracts";
import { ClientEvmSigner } from "../../signer";
import { createPermit2PayloadForProxy } from "../../shared/permit2";

/** Maximum uint256 value for unlimited approval. */
const MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");

/**
 * Creates a Permit2 payload using the x402Permit2Proxy witness pattern.
 * The spender is set to x402Permit2Proxy, which enforces that funds
 * can only be sent to the witness.to address.
 *
 * @param signer - The EVM signer for client operations
 * @param x402Version - The x402 protocol version
 * @param paymentRequirements - The payment requirements
 * @param contracts - Trusted Permit2 deployment addresses
 * @returns Promise resolving to a payment payload result
 */
export async function createPermit2Payload(
  signer: ClientEvmSigner,
  x402Version: number,
  paymentRequirements: PaymentRequirements,
  contracts: ExactEvmContractAddresses = {
    permit2: PERMIT2_ADDRESS,
    exactPermit2Proxy: x402ExactPermit2ProxyAddress,
  },
): Promise<PaymentPayloadResult> {
  return createPermit2PayloadForProxy(
    contracts.exactPermit2Proxy,
    signer,
    x402Version,
    paymentRequirements,
    contracts.permit2,
  );
}

/**
 * Creates transaction data to approve Permit2 to spend tokens.
 * The user sends this transaction (paying gas) before using Permit2 flow.
 *
 * @param tokenAddress - The ERC20 token contract address
 * @param permit2Address - Trusted Permit2 deployment address
 * @returns Transaction data to send for approval
 *
 * @example
 * ```typescript
 * const tx = createPermit2ApprovalTx("0x...");
 * await walletClient.sendTransaction({
 *   to: tx.to,
 *   data: tx.data,
 * });
 * ```
 */
export function createPermit2ApprovalTx(
  tokenAddress: `0x${string}`,
  permit2Address: `0x${string}` = PERMIT2_ADDRESS,
): {
  to: `0x${string}`;
  data: `0x${string}`;
} {
  const data = encodeFunctionData({
    abi: erc20ApproveAbi,
    functionName: "approve",
    args: [permit2Address, MAX_UINT256],
  });

  return {
    to: getAddress(tokenAddress),
    data,
  };
}

/**
 * Parameters for checking Permit2 allowance.
 * Application provides these to check if approval is needed.
 */
export interface Permit2AllowanceParams {
  tokenAddress: `0x${string}`;
  ownerAddress: `0x${string}`;
  permit2Address?: `0x${string}`;
}

/**
 * Returns contract read parameters for checking Permit2 allowance.
 * Use with a public client to check if the user has approved Permit2.
 *
 * @param params - The allowance check parameters
 * @returns Contract read parameters for checking allowance
 *
 * @example
 * ```typescript
 * const readParams = getPermit2AllowanceReadParams({
 *   tokenAddress: "0x...",
 *   ownerAddress: "0x...",
 * });
 *
 * const allowance = await publicClient.readContract(readParams);
 * const needsApproval = allowance < requiredAmount;
 * ```
 */
export function getPermit2AllowanceReadParams(params: Permit2AllowanceParams): {
  address: `0x${string}`;
  abi: typeof erc20AllowanceAbi;
  functionName: "allowance";
  args: [`0x${string}`, `0x${string}`];
} {
  return {
    address: getAddress(params.tokenAddress),
    abi: erc20AllowanceAbi,
    functionName: "allowance",
    args: [getAddress(params.ownerAddress), getAddress(params.permit2Address ?? PERMIT2_ADDRESS)],
  };
}
