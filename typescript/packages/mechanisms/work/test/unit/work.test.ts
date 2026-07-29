import { describe, expect, it, vi } from "vitest";
import { x402Client } from "@x402/core/client";
import { x402Facilitator } from "@x402/core/facilitator";
import { x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemePaymentRequiredContext,
  SupportedKind,
} from "@x402/core/types";
import {
  UINT256_SPACE,
  InMemoryWorkSettlementStore,
  WorkClientScheme,
  WorkFacilitatorScheme,
  WorkServerScheme,
  parseWorkExtra,
  targetForAmount,
  type WorkFacilitatorProfile,
  type WorkJobIssuer,
  type WorkSolver,
} from "../../src";

const NETWORK = "quai:9" as Network;
const PROFILE = "quai/sha256d-v1";
const FINGERPRINT = `0x${"22".repeat(32)}`;
const NOW = 1_800_000_000_000;

function requirements(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "work",
    network: NETWORK,
    asset: "hash",
    amount: "65536",
    payTo: "0x0123456789abcdef0123456789abcdef01234567",
    maxTimeoutSeconds: 30,
    extra: {
      name: "x402-work",
      version: "1",
      profile: PROFILE,
      job: {
        id: "job-1",
        expiresAt: NOW / 1000 + 30,
        refreshAfter: NOW / 1000 + 10,
        payload: { native: "job" },
      },
    },
    ...overrides,
  };
}

function payload(accepted = requirements()): PaymentPayload {
  return {
    x402Version: 2,
    accepted,
    payload: { solution: { nonce: "7" } },
  };
}

function supported(): SupportedKind {
  return {
    x402Version: 2,
    scheme: "work",
    network: NETWORK,
    extra: { name: "x402-work", version: "1", profiles: [PROFILE] },
  };
}

describe("work price", () => {
  it("derives the target without a second price field", () => {
    expect(targetForAmount("1")).toBe(UINT256_SPACE - 1n);
    expect(targetForAmount("65536")).toBe((1n << 240n) - 1n);
    expect(targetForAmount(UINT256_SPACE.toString())).toBe(0n);
    for (const amount of ["0", "01", "-1", "1".repeat(79), (UINT256_SPACE + 1n).toString()]) {
      expect(() => targetForAmount(amount)).toThrow();
    }
    expect(() => parseWorkExtra({ ...requirements().extra, profileVersion: "1" })).toThrow(
      "unknown extra fields",
    );
  });
});

describe("work server and client", () => {
  it("issues a current native job and solves the exact advertised requirement", async () => {
    const issue = vi.fn(async () => ({
      id: "job-1",
      expiresAt: NOW / 1000 + 30,
      refreshAfter: NOW / 1000 + 10,
      payload: { native: "job" },
    }));
    const issuer: WorkJobIssuer = {
      profile: PROFILE,
      asset: "hash",
      networks: [NETWORK],
      issue,
    };
    const server = new WorkServerScheme({
      issuers: [issuer],
      now: () => NOW,
    });

    const price = await server.parsePrice(
      { amount: "65536", asset: "hash", extra: { profile: PROFILE } },
      NETWORK,
    );
    const base = requirements({ extra: price.extra ?? {} });
    const enhanced = await server.enhancePaymentRequirements(base, supported());
    const context = {
      requirements: [enhanced],
      resourceInfo: { url: "https://example.com/data" },
      paymentRequiredResponse: {
        x402Version: 2,
        resource: { url: "https://example.com/data" },
        accepts: [enhanced],
      },
    } satisfies SchemePaymentRequiredContext;
    const [issued] = (await server.enrichPaymentRequiredResponse(context))!;

    expect(issue).toHaveBeenCalledWith(
      expect.objectContaining({
        target: (1n << 240n) - 1n,
        requirements: enhanced,
        resource: context.resourceInfo,
      }),
    );
    expect(issued.extra).toEqual(
      expect.objectContaining({
        name: "x402-work",
        version: "1",
        profile: PROFILE,
      }),
    );

    const solve = vi.fn(async () => ({ nonce: "7" }));
    const solver: WorkSolver = { profile: PROFILE, solve };
    const client = new WorkClientScheme({ solvers: [solver], now: () => NOW });
    const result = await client.createPaymentPayload(2, issued);

    expect(result).toEqual({ x402Version: 2, payload: { solution: { nonce: "7" } } });
    expect(solve).toHaveBeenCalledWith(
      expect.objectContaining({
        target: (1n << 240n) - 1n,
        requirements: issued,
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("does not mine an expired job", async () => {
    const solver: WorkSolver = { profile: PROFILE, solve: vi.fn(async () => ({})) };
    const client = new WorkClientScheme({ solvers: [solver], now: () => NOW });
    const stale = requirements({
      extra: {
        ...requirements().extra,
        job: { id: "old", expiresAt: NOW / 1000, payload: {} },
      },
    });

    await expect(client.createPaymentPayload(2, stale)).rejects.toThrow("work job expired");
    expect(solver.solve).not.toHaveBeenCalled();
  });

  it("stops before mining a job whose refresh time has arrived", async () => {
    const solver: WorkSolver = { profile: PROFILE, solve: vi.fn(async () => ({})) };
    const client = new WorkClientScheme({ solvers: [solver], now: () => NOW });
    const refresh = requirements({
      extra: {
        ...requirements().extra,
        job: {
          id: "refresh",
          refreshAfter: NOW / 1000,
          expiresAt: NOW / 1000 + 30,
          payload: {},
        },
      },
    });

    await expect(client.createPaymentPayload(2, refresh)).rejects.toThrow(
      "work job refresh required",
    );
    expect(solver.solve).not.toHaveBeenCalled();
  });

  it("returns at refresh time even when a solver ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const solver: WorkSolver = {
        profile: PROFILE,
        solve: vi.fn(async context => {
          signal = context.signal;
          return new Promise<Record<string, unknown>>(() => undefined);
        }),
      };
      const client = new WorkClientScheme({ solvers: [solver], now: () => NOW });
      const refresh = requirements({
        extra: {
          ...requirements().extra,
          job: {
            id: "refresh",
            refreshAfter: NOW / 1000 + 1,
            expiresAt: NOW / 1000 + 30,
            payload: {},
          },
        },
      });

      const payment = client.createPaymentPayload(2, refresh);
      const rejected = expect(payment).rejects.toThrow("work job refresh required");
      await vi.advanceTimersByTimeAsync(1_000);
      await rejected;
      expect(signal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("work facilitator", () => {
  function profile(
    settle: WorkFacilitatorProfile["settle"] = vi.fn(async () => ({
      accepted: true,
      transaction: "source-receipt",
    })),
  ): WorkFacilitatorProfile {
    return {
      profile: PROFILE,
      asset: "hash",
      networks: [NETWORK],
      fingerprint: vi.fn(async () => FINGERPRINT),
      verify: vi.fn(async () => ({
        score: 1n,
        extra: { score: "untrusted", fingerprint: "untrusted", native: true },
      })),
      settle,
    };
  }

  it("settles only after source acceptance and reserves the solution exactly once", async () => {
    const adapter = profile();
    const facilitator = new WorkFacilitatorScheme({
      profiles: [adapter],
      store: new InMemoryWorkSettlementStore(() => NOW),
      now: () => NOW,
    });
    const requirement = requirements();
    const payment = payload(requirement);

    expect(facilitator.getExtra(NETWORK)).toEqual({
      name: "x402-work",
      version: "1",
      profiles: [PROFILE],
    });
    expect(await facilitator.verify(payment, requirement)).toEqual({
      isValid: true,
      extra: {
        native: true,
        profile: PROFILE,
        jobId: "job-1",
        score: `0x${"0".repeat(63)}1`,
        fingerprint: FINGERPRINT,
      },
    });
    expect(adapter.settle).not.toHaveBeenCalled();

    const settled = await facilitator.settle(payment, requirement);
    expect(settled).toEqual({
      success: true,
      transaction: "source-receipt",
      network: NETWORK,
      amount: "65536",
      extra: expect.objectContaining({ sourceAccepted: true, fingerprint: FINGERPRINT }),
    });
    expect(adapter.verify).toHaveBeenCalledTimes(3);
    expect(adapter.settle).toHaveBeenCalledTimes(1);

    const replay = await facilitator.settle(payment, requirement);
    expect(replay).toEqual(
      expect.objectContaining({ success: false, errorReason: "invalid_work_state" }),
    );
    expect(adapter.verify).toHaveBeenCalledTimes(3);
    expect(adapter.settle).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous submission reserved until its lease expires", async () => {
    let now = NOW;
    const settle = vi
      .fn<WorkFacilitatorProfile["settle"]>()
      .mockResolvedValueOnce({ accepted: false, ambiguous: true, reason: "timeout" })
      .mockResolvedValueOnce({ accepted: true, transaction: "accepted-on-retry" });
    const adapter = profile(settle);
    const facilitator = new WorkFacilitatorScheme({
      profiles: [adapter],
      store: new InMemoryWorkSettlementStore(() => now),
      leaseMs: 1_000,
      now: () => now,
    });
    const requirement = requirements();
    const payment = payload(requirement);

    expect(await facilitator.settle(payment, requirement)).toEqual(
      expect.objectContaining({ success: false, errorReason: "invalid_work_ambiguous" }),
    );
    expect(await facilitator.settle(payment, requirement)).toEqual(
      expect.objectContaining({ success: false, errorReason: "invalid_work_state" }),
    );
    expect(settle).toHaveBeenCalledTimes(1);

    now += 1_001;
    expect(await facilitator.settle(payment, requirement)).toEqual(
      expect.objectContaining({ success: true, transaction: "accepted-on-retry" }),
    );
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent settlement of the same solution", async () => {
    let release!: () => void;
    const waiting = new Promise<void>(resolve => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>(resolve => {
      entered = resolve;
    });
    const settle = vi.fn(async () => {
      entered();
      await waiting;
      return { accepted: true as const, transaction: "receipt" };
    });
    const adapter = profile(settle);
    const facilitator = new WorkFacilitatorScheme({
      profiles: [adapter],
      store: new InMemoryWorkSettlementStore(() => NOW),
      now: () => NOW,
    });
    const requirement = requirements();
    const payment = payload(requirement);

    const first = facilitator.settle(payment, requirement);
    await started;
    const second = await facilitator.settle(payment, requirement);
    expect(second).toEqual(
      expect.objectContaining({ success: false, errorReason: "invalid_work_state" }),
    );
    expect(settle).toHaveBeenCalledTimes(1);

    release();
    expect(await first).toEqual(expect.objectContaining({ success: true }));
  });

  it("rejects insufficient work before submission", async () => {
    const adapter = profile();
    adapter.verify = vi.fn(async input => ({
      score: input.target + 1n,
    }));
    const facilitator = new WorkFacilitatorScheme({
      profiles: [adapter],
      store: new InMemoryWorkSettlementStore(() => NOW),
      now: () => NOW,
    });

    const result = await facilitator.settle(payload(), requirements());
    expect(result).toEqual(
      expect.objectContaining({ success: false, errorReason: "invalid_work_target" }),
    );
    expect(adapter.settle).not.toHaveBeenCalled();
  });
});

describe("x402 core integration", () => {
  it("discovers, issues, solves, verifies, and source-settles work", async () => {
    const issuer: WorkJobIssuer = {
      profile: PROFILE,
      asset: "hash",
      networks: [NETWORK],
      issue: vi.fn(async () => ({
        id: "core-job",
        expiresAt: NOW / 1000 + 30,
        payload: { header: "native" },
      })),
    };
    const solver: WorkSolver = {
      profile: PROFILE,
      solve: async () => ({ nonce: "9" }),
    };
    const sourceSettle = vi.fn(async () => ({
      accepted: true as const,
      transaction: "native-work-id",
    }));
    const profile: WorkFacilitatorProfile = {
      profile: PROFILE,
      asset: "hash",
      networks: [NETWORK],
      fingerprint: async () => FINGERPRINT,
      verify: async () => ({ score: 0n }),
      settle: sourceSettle,
    };

    const facilitator = new x402Facilitator().register(
      NETWORK,
      new WorkFacilitatorScheme({
        profiles: [profile],
        store: new InMemoryWorkSettlementStore(() => NOW),
        now: () => NOW,
      }),
    );
    const facilitatorClient: FacilitatorClient = {
      getSupported: async () => facilitator.getSupported(),
      verify: (payment, requirement) => facilitator.verify(payment, requirement),
      settle: (payment, requirement) => facilitator.settle(payment, requirement),
    };
    const server = new x402ResourceServer(facilitatorClient).register(
      NETWORK,
      new WorkServerScheme({
        issuers: [issuer],
        now: () => NOW,
      }),
    );
    await server.initialize();

    const base = await server.buildPaymentRequirements({
      scheme: "work",
      network: NETWORK,
      payTo: requirements().payTo,
      price: { amount: "65536", asset: "hash", extra: { profile: PROFILE } },
    });
    const required = await server.createPaymentRequiredResponse(base, {
      url: "https://example.com/core",
    });
    const payment = await new x402Client()
      .register(NETWORK, new WorkClientScheme({ solvers: [solver], now: () => NOW }))
      .createPaymentPayload(required);
    const retried = await server.createPaymentRequiredResponse(
      base,
      required.resource,
      undefined,
      undefined,
      undefined,
      payment,
    );
    const matched = server.findMatchingRequirements(retried.accepts, payment);

    expect(matched).toBeDefined();
    expect(issuer.issue).toHaveBeenCalledOnce();
    expect(await server.verifyPayment(payment, matched!)).toEqual(
      expect.objectContaining({ isValid: true }),
    );
    expect(await server.settlePayment(payment, matched!)).toEqual(
      expect.objectContaining({
        success: true,
        transaction: "native-work-id",
        amount: "65536",
      }),
    );
    expect(sourceSettle).toHaveBeenCalledOnce();
  });
});
