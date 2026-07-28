import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import {
  N,
  denominations,
  getZoneForAddress,
  isQiAddress,
  isQuaiAddress,
  toShard,
  type Provider,
  type QiTransaction,
  type QuaiTransaction,
  type Zone,
} from "quais";
import { QI_ASSET, QUAI_ASSET, QUAI_CAIP_FAMILY, QUAI_TRANSACTION_TYPE } from "../../constants";
import { InMemoryQuaiSettlementStore } from "../../settlement-store";
import type {
  QuaiFacilitatorOptions,
  QuaiSettlementClaim,
  QuaiSettlementStore,
  QuaiSubmissionResult,
} from "../../types";
import {
  decodeSignedPayment,
  getExactQuaiPayload,
  isQuaiAsset,
  isQuaiNetwork,
  parsePositiveAmount,
  parseQuaiChainId,
  qiAddressFromPublicKey,
  requireAssetAddress,
  resolveProvider,
  toQiFeeRequest,
  verifyQiSignature,
  type DecodedQuaiPayment,
} from "../../utils";

/**
 * Facilitator implementation of exact native Quai payments.
 */
export class ExactQuaiScheme implements SchemeNetworkFacilitator {
  readonly caipFamily = QUAI_CAIP_FAMILY;
  readonly scheme = "exact";

  /**
   * Creates a Quai exact facilitator.
   *
   * @param options - Provider and submission configuration
   * @param settlementStore - Atomic duplicate-settlement store
   */
  constructor(
    private readonly options: QuaiFacilitatorOptions,
    private readonly settlementStore: QuaiSettlementStore = new InMemoryQuaiSettlementStore(),
  ) {}

  /**
   * Advertises payer-funded fees.
   *
   * @param _network - Quai network
   * @returns Scheme metadata
   */
  getExtra(_network: Network): Record<string, unknown> {
    return { areFeesSponsored: false };
  }

  /**
   * Returns no facilitator signers because the payer funds fees.
   *
   * @param _network - Quai network
   * @returns Empty signer list
   */
  getSigners(_network: string): string[] {
    return [];
  }

  /**
   * Verifies a signed native Quai payment without submitting it.
   *
   * @param payload - x402 payload
   * @param requirements - Expected payment
   * @returns Verification result
   */
  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    return this.verifyPayment(payload, requirements, true);
  }

  /**
   * Re-verifies, submits, and waits for inclusion.
   *
   * @param payload - x402 payload
   * @param requirements - Expected payment
   * @returns Settlement result
   */
  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const verification = await this.verify(payload, requirements);
    if (!verification.isValid) {
      if (verification.invalidReason === "invalid_exact_quai_transaction_state") {
        const reconciled = await this.reconcileRetryable(payload, requirements);
        if (reconciled) return reconciled;
      }
      return failedSettlement(payload, verification);
    }

    const asset = requirements.asset;
    if (!isQuaiAsset(asset))
      return failedSettlement(payload, invalidVerify("invalid_exact_quai_asset"));
    const signed = getExactQuaiPayload(payload).signedTransaction;
    const decoded = decodeSignedPayment(signed, asset);
    const hash = decoded.transaction.hash!;

    const claim = await this.settlementStore.reserve(hash);
    if (!claim) {
      return failedSettlement(payload, invalidVerify("duplicate_settlement"));
    }

    const finalVerification = await this.verifyPayment(payload, requirements, false);
    if (!finalVerification.isValid) {
      await this.settlementStore.release(claim);
      return failedSettlement(payload, finalVerification);
    }

    try {
      await this.submitAndConfirm(decoded, signed, requirements);
      if (!(await this.settlementStore.markSettled(claim))) {
        throw new Error("Settlement ownership was lost");
      }
      return successfulSettlement(hash, requirements.network, finalVerification.payer);
    } catch (error) {
      if (error instanceof QuaiTransactionExecutionError) {
        await this.settlementStore.markSettled(claim);
      } else {
        await this.settlementStore.markRetryable(claim);
      }
      return settlementFailure(hash, requirements.network, finalVerification.payer, error);
    }
  }

  private async reconcileRetryable(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse | undefined> {
    let claim: QuaiSettlementClaim | undefined;
    let hash = "";
    let payer: string | undefined;
    try {
      if (!isQuaiAsset(requirements.asset)) return undefined;
      const decoded = decodeSignedPayment(
        getExactQuaiPayload(payload).signedTransaction,
        requirements.asset,
      );
      hash = decoded.transaction.hash!;
      payer = decoded.asset === QUAI_ASSET ? decoded.transaction.from : undefined;
      if (!matchesRequirements(decoded, requirements)) {
        return undefined;
      }
      claim = await this.settlementStore.resume(hash);
      if (!claim) return undefined;

      const provider = resolveProvider(this.options.provider, requirements.network);
      let included: boolean;
      if (decoded.asset === QUAI_ASSET) {
        const receipt = await provider.getTransactionReceipt(hash);
        if (receipt?.status === 0) {
          await this.settlementStore.markSettled(claim);
          return settlementFailure(hash, requirements.network, decoded.transaction.from);
        }
        included = receipt?.status === 1;
      } else {
        included = (await provider.getTransaction(hash))?.blockNumber != null;
      }
      if (!included) {
        await this.submitAndConfirm(
          decoded,
          getExactQuaiPayload(payload).signedTransaction,
          requirements,
        );
      }

      if (!(await this.settlementStore.markSettled(claim))) {
        throw new Error("Settlement ownership was lost");
      }
      return successfulSettlement(hash, requirements.network, payer);
    } catch (error) {
      if (claim) {
        if (error instanceof QuaiTransactionExecutionError) {
          await this.settlementStore.markSettled(claim);
        } else {
          await this.settlementStore.markRetryable(claim);
        }
      }
      return settlementFailure(hash, requirements.network, payer, error);
    }
  }

  private async submitAndConfirm(
    decoded: DecodedQuaiPayment,
    signed: string,
    requirements: PaymentRequirements,
  ): Promise<void> {
    const zone =
      decoded.asset === QUAI_ASSET
        ? getZoneForAddress(decoded.transaction.from!)
        : decoded.transaction.originZone;
    if (!zone) throw new Error("Unable to resolve origin zone");
    const timeout = requirements.maxTimeoutSeconds * 1000;
    const result = this.options.submitSignedTransaction
      ? await this.options.submitSignedTransaction(signed, requirements.network, zone, timeout)
      : await this.submitWithProvider(signed, requirements.network, zone, timeout);
    if (!result.included || result.hash.toLowerCase() !== decoded.transaction.hash!.toLowerCase()) {
      throw new Error("Transaction was not included with the expected hash");
    }
  }

  private async verifyPayment(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    checkSettlementState: boolean,
  ): Promise<VerifyResponse> {
    try {
      const envelopeError = this.verifyEnvelope(payload, requirements);
      if (envelopeError) return invalidVerify(envelopeError);

      const asset = requirements.asset;
      if (!isQuaiAsset(asset)) return invalidVerify("invalid_exact_quai_asset");
      const signedTransaction = getExactQuaiPayload(payload).signedTransaction;
      const decoded = decodeSignedPayment(signedTransaction, asset);
      const provider = resolveProvider(this.options.provider, requirements.network);

      const network = await provider.getNetwork();
      if (network.chainId !== parseQuaiChainId(requirements.network)) {
        return invalidVerify("invalid_exact_quai_network");
      }

      const hash = decoded.transaction.hash;
      if (!hash) return invalidVerify("invalid_exact_quai_signature");
      if (checkSettlementState && (await this.settlementStore.getStatus(hash)) !== "none") {
        return invalidVerify("invalid_exact_quai_transaction_state");
      }

      return decoded.asset === QUAI_ASSET
        ? await this.verifyQuai(decoded.transaction, requirements, provider)
        : await this.verifyQi(decoded.transaction, requirements, provider);
    } catch (error) {
      return invalidVerify(
        "invalid_exact_quai_facilitator_error",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private verifyEnvelope(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): string | undefined {
    if (payload.x402Version !== 2) return "invalid_x402_version";
    if (payload.accepted.scheme !== this.scheme || requirements.scheme !== this.scheme) {
      return "unsupported_scheme";
    }
    if (!isQuaiNetwork(payload.accepted.network) || !isQuaiNetwork(requirements.network)) {
      return "invalid_exact_quai_network";
    }
    if (payload.accepted.network !== requirements.network) return "invalid_exact_quai_network";
    if (payload.accepted.asset !== requirements.asset) return "invalid_exact_quai_asset";
    if (payload.accepted.amount !== requirements.amount) return "invalid_exact_quai_amount";
    if (payload.accepted.payTo.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return "invalid_exact_quai_destination";
    }
    if (payload.accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds) {
      return "invalid_exact_quai_timeout";
    }
    if (
      payload.accepted.extra?.areFeesSponsored !== false ||
      requirements.extra?.areFeesSponsored !== false
    ) {
      return "invalid_exact_quai_fees_sponsored";
    }
    return undefined;
  }

  private async verifyQuai(
    transaction: QuaiTransaction,
    requirements: PaymentRequirements,
    provider: Provider,
  ): Promise<VerifyResponse> {
    if (
      transaction.type !== QUAI_TRANSACTION_TYPE ||
      !transaction.signature ||
      !transaction.from ||
      !transaction.to ||
      BigInt(transaction.signature.s) > N / 2n
    ) {
      return invalidVerify("invalid_exact_quai_transaction_type");
    }
    if (!isQuaiAddress(transaction.from) || !isQuaiAddress(transaction.to)) {
      return invalidVerify("invalid_exact_quai_destination");
    }
    const originZone = getZoneForAddress(transaction.from);
    if (!originZone || getZoneForAddress(transaction.to) !== originZone) {
      return invalidVerify("invalid_exact_quai_zone");
    }
    if (transaction.to.toLowerCase() !== requirements.payTo.toLowerCase()) {
      return invalidVerify("invalid_exact_quai_destination");
    }
    if (transaction.value !== parsePositiveAmount(requirements.amount)) {
      return invalidVerify("invalid_exact_quai_amount");
    }
    if (transaction.chainId !== parseQuaiChainId(requirements.network)) {
      return invalidVerify("invalid_exact_quai_network");
    }
    if (transaction.data !== "0x") return invalidVerify("invalid_exact_quai_transaction_state");

    const [nonce, balance, feeData] = await Promise.all([
      provider.getTransactionCount(transaction.from, "pending"),
      provider.getBalance(transaction.from, "pending"),
      provider.getFeeData(originZone, true),
    ]);
    if (transaction.nonce !== nonce) return invalidVerify("invalid_exact_quai_nonce");
    if (
      transaction.gasPrice === null ||
      feeData.gasPrice === null ||
      transaction.gasPrice < feeData.gasPrice
    ) {
      return invalidVerify("invalid_exact_quai_fee");
    }
    if (balance < transaction.value + transaction.gasLimit * transaction.gasPrice) {
      return invalidVerify("invalid_exact_quai_balance");
    }

    const call = {
      type: transaction.type,
      chainId: transaction.chainId,
      from: transaction.from,
      to: transaction.to,
      value: transaction.value,
      data: transaction.data,
      gasLimit: transaction.gasLimit,
      gasPrice: transaction.gasPrice,
      accessList: transaction.accessList,
    };
    const estimatedGas = await provider.estimateGas(call);
    if (transaction.gasLimit < estimatedGas) return invalidVerify("invalid_exact_quai_fee");
    await provider.call(call);

    return { isValid: true, payer: transaction.from };
  }

  private async verifyQi(
    transaction: QiTransaction,
    requirements: PaymentRequirements,
    provider: Provider,
  ): Promise<VerifyResponse> {
    if (
      transaction.type !== 2 ||
      transaction.chainId !== parseQuaiChainId(requirements.network) ||
      transaction.txInputs.length === 0 ||
      transaction.txOutputs.length === 0 ||
      transaction.data.length !== 0 ||
      !verifyQiSignature(transaction)
    ) {
      return invalidVerify("invalid_exact_quai_signature");
    }

    const payToZone = requireAssetAddress(requirements.payTo, QI_ASSET);
    const inputKeys = new Set<string>();
    const inputAddresses: string[] = [];
    for (const input of transaction.txInputs) {
      const key = `${input.txhash.toLowerCase()}:${input.index}`;
      if (inputKeys.has(key)) return invalidVerify("invalid_exact_quai_input");
      inputKeys.add(key);
      const address = qiAddressFromPublicKey(input.pubkey);
      if (getZoneForAddress(address) !== payToZone) return invalidVerify("invalid_exact_quai_zone");
      inputAddresses.push(address);
    }

    const addressKeys = new Set(inputAddresses.map(address => address.toLowerCase()));
    let paymentOutputs = 0;
    let outputValue = 0n;
    for (const output of transaction.txOutputs) {
      if (
        !Number.isInteger(output.denomination) ||
        output.denomination < 0 ||
        output.denomination >= denominations.length ||
        (output.lock !== undefined && output.lock !== "" && output.lock !== "0x")
      ) {
        return invalidVerify("invalid_exact_quai_output");
      }
      if (!isQiAddress(output.address) || getZoneForAddress(output.address) !== payToZone) {
        return invalidVerify("invalid_exact_quai_zone");
      }
      const address = output.address.toLowerCase();
      if (addressKeys.has(address)) return invalidVerify("invalid_exact_quai_output");
      addressKeys.add(address);
      outputValue += denominations[output.denomination];
      if (address === requirements.payTo.toLowerCase()) {
        paymentOutputs++;
        if (denominations[output.denomination] !== parsePositiveAmount(requirements.amount)) {
          return invalidVerify("invalid_exact_quai_amount");
        }
      }
    }
    if (paymentOutputs !== 1) return invalidVerify("invalid_exact_quai_destination");

    const [outpointsByAddress, blockNumber] = await Promise.all([
      provider.getOutpointsByAddresses(inputAddresses),
      provider.getBlockNumber(toShard(payToZone)),
    ]);
    let inputValue = 0n;
    for (let index = 0; index < transaction.txInputs.length; index++) {
      const input = transaction.txInputs[index];
      const address = inputAddresses[index];
      const outpoints =
        outpointsByAddress.get(address) ??
        [...outpointsByAddress.entries()].find(
          ([candidate]) => candidate.toLowerCase() === address.toLowerCase(),
        )?.[1] ??
        [];
      const outpoint = outpoints.find(
        candidate =>
          candidate.txhash.toLowerCase() === input.txhash.toLowerCase() &&
          candidate.index === input.index,
      );
      if (
        !outpoint ||
        outpoint.denomination < 0 ||
        outpoint.denomination >= denominations.length ||
        (outpoint.lock ?? 0) > blockNumber
      ) {
        return invalidVerify("invalid_exact_quai_input");
      }
      inputValue += denominations[outpoint.denomination];
    }
    if (outputValue > inputValue) return invalidVerify("invalid_exact_quai_amount");

    const minimumFee = await provider.estimateFeeForQi(toQiFeeRequest(transaction));
    if (inputValue - outputValue < minimumFee) return invalidVerify("invalid_exact_quai_fee");
    return { isValid: true };
  }

  private async submitWithProvider(
    signed: string,
    network: Network,
    zone: Zone,
    timeoutMs: number,
  ): Promise<QuaiSubmissionResult> {
    const provider = resolveProvider(this.options.provider, network);
    const response = await provider.broadcastTransaction(zone, signed);
    const confirmation = await response.wait(1, timeoutMs);
    if (confirmation !== null && "status" in confirmation && confirmation.status === 0) {
      throw new QuaiTransactionExecutionError("Transaction was included but execution failed");
    }
    return { hash: response.hash, included: confirmation !== null };
  }
}

class QuaiTransactionExecutionError extends Error {}

function invalidVerify(reason: string, message?: string): VerifyResponse {
  return {
    isValid: false,
    invalidReason: reason,
    ...(message ? { invalidMessage: message } : {}),
  };
}

function failedSettlement(payload: PaymentPayload, verification: VerifyResponse): SettleResponse {
  return {
    success: false,
    transaction: "",
    network: payload.accepted.network,
    ...(verification.payer ? { payer: verification.payer } : {}),
    errorReason: verification.invalidReason ?? "verification_failed",
    errorMessage: verification.invalidMessage,
  };
}

function matchesRequirements(
  decoded: DecodedQuaiPayment,
  requirements: PaymentRequirements,
): boolean {
  if (decoded.transaction.chainId !== parseQuaiChainId(requirements.network)) return false;
  const amount = parsePositiveAmount(requirements.amount);
  if (decoded.asset === QUAI_ASSET) {
    return (
      decoded.transaction.to?.toLowerCase() === requirements.payTo.toLowerCase() &&
      decoded.transaction.value === amount
    );
  }
  const matching = decoded.transaction.txOutputs.filter(
    output => output.address.toLowerCase() === requirements.payTo.toLowerCase(),
  );
  return matching.length === 1 && denominations[matching[0].denomination] === amount;
}

function settlementFailure(
  transaction: string,
  network: Network,
  payer?: string,
  error?: unknown,
): SettleResponse {
  return {
    success: false,
    transaction,
    network,
    ...(payer ? { payer } : {}),
    errorReason: "invalid_exact_quai_settlement",
    ...(error ? { errorMessage: error instanceof Error ? error.message : String(error) } : {}),
  };
}

function successfulSettlement(
  transaction: string,
  network: Network,
  payer?: string,
): SettleResponse {
  return {
    success: true,
    transaction,
    network,
    ...(payer ? { payer } : {}),
  };
}
