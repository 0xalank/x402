import type {
  WorkAcquireResult,
  WorkLease,
  WorkReservationState,
  WorkSettlementStore,
} from "./types";

type StoredReservation = Exclude<WorkReservationState, { status: "none" }> & {
  token?: string;
};

export class InMemoryWorkSettlementStore implements WorkSettlementStore {
  private readonly records = new Map<string, StoredReservation>();
  private sequence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  async inspect(fingerprint: string): Promise<WorkReservationState> {
    const record = this.records.get(fingerprint);
    if (!record) return { status: "none" };
    return {
      status: record.status,
      binding: record.binding,
      leaseExpiresAt: record.leaseExpiresAt,
    };
  }

  async acquire(fingerprint: string, binding: string, leaseMs: number): Promise<WorkAcquireResult> {
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) throw new Error("invalid work lease");
    const existing = this.records.get(fingerprint);
    if (existing?.binding !== undefined && existing.binding !== binding) {
      return { status: "conflict" };
    }
    if (existing?.status === "settled") return { status: "settled" };
    if (existing?.status === "pending" && existing.leaseExpiresAt > this.now()) {
      return { status: "pending" };
    }

    const lease = {
      fingerprint,
      binding,
      token: String(++this.sequence),
    };
    this.records.set(fingerprint, {
      status: "pending",
      binding,
      leaseExpiresAt: this.now() + leaseMs,
      token: lease.token,
    });
    return { status: "acquired", lease };
  }

  async release(lease: WorkLease): Promise<void> {
    const record = this.records.get(lease.fingerprint);
    if (record?.status === "pending" && record.token === lease.token) {
      this.records.delete(lease.fingerprint);
    }
  }

  async markSettled(lease: WorkLease): Promise<void> {
    const record = this.records.get(lease.fingerprint);
    if (record?.status !== "pending" || record.token !== lease.token) {
      throw new Error("work settlement lease was lost");
    }
    this.records.set(lease.fingerprint, {
      status: "settled",
      binding: lease.binding,
      leaseExpiresAt: Number.MAX_SAFE_INTEGER,
    });
  }
}
