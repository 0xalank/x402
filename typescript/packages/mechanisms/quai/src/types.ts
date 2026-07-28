import type { Network, PaymentRequirements } from "@x402/core/types";
import type { Provider, QiHDWallet, Signer, Zone } from "quais";

export type QuaiNetwork = "quai:9" | "quai:15000";
export type QuaiAsset = "slip44:994" | "slip44:969";

export type ExactQuaiPayload = {
  signedTransaction: string;
};

export type ClientQuaiSigner = {
  signPayment(requirements: PaymentRequirements): Promise<string>;
};

export type QiWalletSignerConfig = {
  wallet: QiHDWallet;
  provider: Provider;
  originZone: Zone;
  account?: number;
};

export type QuaiPaymentSignerConfig = {
  quai?: Signer;
  qi?: QiWalletSignerConfig;
};

export type QuaiProviderResolver = Provider | ((network: Network) => Provider);

export type QuaiSubmissionResult = {
  hash: string;
  included: boolean;
};

export type QuaiFacilitatorOptions = {
  provider: QuaiProviderResolver;
  submitSignedTransaction?: (
    signedTransaction: string,
    network: Network,
    zone: Zone,
    timeoutMs: number,
  ) => Promise<QuaiSubmissionResult>;
};

export type SettlementStatus = "none" | "pending" | "settled";

export interface QuaiSettlementStore {
  getStatus(hash: string): Promise<SettlementStatus>;
  reserve(hash: string): Promise<boolean>;
  release(hash: string): Promise<void>;
  markSettled(hash: string): Promise<void>;
}
