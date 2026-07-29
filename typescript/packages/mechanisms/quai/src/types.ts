import type { Network, PaymentRequirements } from "@x402/core/types";
import type { ExactEIP3009Payload } from "@x402/evm";
import type { Provider, QiHDWallet, Signer, Zone } from "quais";

export type QuaiNetwork = "quai:9" | "quai:15000";
export type QuaiAsset = "slip44:994" | "slip44:969";

export type ExactQuaiPayload = { signedTransaction: string };
export type ExactSponsoredQuaiPayload = ExactEIP3009Payload;

export type ClientQuaiSigner = {
  signPayment(requirements: PaymentRequirements): Promise<string>;
  signSponsoredPayment?(
    x402Version: number,
    requirements: PaymentRequirements,
  ): Promise<ExactEIP3009Payload>;
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
  sponsoredQuaiContracts?: QuaiSponsoredContracts;
};

export type QuaiSponsoredContracts = Partial<
  Record<QuaiNetwork, Partial<Record<Zone, `0x${string}`>>>
>;

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
  sponsoredQuai?: {
    facilitators: Partial<Record<Zone, { signer: Signer; address: `0x${string}` }>>;
    contracts: QuaiSponsoredContracts;
  };
};

export type SettlementStatus = "none" | "pending" | "settled";

export interface QuaiSettlementStore {
  getStatus(hash: string): Promise<SettlementStatus>;
  reserve(hash: string): Promise<boolean>;
  release(hash: string): Promise<void>;
  markSettled(hash: string): Promise<void>;
}
