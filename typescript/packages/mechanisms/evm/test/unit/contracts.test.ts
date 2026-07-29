import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXACT_EVM_CONTRACT_ADDRESSES,
  resolveExactEvmContractAddresses,
} from "../../src/contracts";

describe("exact EVM contract deployments", () => {
  it("preserves canonical defaults", () => {
    expect(resolveExactEvmContractAddresses("eip155:8453")).toEqual(
      DEFAULT_EXACT_EVM_CONTRACT_ADDRESSES,
    );
  });

  it("resolves a chain-specific Quai deployment", () => {
    const permit2 = "0x0000000000000000000000000000000000000009";
    const exactPermit2Proxy = "0x0000000000000000000000000000000000000019";

    expect(
      resolveExactEvmContractAddresses("eip155:9", {
        9: { permit2, exactPermit2Proxy },
        15000: {
          permit2: "0x0000000000000000000000000000000000015000",
          exactPermit2Proxy: "0x0000000000000000000000000000000000015010",
        },
      }),
    ).toEqual({ permit2, exactPermit2Proxy });
  });

  it("passes the asset to a profile-specific resolver", () => {
    const permit2 = "0x0000000000000000000000000000000000000009";
    const exactPermit2Proxy = "0x0000000000000000000000000000000000000019";
    const asset = "0x0000000000000000000000000000000000000029";

    expect(
      resolveExactEvmContractAddresses(
        "eip155:9",
        (network, selectedAsset) => {
          expect(network).toBe("eip155:9");
          expect(selectedAsset).toBe(asset);
          return { permit2, exactPermit2Proxy };
        },
        asset,
      ),
    ).toEqual({ permit2, exactPermit2Proxy });
  });
});
