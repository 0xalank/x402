import { deepEqual } from "@x402/core/utils";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { MAX_UINT256, UINT256_SPACE, WORK_NAME, WORK_SCHEME, WORK_VERSION } from "./constants";
import type { WorkExtra, WorkJob, WorkProfileInput } from "./types";

const PROFILE = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*-v[1-9]\d*$/;
const FINGERPRINT = /^0x[0-9a-fA-F]{64}$/;

export function targetForAmount(amount: string): bigint {
  if (typeof amount !== "string" || amount.length > 78 || !/^[1-9]\d*$/.test(amount)) {
    throw new Error("work amount must be a positive integer string");
  }
  const value = BigInt(amount);
  if (value > UINT256_SPACE) throw new Error("work amount exceeds 2^256");
  return UINT256_SPACE / value - 1n;
}

export function uint256Hex(value: bigint): string {
  if (value < 0n || value > MAX_UINT256) throw new Error("value is not uint256");
  return `0x${value.toString(16).padStart(64, "0")}`;
}

export function isProfileId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && PROFILE.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseWorkExtra(value: unknown): WorkExtra {
  if (!isRecord(value)) throw new Error("work requirements require extra");
  const allowed = new Set(["name", "version", "profile", "job"]);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error("work requirements contain unknown extra fields");
  }
  if (value.name !== WORK_NAME || value.version !== WORK_VERSION) {
    throw new Error("unsupported work scheme version");
  }
  if (!isProfileId(value.profile)) throw new Error("invalid work profile");
  return {
    name: WORK_NAME,
    version: WORK_VERSION,
    profile: value.profile,
    job: parseWorkJob(value.job),
  };
}

export function parseWorkJob(value: unknown): WorkJob {
  if (!isRecord(value)) throw new Error("work job must be an object");
  const allowed = new Set(["id", "expiresAt", "refreshAfter", "payload"]);
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error("work job contains unknown fields");
  }
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 128) {
    throw new Error("work job id must contain 1 to 128 characters");
  }
  if (!Number.isSafeInteger(value.expiresAt) || Number(value.expiresAt) <= 0) {
    throw new Error("work job expiresAt must be a positive integer");
  }
  if (
    value.refreshAfter !== undefined &&
    (!Number.isSafeInteger(value.refreshAfter) ||
      Number(value.refreshAfter) <= 0 ||
      Number(value.refreshAfter) >= Number(value.expiresAt))
  ) {
    throw new Error("work job refreshAfter must precede expiresAt");
  }
  if (!isRecord(value.payload)) throw new Error("work job payload must be an object");
  return {
    id: value.id,
    expiresAt: Number(value.expiresAt),
    ...(value.refreshAfter === undefined ? {} : { refreshAfter: Number(value.refreshAfter) }),
    payload: value.payload,
  };
}

export function parseWorkSolution(payload: PaymentPayload): Record<string, unknown> {
  if (!isRecord(payload.payload) || Object.keys(payload.payload).some(key => key !== "solution")) {
    throw new Error("work payload must contain only solution");
  }
  if (!isRecord(payload.payload.solution)) throw new Error("work solution must be an object");
  return payload.payload.solution;
}

export function remainingJobMs(job: WorkJob, maxTimeoutSeconds: number, nowMs: number): number {
  validateMaxTimeout(maxTimeoutSeconds);
  const remaining = job.expiresAt * 1000 - nowMs;
  if (remaining <= 0) throw new Error("work job expired");
  if (remaining > maxTimeoutSeconds * 1000) {
    throw new Error("work job exceeds maxTimeoutSeconds");
  }
  return remaining;
}

export function validateMaxTimeout(maxTimeoutSeconds: number): void {
  if (
    !Number.isSafeInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds <= 0 ||
    maxTimeoutSeconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
  ) {
    throw new Error("work maxTimeoutSeconds must be a positive bounded integer");
  }
}

export function validateEnvelope(payload: PaymentPayload, requirements: PaymentRequirements): void {
  if (payload.x402Version !== 2) throw new Error("invalid x402 version");
  if (requirements.scheme !== WORK_SCHEME || payload.accepted.scheme !== WORK_SCHEME) {
    throw new Error("unsupported scheme");
  }
  if (!deepEqual(payload.accepted, requirements)) {
    throw new Error("accepted work requirements do not match");
  }
  validateMaxTimeout(requirements.maxTimeoutSeconds);
}

export function workInput(
  requirements: PaymentRequirements,
  extra: WorkExtra,
  solution: Record<string, unknown>,
): WorkProfileInput {
  return {
    network: requirements.network,
    asset: requirements.asset,
    amount: requirements.amount,
    payTo: requirements.payTo,
    target: targetForAmount(requirements.amount),
    job: extra.job,
    solution,
  };
}

export function validateScore(score: unknown): asserts score is bigint {
  if (typeof score !== "bigint" || score < 0n || score > MAX_UINT256) {
    throw new Error("work profile returned an invalid score");
  }
}

export function validateFingerprint(fingerprint: unknown): string {
  if (typeof fingerprint !== "string" || !FINGERPRINT.test(fingerprint)) {
    throw new Error("work profile returned an invalid fingerprint");
  }
  return fingerprint.toLowerCase();
}

export function workBinding(requirements: PaymentRequirements, extra: WorkExtra): string {
  return JSON.stringify([
    requirements.scheme,
    requirements.network,
    requirements.asset,
    requirements.amount,
    requirements.payTo,
    requirements.maxTimeoutSeconds,
    extra.profile,
    extra.job.id,
    extra.job.expiresAt,
    extra.job.refreshAfter ?? null,
  ]);
}

export function supports(
  profile: { asset: string; networks: readonly string[] },
  requirements: PaymentRequirements,
): boolean {
  if (requirements.asset !== "hash") return false;
  return profile.asset === requirements.asset && profile.networks.includes(requirements.network);
}
