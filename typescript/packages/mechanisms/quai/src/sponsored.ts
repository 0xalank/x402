import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { getZoneForAddress, isQuaiAddress } from "quais";
import { QUAI_ASSET } from "./constants";
import type { ExactSponsoredQuaiPayload, QuaiSponsoredContracts } from "./types";
import { isQuaiNetwork, parseQuaiChainId } from "./utils";

export const SPONSORED_QUAI_METHOD = "escrow";
export const SPONSORED_QUAI_NAME = "x402 Native QUAI";
export const SPONSORED_QUAI_VERSION = "1";

export function isSponsoredQuai(requirements: PaymentRequirements): boolean {
  return (
    requirements.asset === QUAI_ASSET &&
    requirements.extra?.areFeesSponsored === true &&
    requirements.extra?.assetTransferMethod === SPONSORED_QUAI_METHOD
  );
}

export function resolveSponsoredQuaiContract(
  contracts: QuaiSponsoredContracts | undefined,
  requirements: PaymentRequirements,
): `0x${string}` {
  if (!isQuaiNetwork(requirements.network)) {
    throw new Error(`Unsupported Quai network: ${requirements.network}`);
  }
  const zone = getZoneForAddress(requirements.payTo);
  if (!zone || !isQuaiAddress(requirements.payTo)) {
    throw new Error("Sponsored QUAI requires a valid Quai payTo address");
  }
  const configured = contracts?.[requirements.network]?.[zone];
  if (!configured || !isQuaiAddress(configured) || getZoneForAddress(configured) !== zone) {
    throw new Error(`No sponsored QUAI contract configured for ${requirements.network} ${zone}`);
  }
  const advertised = requirements.extra?.settlementContract;
  if (advertised !== undefined && String(advertised).toLowerCase() !== configured.toLowerCase()) {
    throw new Error("Sponsored QUAI settlement contract does not match local configuration");
  }
  return configured;
}

export function toSponsoredEvmRequirements(
  requirements: PaymentRequirements,
  contract: `0x${string}`,
): PaymentRequirements {
  return {
    ...requirements,
    network: `eip155:${parseQuaiChainId(requirements.network)}`,
    asset: contract,
    extra: {
      assetTransferMethod: "eip3009",
      name: SPONSORED_QUAI_NAME,
      version: SPONSORED_QUAI_VERSION,
    },
  };
}

export function toSponsoredEvmPayload(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
): PaymentPayload {
  return {
    ...payload,
    accepted: requirements,
    payload: payload.payload as ExactSponsoredQuaiPayload,
  };
}
