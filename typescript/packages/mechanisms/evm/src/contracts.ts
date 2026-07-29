import { getAddress } from "viem";
import { PERMIT2_ADDRESS, x402ExactPermit2ProxyAddress } from "./constants";
import { getEvmChainId } from "./utils";

export type ExactEvmContractAddresses = {
  permit2: `0x${string}`;
  exactPermit2Proxy: `0x${string}`;
};

export type ExactEvmContractAddressOverrides = Partial<ExactEvmContractAddresses>;
export type ExactEvmContractAddressResolver = (
  network: string,
  asset?: string,
) => ExactEvmContractAddressOverrides | undefined;
export type ExactEvmContractAddressConfig =
  | ExactEvmContractAddressOverrides
  | Record<number, ExactEvmContractAddressOverrides>
  | ExactEvmContractAddressResolver;

export const DEFAULT_EXACT_EVM_CONTRACT_ADDRESSES: ExactEvmContractAddresses = {
  permit2: PERMIT2_ADDRESS,
  exactPermit2Proxy: x402ExactPermit2ProxyAddress,
};

/**
 * Checks whether a contract configuration is keyed by EIP-155 chain ID.
 *
 * @param config - Flat or per-chain address configuration
 * @returns True for a per-chain configuration
 */
function isConfigByChainId(
  config: ExactEvmContractAddressConfig,
): config is Record<number, ExactEvmContractAddressOverrides> {
  const keys = Object.keys(config);
  return keys.length > 0 && keys.every(key => /^\d+$/.test(key));
}

/**
 * Resolves trusted Permit2 deployment addresses for a network.
 *
 * Existing EVM networks retain the canonical defaults. Networks with
 * non-canonical deployments, including Quai, can supply flat addresses to a
 * network-specific scheme or a map keyed by EIP-155 chain ID.
 *
 * @param network - CAIP-2 EVM network identifier
 * @param config - Flat or per-chain address overrides
 * @param asset - Optional asset address for profile-specific routing
 * @returns Checksummed Permit2 and exact proxy addresses
 */
export function resolveExactEvmContractAddresses(
  network: string,
  config?: ExactEvmContractAddressConfig,
  asset?: string,
): ExactEvmContractAddresses {
  const overrides = config
    ? typeof config === "function"
      ? config(network, asset)
      : isConfigByChainId(config)
        ? (config as Record<number, ExactEvmContractAddressOverrides>)[getEvmChainId(network)]
        : config
    : undefined;

  return {
    permit2: getAddress(overrides?.permit2 ?? DEFAULT_EXACT_EVM_CONTRACT_ADDRESSES.permit2),
    exactPermit2Proxy: getAddress(
      overrides?.exactPermit2Proxy ?? DEFAULT_EXACT_EVM_CONTRACT_ADDRESSES.exactPermit2Proxy,
    ),
  };
}
