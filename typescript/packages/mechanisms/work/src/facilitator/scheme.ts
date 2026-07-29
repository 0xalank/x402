import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import { WORK_NAME, WORK_SCHEME, WORK_VERSION } from "../constants";
import type {
  WorkFacilitatorOptions,
  WorkFacilitatorProfile,
  WorkProfileInput,
  WorkProof,
} from "../types";
import {
  isProfileId,
  parseWorkExtra,
  parseWorkSolution,
  remainingJobMs,
  supports,
  uint256Hex,
  validateEnvelope,
  validateFingerprint,
  validateScore,
  workBinding,
  workInput,
} from "../utils";

type ValidatedWork = {
  profile: WorkFacilitatorProfile;
  input: WorkProfileInput;
  proof: WorkProof;
  fingerprint: string;
  binding: string;
};

export class WorkScheme implements SchemeNetworkFacilitator {
  readonly scheme = WORK_SCHEME;
  readonly caipFamily: Network;
  private readonly profiles = new Map<string, WorkFacilitatorProfile>();
  private readonly now: () => number;

  constructor(private readonly options: WorkFacilitatorOptions) {
    this.caipFamily = options.caipFamily ?? "*:*";
    this.now = options.now ?? Date.now;
    for (const profile of options.profiles) {
      if (!isProfileId(profile.profile))
        throw new Error(`invalid work profile: ${profile.profile}`);
      if (this.profiles.has(profile.profile)) {
        throw new Error(`duplicate work profile: ${profile.profile}`);
      }
      this.profiles.set(profile.profile, profile);
    }
    if (this.profiles.size === 0) throw new Error("at least one work profile is required");
    if (
      options.leaseMs !== undefined &&
      (!Number.isSafeInteger(options.leaseMs) || options.leaseMs <= 0)
    ) {
      throw new Error("work leaseMs must be a positive integer");
    }
  }

  getExtra(network: Network): Record<string, unknown> {
    const profiles = [...this.profiles.values()]
      .filter(profile => profile.networks.includes(network))
      .map(profile => profile.profile)
      .sort();
    return { name: WORK_NAME, version: WORK_VERSION, profiles };
  }

  getSigners(_network: string): string[] {
    return [];
  }

  async verify(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<VerifyResponse> {
    const result = await this.validateAndProve(payload, requirements, true);
    if ("invalid" in result) return result.invalid;
    return {
      isValid: true,
      extra: proofMetadata(result),
    };
  }

  async settle(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
  ): Promise<SettleResponse> {
    const initial = await this.validateAndProve(payload, requirements, true);
    if ("invalid" in initial) return failedSettlement(requirements, initial.invalid);

    const leaseMs = this.options.leaseMs ?? requirements.maxTimeoutSeconds * 1000;
    const acquired = await this.options.store.acquire(
      initial.fingerprint,
      initial.binding,
      leaseMs,
    );
    if (acquired.status !== "acquired") {
      return failedSettlement(
        requirements,
        invalidWork(`invalid_work_${acquired.status}`, "work is already reserved or settled"),
      );
    }

    const lease = acquired.lease;
    const final = await this.validateAndProve(payload, requirements, false);
    if ("invalid" in final || final.fingerprint !== initial.fingerprint) {
      await this.options.store.release(lease);
      return failedSettlement(
        requirements,
        "invalid" in final ? final.invalid : invalidWork("invalid_work_proof_changed"),
      );
    }

    try {
      const submission = await final.profile.settle(final.input, final.proof);
      if (!submission.accepted) {
        if (!submission.ambiguous) await this.options.store.release(lease);
        return failedSettlement(
          requirements,
          invalidWork(
            submission.ambiguous ? "invalid_work_ambiguous" : "invalid_work_source_rejected",
            submission.reason,
          ),
        );
      }
      if (!submission.transaction) throw new Error("work source returned an empty receipt");
      await this.options.store.markSettled(lease);
      return {
        success: true,
        transaction: submission.transaction,
        network: requirements.network,
        amount: requirements.amount,
        extra: {
          ...submission.extra,
          ...proofMetadata(final),
          sourceAccepted: true,
        },
      };
    } catch (error) {
      return failedSettlement(
        requirements,
        invalidWork(
          "invalid_work_ambiguous",
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private async validateAndProve(
    payload: PaymentPayload,
    requirements: PaymentRequirements,
    checkReplay: boolean,
  ): Promise<ValidatedWork | { invalid: VerifyResponse }> {
    try {
      validateEnvelope(payload, requirements);
      const extra = parseWorkExtra(requirements.extra);
      const profile = this.profiles.get(extra.profile);
      if (!profile || !supports(profile, requirements)) {
        return { invalid: invalidWork("invalid_work_profile") };
      }
      if (extra.job.expiresAt <= Math.floor(this.now() / 1000)) {
        return { invalid: invalidWork("invalid_work_stale") };
      }
      remainingJobMs(extra.job, requirements.maxTimeoutSeconds, this.now());
      const input = workInput(requirements, extra, parseWorkSolution(payload));
      const fingerprint = validateFingerprint(await profile.fingerprint(input));
      const binding = workBinding(requirements, extra);
      if (checkReplay) {
        const state = await this.options.store.inspect(fingerprint);
        if (
          state.status === "settled" ||
          (state.status === "pending" &&
            (state.binding !== binding || state.leaseExpiresAt > this.now()))
        ) {
          return { invalid: invalidWork("invalid_work_state") };
        }
      }

      const proof = await profile.verify(input);
      validateScore(proof.score);
      if (proof.score > input.target) return { invalid: invalidWork("invalid_work_target") };
      if (extra.job.expiresAt <= Math.floor(this.now() / 1000)) {
        return { invalid: invalidWork("invalid_work_stale") };
      }

      return { profile, input, proof, fingerprint, binding };
    } catch (error) {
      return {
        invalid: invalidWork(
          "invalid_work_payload",
          error instanceof Error ? error.message : String(error),
        ),
      };
    }
  }
}

function invalidWork(reason: string, message?: string): VerifyResponse {
  return {
    isValid: false,
    invalidReason: reason,
    ...(message ? { invalidMessage: message } : {}),
  };
}

function failedSettlement(
  requirements: PaymentRequirements,
  verification: VerifyResponse,
): SettleResponse {
  return {
    success: false,
    transaction: "",
    network: requirements.network,
    errorReason: verification.invalidReason ?? "invalid_work",
    errorMessage: verification.invalidMessage,
  };
}

function proofMetadata(work: ValidatedWork): Record<string, unknown> {
  return {
    ...work.proof.extra,
    profile: work.profile.profile,
    jobId: work.input.job.id,
    score: uint256Hex(work.proof.score),
    fingerprint: work.fingerprint,
  };
}
