import {
  getAddress,
  parseTransaction,
  decodeFunctionData,
  recoverTransactionAddress,
  type TransactionSerialized,
} from "viem";
import type { VerifyResponse } from "@x402/core/types";
import {
  validateErc20ApprovalGasSponsoringInfo,
  type Erc20ApprovalGasSponsoringInfo,
} from "../exact/extensions";
import { PERMIT2_ADDRESS, erc20ApproveAbi } from "../constants";
import {
  ErrErc20ApprovalInvalidFormat,
  ErrErc20ApprovalFromMismatch,
  ErrErc20ApprovalAssetMismatch,
  ErrErc20ApprovalSpenderNotPermit2,
  ErrErc20ApprovalTxWrongTarget,
  ErrErc20ApprovalTxWrongSelector,
  ErrErc20ApprovalTxWrongSpender,
  ErrErc20ApprovalTxInvalidCalldata,
  ErrErc20ApprovalTxSignerMismatch,
  ErrErc20ApprovalTxInvalidSignature,
  ErrErc20ApprovalTxParseFailed,
} from "../exact/facilitator/errors";

/** The approve(address,uint256) function selector */
const APPROVE_SELECTOR = "0x095ea7b3";

export interface ParsedErc20ApprovalTransaction {
  from: `0x${string}`;
  to: `0x${string}` | null;
  data: `0x${string}`;
}

export type Erc20ApprovalTransactionParser = (
  signedTransaction: `0x${string}`,
  chainId: number,
) => ParsedErc20ApprovalTransaction | Promise<ParsedErc20ApprovalTransaction>;

/**
 * Validates ERC-20 approval extension data for a Permit2 payment.
 *
 * Performs comprehensive validation:
 * - Format validation via validateErc20ApprovalGasSponsoringInfo (JSON Schema)
 * - `from` matches payer
 * - `asset` matches token
 * - `spender` is PERMIT2_ADDRESS
 * - Transaction `to` matches token address
 * - Transaction calldata is a valid approve(PERMIT2_ADDRESS, ...) call
 * - Recovered transaction signer matches `from`
 *
 * @param info - The ERC-20 approval gas sponsoring info
 * @param payer - The expected payer address
 * @param tokenAddress - The expected token address
 * @param permit2Address - Trusted Permit2 deployment address
 * @param chainId - Expected EIP-155 chain ID
 * @param transactionParser - Optional parser for a network-native transaction encoding
 * @returns Validation result with invalidReason and invalidMessage on failure
 */
export async function validateErc20ApprovalForPayment(
  info: Erc20ApprovalGasSponsoringInfo,
  payer: `0x${string}`,
  tokenAddress: `0x${string}`,
  permit2Address: `0x${string}` = PERMIT2_ADDRESS,
  chainId?: number,
  transactionParser?: Erc20ApprovalTransactionParser,
): Promise<Pick<VerifyResponse, "isValid" | "invalidReason" | "invalidMessage">> {
  if (!validateErc20ApprovalGasSponsoringInfo(info)) {
    return {
      isValid: false,
      invalidReason: ErrErc20ApprovalInvalidFormat,
      invalidMessage: "ERC-20 approval extension info failed schema validation",
    };
  }

  if (getAddress(info.from) !== getAddress(payer)) {
    return {
      isValid: false,
      invalidReason: ErrErc20ApprovalFromMismatch,
      invalidMessage: `Expected from=${payer}, got ${info.from}`,
    };
  }

  if (getAddress(info.asset) !== tokenAddress) {
    return {
      isValid: false,
      invalidReason: ErrErc20ApprovalAssetMismatch,
      invalidMessage: `Expected asset=${tokenAddress}, got ${info.asset}`,
    };
  }

  if (getAddress(info.spender) !== getAddress(permit2Address)) {
    return {
      isValid: false,
      invalidReason: ErrErc20ApprovalSpenderNotPermit2,
      invalidMessage: `Expected spender=${permit2Address}, got ${info.spender}`,
    };
  }

  try {
    const serializedTx = info.signedTransaction as TransactionSerialized;
    let tx: { to?: `0x${string}` | null; data?: `0x${string}` };
    let parsedFrom: `0x${string}` | undefined;
    if (transactionParser) {
      if (chainId === undefined) {
        throw new Error("A chain ID is required with a custom transaction parser");
      }
      const parsed = await transactionParser(serializedTx, chainId);
      tx = parsed;
      parsedFrom = parsed.from;
    } else {
      tx = parseTransaction(serializedTx);
    }

    if (!tx.to || getAddress(tx.to) !== tokenAddress) {
      return {
        isValid: false,
        invalidReason: ErrErc20ApprovalTxWrongTarget,
        invalidMessage: `Transaction targets ${tx.to ?? "null"}, expected ${tokenAddress}`,
      };
    }

    const data = tx.data ?? "0x";
    if (!data.startsWith(APPROVE_SELECTOR)) {
      return {
        isValid: false,
        invalidReason: ErrErc20ApprovalTxWrongSelector,
        invalidMessage: `Transaction calldata does not start with approve() selector ${APPROVE_SELECTOR}`,
      };
    }

    try {
      const decoded = decodeFunctionData({
        abi: erc20ApproveAbi,
        data: data as `0x${string}`,
      });
      const calldataSpender = getAddress(decoded.args[0] as `0x${string}`);
      if (calldataSpender !== getAddress(permit2Address)) {
        return {
          isValid: false,
          invalidReason: ErrErc20ApprovalTxWrongSpender,
          invalidMessage: `approve() spender is ${calldataSpender}, expected Permit2 ${permit2Address}`,
        };
      }
    } catch {
      return {
        isValid: false,
        invalidReason: ErrErc20ApprovalTxInvalidCalldata,
        invalidMessage: "Failed to decode approve() calldata from the signed transaction",
      };
    }

    try {
      const recoveredAddress =
        parsedFrom ??
        (await recoverTransactionAddress({
          serializedTransaction: serializedTx,
        }));
      if (getAddress(recoveredAddress) !== getAddress(payer)) {
        return {
          isValid: false,
          invalidReason: ErrErc20ApprovalTxSignerMismatch,
          invalidMessage: `Transaction signed by ${recoveredAddress}, expected payer ${payer}`,
        };
      }
    } catch {
      return {
        isValid: false,
        invalidReason: ErrErc20ApprovalTxInvalidSignature,
        invalidMessage: "Failed to recover signer from the signed transaction",
      };
    }
  } catch {
    return {
      isValid: false,
      invalidReason: ErrErc20ApprovalTxParseFailed,
      invalidMessage: "Failed to parse the signed transaction",
    };
  }

  return { isValid: true };
}
