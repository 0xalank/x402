import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import type { ClientQuaiSigner } from "../../types";
import { isQuaiAsset, isQuaiNetwork } from "../../utils";

/**
 * Client implementation of exact native Quai payments.
 */
export class ExactQuaiScheme implements SchemeNetworkClient {
  readonly scheme = "exact";

  /**
   * Creates a Quai exact client.
   *
   * @param signer - Native Quai payment signer
   */
  constructor(private readonly signer: ClientQuaiSigner) {}

  /**
   * Creates a signed payment payload.
   *
   * @param x402Version - Protocol version
   * @param requirements - Resource payment requirements
   * @returns Signed payload
   */
  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    if (requirements.scheme !== this.scheme) throw new Error("Unsupported scheme");
    if (!isQuaiNetwork(requirements.network)) throw new Error("Unsupported Quai network");
    if (!isQuaiAsset(requirements.asset)) throw new Error("Unsupported Quai asset");

    if (requirements.extra?.areFeesSponsored === true) {
      if (!this.signer.signSponsoredPayment) {
        throw new Error("No sponsored QUAI signer configured");
      }
      return {
        x402Version,
        payload: await this.signer.signSponsoredPayment(x402Version, requirements),
      };
    }

    return {
      x402Version,
      payload: { signedTransaction: await this.signer.signPayment(requirements) },
    };
  }
}
