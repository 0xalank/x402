import type { Network, PaymentRequirements, ResourceInfo } from "@x402/core/types";

export type WorkJob = {
  id: string;
  expiresAt: number;
  refreshAfter?: number;
  work: Record<string, unknown>;
};

export type WorkExtra = {
  name: "x402-work";
  version: "1";
  profile: string;
  job: WorkJob;
};

export type WorkIssueContext = {
  target: bigint;
  requirements: PaymentRequirements;
  resource: ResourceInfo;
  transportContext?: unknown;
};

export interface WorkJobIssuer {
  readonly profile: string;
  readonly asset: string;
  readonly networks: readonly Network[];
  issue(context: WorkIssueContext): Promise<WorkJob>;
}

export type WorkSolverContext = {
  target: bigint;
  requirements: PaymentRequirements;
  job: WorkJob;
  signal: AbortSignal;
};

export interface WorkSolver {
  readonly profile: string;
  solve(context: WorkSolverContext): Promise<Record<string, unknown>>;
}

export type WorkProfileInput = {
  network: Network;
  asset: string;
  amount: string;
  payTo: string;
  target: bigint;
  job: WorkJob;
  solution: Record<string, unknown>;
};

export type WorkProof = {
  score: bigint;
  extra?: Record<string, unknown>;
};

export type WorkSubmission =
  | {
      accepted: true;
      transaction: string;
      extra?: Record<string, unknown>;
    }
  | {
      accepted: false;
      reason: string;
      ambiguous?: boolean;
      extra?: Record<string, unknown>;
    };

export interface WorkFacilitatorProfile {
  readonly profile: string;
  readonly asset: string;
  readonly networks: readonly Network[];
  fingerprint(input: WorkProfileInput): Promise<string> | string;
  verify(input: WorkProfileInput): Promise<WorkProof>;
  settle(input: WorkProfileInput, proof: WorkProof): Promise<WorkSubmission>;
}

export type WorkReservationState =
  | { status: "none" }
  | {
      status: "pending" | "settled";
      binding: string;
      leaseExpiresAt: number;
    };

export type WorkLease = {
  fingerprint: string;
  binding: string;
  token: string;
};

export type WorkAcquireResult =
  | { status: "acquired"; lease: WorkLease }
  | { status: "pending" | "settled" | "conflict" };

export interface WorkSettlementStore {
  inspect(fingerprint: string): Promise<WorkReservationState>;
  acquire(fingerprint: string, binding: string, leaseMs: number): Promise<WorkAcquireResult>;
  release(lease: WorkLease): Promise<void>;
  markSettled(lease: WorkLease): Promise<void>;
}

export type WorkServerOptions = {
  issuers: WorkJobIssuer[];
  now?: () => number;
};

export type WorkClientOptions = {
  solvers: WorkSolver[];
  now?: () => number;
};

export type WorkFacilitatorOptions = {
  profiles: WorkFacilitatorProfile[];
  store: WorkSettlementStore;
  caipFamily?: Network;
  leaseMs?: number;
  now?: () => number;
};
