import type { QuaiSettlementStore, SettlementStatus } from "./types";

/**
 * Process-local atomic settlement guard.
 */
export class InMemoryQuaiSettlementStore implements QuaiSettlementStore {
  private readonly status = new Map<string, Exclude<SettlementStatus, "none">>();

  /**
   * Returns the current settlement state.
   *
   * @param hash - Signed transaction hash
   * @returns Settlement state
   */
  async getStatus(hash: string): Promise<SettlementStatus> {
    return this.status.get(hash) ?? "none";
  }

  /**
   * Atomically reserves an unseen transaction hash.
   *
   * @param hash - Signed transaction hash
   * @returns Whether the reservation was acquired
   */
  async reserve(hash: string): Promise<boolean> {
    if (this.status.has(hash)) return false;
    this.status.set(hash, "pending");
    return true;
  }

  /**
   * Releases a reservation when final verification fails before submission.
   *
   * @param hash - Signed transaction hash
   * @returns Completion
   */
  async release(hash: string): Promise<void> {
    if (this.status.get(hash) === "pending") this.status.delete(hash);
  }

  /**
   * Marks an included transaction as settled.
   *
   * @param hash - Signed transaction hash
   * @returns Completion
   */
  async markSettled(hash: string): Promise<void> {
    this.status.set(hash, "settled");
  }
}
