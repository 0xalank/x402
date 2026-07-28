import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SupportedKind,
} from "@x402/core/types";
import { QI_ASSET, QUAI_ASSET } from "../../constants";
import {
  getQiDenominationIndex,
  isQuaiAsset,
  isQuaiNetwork,
  parsePositiveAmount,
  requireAssetAddress,
} from "../../utils";

/**
 * Resource-server implementation of exact native Quai payments.
 */
export class ExactQuaiScheme implements SchemeNetworkServer {
  readonly scheme = "exact";

  /**
   * Parses explicit QUAI or QI pricing.
   *
   * @param price - Resource price
   * @param network - Quai network
   * @returns Native asset amount
   */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (!isQuaiNetwork(network)) throw new Error(`Unsupported Quai network: ${network}`);
    if (typeof price !== "object" || price === null || !("amount" in price)) {
      throw new Error("Quai exact payments require explicit AssetAmount pricing");
    }
    const amount = {
      amount: price.amount,
      asset: price.asset,
      extra: price.extra ?? {},
    };
    this.validateAssetAmount(amount);
    return amount;
  }

  /**
   * Adds the payer-funded fee policy and validates the destination ledger.
   *
   * @param requirements - Base requirements
   * @param _supportedKind - Facilitator capability
   * @param _extensionKeys - Facilitator extensions
   * @returns Enhanced requirements
   */
  enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _extensionKeys: string[],
  ): Promise<PaymentRequirements> {
    if (!isQuaiAsset(requirements.asset)) throw new Error("Unsupported Quai asset");
    requireAssetAddress(requirements.payTo, requirements.asset);
    return Promise.resolve({
      ...requirements,
      extra: { ...requirements.extra, areFeesSponsored: false },
    });
  }

  /**
   * Validates native asset and atomic amount.
   *
   * @param amount - Parsed asset amount
   * @returns Nothing
   */
  private validateAssetAmount(amount: AssetAmount): void {
    if (!isQuaiAsset(amount.asset)) {
      throw new Error(`Quai exact payments require ${QUAI_ASSET} or ${QI_ASSET}`);
    }
    const value = parsePositiveAmount(amount.amount);
    if (amount.asset === QI_ASSET) getQiDenominationIndex(value);
  }
}
