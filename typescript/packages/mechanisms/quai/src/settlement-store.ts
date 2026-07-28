import type { QuaiSettlementClaim, QuaiSettlementStore, SettlementStatus } from "./types";

/**
 * Process-local atomic settlement guard.
 */
export class InMemoryQuaiSettlementStore implements QuaiSettlementStore {
  private readonly records = new Map<
    string,
    { status: "pending"; owner: string } | { status: "retryable" | "settled" }
  >();
  private nextOwner = 0;

  /**
   * Returns the current settlement state.
   *
   * @param hash - Signed transaction hash
   * @returns Settlement state
   */
  async getStatus(hash: string): Promise<SettlementStatus> {
    return this.records.get(hash)?.status ?? "none";
  }

  /**
   * Atomically reserves an unseen transaction hash.
   *
   * @param hash - Signed transaction hash
   * @returns Exclusive settlement claim, if acquired
   */
  async reserve(hash: string): Promise<QuaiSettlementClaim | undefined> {
    if (this.records.has(hash)) return undefined;
    return this.claim(hash);
  }

  /**
   * Atomically resumes a retryable transaction.
   *
   * @param hash - Signed transaction hash
   * @returns Exclusive settlement claim, if acquired
   */
  async resume(hash: string): Promise<QuaiSettlementClaim | undefined> {
    if (this.records.get(hash)?.status !== "retryable") return undefined;
    return this.claim(hash);
  }

  /**
   * Releases a claim when final verification fails before submission.
   *
   * @param claim - Exclusive settlement claim
   * @returns Completion
   */
  async release(claim: QuaiSettlementClaim): Promise<void> {
    if (this.owns(claim)) this.records.delete(claim.hash);
  }

  /**
   * Makes an ambiguously submitted transaction eligible for one retry.
   *
   * @param claim - Exclusive settlement claim
   * @returns Completion
   */
  async markRetryable(claim: QuaiSettlementClaim): Promise<void> {
    if (this.owns(claim)) this.records.set(claim.hash, { status: "retryable" });
  }

  /**
   * Marks an included transaction as settled.
   *
   * @param claim - Exclusive settlement claim
   * @returns Whether this caller owned the claim
   */
  async markSettled(claim: QuaiSettlementClaim): Promise<boolean> {
    if (!this.owns(claim)) return false;
    this.records.set(claim.hash, { status: "settled" });
    return true;
  }

  private claim(hash: string): QuaiSettlementClaim {
    const claim = { hash, owner: String(++this.nextOwner) };
    this.records.set(hash, { status: "pending", owner: claim.owner });
    return claim;
  }

  private owns(claim: QuaiSettlementClaim): boolean {
    const record = this.records.get(claim.hash);
    return record?.status === "pending" && record.owner === claim.owner;
  }
}
