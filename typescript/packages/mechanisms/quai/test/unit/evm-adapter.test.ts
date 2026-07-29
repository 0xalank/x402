import { describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme as EvmClient } from "@x402/evm/exact/client";
import { ExactEvmScheme as EvmFacilitator } from "@x402/evm/exact/facilitator";
import { Interface, Mnemonic, QuaiHDWallet, Wallet, Zone, type Provider, type Signer } from "quais";
import {
  createQuaiEvmApprovalSponsoringSigner,
  createQuaiEvmContractResolver,
  createQuaiEvmClientSigner,
  createQuaiEvmFacilitatorSigner,
  createQuaiEvmFacilitatorSignerByZone,
  parseQuaiEvmApprovalTransaction,
} from "../../src/evm";
import { QUAI_ASSET } from "../../src/constants";
import { ExactQuaiScheme as QuaiClient } from "../../src/exact/client/scheme";
import { ExactQuaiScheme as QuaiFacilitator } from "../../src/exact/facilitator/scheme";
import { ExactQuaiScheme as QuaiServer } from "../../src/exact/server/scheme";
import { createQuaiPaymentSigner } from "../../src/signer";

const phrase = "test test test test test test test test test test test junk";
const recipientPhrase =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const hdWallet = QuaiHDWallet.fromMnemonic(Mnemonic.fromPhrase(phrase));
const walletAddress = hdWallet.getNextAddressSync(0, Zone.Cyprus1).address;
const privateKey = hdWallet.getPrivateKey(walletAddress);
const permit2Address = hdWallet.getNextAddressSync(0, Zone.Cyprus1).address as `0x${string}`;
const proxyAddress = hdWallet.getNextAddressSync(0, Zone.Cyprus1).address as `0x${string}`;
const facilitatorAddress = hdWallet.getNextAddressSync(0, Zone.Cyprus1).address as `0x${string}`;
const zoneTwoAddress = hdWallet.getNextAddressSync(0, Zone.Cyprus2).address;
const zoneTwoPrivateKey = hdWallet.getPrivateKey(zoneTwoAddress);
const contract = QuaiHDWallet.fromMnemonic(Mnemonic.fromPhrase(recipientPhrase)).getNextAddressSync(
  0,
  Zone.Cyprus1,
).address as `0x${string}`;
const zoneTwoContract = QuaiHDWallet.fromMnemonic(
  Mnemonic.fromPhrase(recipientPhrase),
).getNextAddressSync(0, Zone.Cyprus2).address as `0x${string}`;
const transactionHash = `0x${"33".repeat(32)}`;
const abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

function mockProvider() {
  const contractInterface = new Interface(abi);
  return {
    call: vi.fn().mockResolvedValue(contractInterface.encodeFunctionResult("balanceOf", [123n])),
    getTransactionCount: vi.fn().mockResolvedValue(7),
    getCode: vi.fn().mockResolvedValue("0x6000"),
    waitForTransaction: vi.fn().mockResolvedValue({ status: 1, logs: [] }),
    getFeeData: vi.fn().mockResolvedValue({ gasPrice: 2n }),
  } as unknown as Provider;
}

describe("Quai EVM adapters", () => {
  it("resolves Permit2 deployments by the asset zone", () => {
    const resolver = createQuaiEvmContractResolver({
      "quai:9": {
        [Zone.Cyprus1]: {
          permit2: permit2Address,
          exactPermit2Proxy: proxyAddress,
        },
      },
      "quai:15000": {
        [Zone.Cyprus1]: {
          permit2: permit2Address,
          exactPermit2Proxy: proxyAddress,
        },
      },
    });

    expect(resolver("eip155:9", contract)).toEqual({
      permit2: permit2Address,
      exactPermit2Proxy: proxyAddress,
    });
    expect(resolver("eip155:15000", contract)).toEqual({
      permit2: permit2Address,
      exactPermit2Proxy: proxyAddress,
    });
    expect(() =>
      resolver("eip155:9", hdWallet.getNextAddressSync(0, Zone.Cyprus2).address as `0x${string}`),
    ).toThrow("No Quai Permit2 contracts configured");
    expect(resolver("eip155:8453", contract)).toBeUndefined();
  });

  it("adapts EIP-712 signing and contract reads for the EVM client", async () => {
    const provider = mockProvider();
    const wallet = new Wallet(privateKey);
    const signer = await createQuaiEvmClientSigner(wallet, provider);
    const domain = {
      name: "Test",
      version: "1",
      chainId: 9,
      verifyingContract: contract,
    };
    const types = {
      Payment: [
        { name: "to", type: "address" },
        { name: "amount", type: "uint256" },
      ],
    };
    const message = { to: contract, amount: 1n };

    const signature = await signer.signTypedData({
      domain,
      types,
      primaryType: "Payment",
      message,
    });
    await expect(
      signer.readContract?.({
        address: contract,
        abi,
        functionName: "balanceOf",
        args: [signer.address],
      }),
    ).resolves.toBe(123n);

    expect(signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(provider.call).toHaveBeenCalledOnce();
    await expect(signer.getTransactionCount?.({ address: signer.address })).resolves.toBe(7);
  });

  it("rejects a typed payment that crosses Quai zones", async () => {
    const signer = await createQuaiEvmClientSigner(new Wallet(privateKey), mockProvider());

    await expect(
      signer.signTypedData({
        domain: {
          name: "Test",
          version: "1",
          chainId: 9,
          verifyingContract: contract,
        },
        types: {
          Payment: [
            { name: "to", type: "address" },
            { name: "amount", type: "uint256" },
          ],
        },
        primaryType: "Payment",
        message: { to: zoneTwoContract, amount: 1n },
      }),
    ).rejects.toThrow("must be in signer zone");
  });

  it("encodes writes, appends data suffixes, and maps receipts", async () => {
    const provider = mockProvider();
    const sendTransaction = vi.fn().mockResolvedValue({ hash: transactionHash });
    const wallet = new Wallet(privateKey);
    const signer = {
      provider,
      getAddress: () => wallet.getAddress(),
      sendTransaction,
    } as unknown as Signer;
    const facilitator = await createQuaiEvmFacilitatorSigner(signer, provider);

    await expect(
      facilitator.writeContract({
        address: contract,
        abi,
        functionName: "transfer",
        args: [contract, 5n],
        gas: 50_000n,
        dataSuffix: "0xaabb",
      }),
    ).resolves.toBe(transactionHash);
    const data = sendTransaction.mock.calls[0][0].data as string;
    expect(data.endsWith("aabb")).toBe(true);
    expect(sendTransaction).toHaveBeenCalledWith({
      from: await wallet.getAddress(),
      to: contract,
      data,
      gasLimit: 50_000n,
    });

    await expect(
      facilitator.waitForTransactionReceipt({ hash: transactionHash }),
    ).resolves.toMatchObject({ status: "success", logs: [] });
    await expect(facilitator.getCode({ address: contract })).resolves.toBe("0x6000");
  });

  it("injects the atomic executor required for generic approval sponsorship", async () => {
    const provider = mockProvider();
    const wallet = new Wallet(privateKey);
    const sendTransactions = vi.fn().mockResolvedValue([transactionHash]);
    const simulateTransactions = vi.fn().mockResolvedValue(true);
    const signer = await createQuaiEvmApprovalSponsoringSigner(
      {
        provider,
        getAddress: () => wallet.getAddress(),
      } as unknown as Signer,
      { sendTransactions, simulateTransactions },
      provider,
    );

    await expect(signer.sendTransactions([{ to: contract, data: "0x" }])).resolves.toEqual([
      transactionHash,
    ]);
    await expect(signer.simulateTransactions?.([{ to: contract, data: "0x" }])).resolves.toBe(true);
    expect(sendTransactions).toHaveBeenCalledOnce();
  });

  it("routes facilitator contract calls to the signer in the asset zone", async () => {
    const provider = mockProvider();
    const sendZoneOne = vi.fn().mockResolvedValue({ hash: transactionHash });
    const sendZoneTwo = vi.fn().mockResolvedValue({ hash: transactionHash });
    const signer = await createQuaiEvmFacilitatorSignerByZone(
      {
        [Zone.Cyprus1]: {
          provider,
          getAddress: () => Promise.resolve(walletAddress),
          sendTransaction: sendZoneOne,
        } as unknown as Signer,
        [Zone.Cyprus2]: {
          provider,
          getAddress: () => Promise.resolve(zoneTwoAddress),
          sendTransaction: sendZoneTwo,
        } as unknown as Signer,
      },
      provider,
    );

    await signer.writeContract({
      address: contract,
      abi,
      functionName: "transfer",
      args: [contract, 1n],
    });
    await signer.writeContract({
      address: zoneTwoContract,
      abi,
      functionName: "transfer",
      args: [zoneTwoContract, 1n],
    });

    expect(sendZoneOne).toHaveBeenCalledOnce();
    expect(sendZoneTwo).toHaveBeenCalledOnce();
    expect(signer.getAddresses()).toHaveLength(2);

    const zoneTwoWallet = new Wallet(zoneTwoPrivateKey);
    const domain = {
      name: "Test",
      version: "1",
      chainId: 9,
      verifyingContract: zoneTwoContract,
    };
    const types = { Payment: [{ name: "to", type: "address" }] };
    const message = { to: zoneTwoContract };
    const signature = await zoneTwoWallet.signTypedData(domain, types, message);
    await expect(
      signer.verifyTypedData({
        address: zoneTwoAddress,
        domain,
        types,
        primaryType: "Payment",
        message,
        signature,
      }),
    ).resolves.toBe(true);
  });

  it.each([9, 15_000])(
    "signs and parses canonical Quai approval transactions on chain %i",
    async chainId => {
      const provider = mockProvider();
      const wallet = new Wallet(privateKey);
      const signer = await createQuaiEvmClientSigner(wallet, provider);
      const data = "0x095ea7b3" as const;
      const signed = await signer.signTransaction?.({
        to: contract,
        data,
        nonce: 1,
        gas: 50_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 0n,
        chainId,
      });

      expect(signed).toBeDefined();
      expect(parseQuaiEvmApprovalTransaction(signed!, chainId)).toMatchObject({
        from: signer.address,
        to: contract,
        data,
      });
      expect(() => parseQuaiEvmApprovalTransaction(signed!, chainId + 1)).toThrow(
        "chain ID mismatch",
      );
    },
  );

  it.each([9, 15_000])(
    "runs an EIP-3009 payment through the existing EVM schemes on Quai chain %i",
    async chainId => {
      const payerWallet = new Wallet(privateKey);
      const payer = (await payerWallet.getAddress()) as `0x${string}`;
      const sendTransaction = vi.fn().mockResolvedValue({ hash: transactionHash });
      const provider = {
        call: vi.fn().mockResolvedValue("0x"),
        getTransactionCount: vi.fn().mockResolvedValue(0),
        getCode: vi
          .fn()
          .mockImplementation((address: string) =>
            Promise.resolve(address.toLowerCase() === contract.toLowerCase() ? "0x6000" : "0x"),
          ),
        waitForTransaction: vi.fn().mockResolvedValue({ status: 1, logs: [] }),
      } as unknown as Provider;
      const requirements = {
        scheme: "exact",
        network: `eip155:${chainId}`,
        asset: contract,
        amount: "5",
        payTo: proxyAddress,
        maxTimeoutSeconds: 60,
        extra: { name: "Quai Test Token", version: "1" },
      } satisfies PaymentRequirements;

      const clientSigner = await createQuaiEvmClientSigner(payerWallet, provider);
      const created = await new EvmClient(clientSigner).createPaymentPayload(2, requirements);
      const payload = {
        x402Version: created.x402Version,
        accepted: requirements,
        payload: created.payload,
      } satisfies PaymentPayload;
      const facilitatorSigner = await createQuaiEvmFacilitatorSigner(
        {
          provider,
          getAddress: () => Promise.resolve(facilitatorAddress),
          sendTransaction,
        } as unknown as Signer,
        provider,
      );
      const facilitator = new EvmFacilitator(facilitatorSigner);

      await expect(facilitator.verify(payload, requirements)).resolves.toEqual({
        isValid: true,
        invalidReason: undefined,
        payer,
      });
      await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
        success: true,
        transaction: transactionHash,
        network: `eip155:${chainId}`,
        payer,
      });
      expect(provider.call).toHaveBeenCalledOnce();
      expect(sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ from: facilitatorAddress, to: contract }),
      );
    },
  );

  it.each([9, 15_000])(
    "runs a Permit2 payment through the existing EVM schemes on Quai chain %i",
    async chainId => {
      const payerWallet = new Wallet(privateKey);
      const payer = (await payerWallet.getAddress()) as `0x${string}`;
      const permit2 = permit2Address;
      const exactPermit2Proxy = proxyAddress;
      const sendTransaction = vi.fn().mockResolvedValue({ hash: transactionHash });
      const provider = {
        call: vi.fn().mockResolvedValue("0x"),
        getTransactionCount: vi.fn().mockResolvedValue(0),
        getCode: vi
          .fn()
          .mockImplementation((address: string) =>
            Promise.resolve(address.toLowerCase() === contract.toLowerCase() ? "0x6000" : "0x"),
          ),
        waitForTransaction: vi.fn().mockResolvedValue({ status: 1, logs: [] }),
      } as unknown as Provider;
      const requirements = {
        scheme: "exact",
        network: `eip155:${chainId}`,
        asset: contract,
        amount: "5",
        payTo: proxyAddress,
        maxTimeoutSeconds: 60,
        extra: { assetTransferMethod: "permit2" },
      } satisfies PaymentRequirements;
      const contracts = { permit2, exactPermit2Proxy };
      const clientSigner = await createQuaiEvmClientSigner(payerWallet, provider);
      const created = await new EvmClient(clientSigner, {
        [chainId]: { contracts },
      }).createPaymentPayload(2, requirements);
      const payload = {
        x402Version: created.x402Version,
        accepted: requirements,
        payload: created.payload,
      } satisfies PaymentPayload;
      const facilitatorSigner = await createQuaiEvmFacilitatorSigner(
        {
          provider,
          getAddress: () => Promise.resolve(facilitatorAddress),
          sendTransaction,
        } as unknown as Signer,
        provider,
      );
      const facilitator = new EvmFacilitator(facilitatorSigner, {
        contracts: { [chainId]: contracts },
      });

      await expect(facilitator.verify(payload, requirements)).resolves.toEqual({
        isValid: true,
        invalidReason: undefined,
        payer,
      });
      await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
        success: true,
        transaction: transactionHash,
        network: `eip155:${chainId}`,
        payer,
      });
      expect(sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ from: facilitatorAddress, to: exactPermit2Proxy }),
      );
    },
  );

  it.each([9, 15_000])(
    "runs an EIP-2612-sponsored Permit2 payment on Quai chain %i",
    async chainId => {
      const payerWallet = new Wallet(privateKey);
      const payer = (await payerWallet.getAddress()) as `0x${string}`;
      const permit2 = permit2Address;
      const exactPermit2Proxy = proxyAddress;
      const zeroWord = `0x${"00".repeat(32)}`;
      const sendTransaction = vi.fn().mockResolvedValue({ hash: transactionHash });
      const provider = {
        call: vi
          .fn()
          .mockImplementation(({ to }: { to: string }) =>
            Promise.resolve(to.toLowerCase() === contract.toLowerCase() ? zeroWord : "0x"),
          ),
        getTransactionCount: vi.fn().mockResolvedValue(0),
        getCode: vi
          .fn()
          .mockImplementation((address: string) =>
            Promise.resolve(address.toLowerCase() === contract.toLowerCase() ? "0x6000" : "0x"),
          ),
        waitForTransaction: vi.fn().mockResolvedValue({ status: 1, logs: [] }),
      } as unknown as Provider;
      const requirements = {
        scheme: "exact",
        network: `eip155:${chainId}`,
        asset: contract,
        amount: "5",
        payTo: proxyAddress,
        maxTimeoutSeconds: 60,
        extra: {
          assetTransferMethod: "permit2",
          name: "Quai Permit Token",
          version: "1",
        },
      } satisfies PaymentRequirements;
      const contracts = { permit2, exactPermit2Proxy };
      const clientSigner = await createQuaiEvmClientSigner(payerWallet, provider);
      const created = await new EvmClient(clientSigner, {
        [chainId]: { contracts },
      }).createPaymentPayload(2, requirements, {
        extensions: { eip2612GasSponsoring: {} },
      });
      const payload = {
        x402Version: created.x402Version,
        accepted: requirements,
        payload: created.payload,
        extensions: created.extensions,
      } satisfies PaymentPayload;
      const facilitatorSigner = await createQuaiEvmFacilitatorSigner(
        {
          provider,
          getAddress: () => Promise.resolve(facilitatorAddress),
          sendTransaction,
        } as unknown as Signer,
        provider,
      );
      const facilitator = new EvmFacilitator(facilitatorSigner, {
        contracts: { [chainId]: contracts },
      });

      expect(created.extensions).toHaveProperty("eip2612GasSponsoring");
      await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
        isValid: true,
        payer,
      });
      await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
        success: true,
        transaction: transactionHash,
        network: `eip155:${chainId}`,
        payer,
      });
      expect(sendTransaction).toHaveBeenCalledWith(
        expect.objectContaining({ from: facilitatorAddress, to: exactPermit2Proxy }),
      );
    },
  );

  it.each([9, 15_000])(
    "runs a sponsored protobuf approval and Permit2 settlement on Quai chain %i",
    async chainId => {
      const payerWallet = new Wallet(privateKey);
      const payer = (await payerWallet.getAddress()) as `0x${string}`;
      const zeroWord = `0x${"00".repeat(32)}`;
      const provider = {
        call: vi.fn().mockResolvedValue(zeroWord),
        getTransactionCount: vi.fn().mockResolvedValue(0),
        getCode: vi
          .fn()
          .mockImplementation((address: string) =>
            Promise.resolve(address.toLowerCase() === contract.toLowerCase() ? "0x6000" : "0x"),
          ),
        getFeeData: vi.fn().mockResolvedValue({ gasPrice: 2n }),
        waitForTransaction: vi.fn().mockResolvedValue({ status: 1, logs: [] }),
      } as unknown as Provider;
      const requirements = {
        scheme: "exact",
        network: `eip155:${chainId}`,
        asset: contract,
        amount: "5",
        payTo: proxyAddress,
        maxTimeoutSeconds: 60,
        extra: { assetTransferMethod: "permit2" },
      } satisfies PaymentRequirements;
      const contracts = {
        permit2: permit2Address,
        exactPermit2Proxy: proxyAddress,
      };
      const clientSigner = await createQuaiEvmClientSigner(payerWallet, provider);
      const created = await new EvmClient(clientSigner, {
        [chainId]: { contracts },
      }).createPaymentPayload(2, requirements, {
        extensions: { erc20ApprovalGasSponsoring: {} },
      });
      const payload = {
        x402Version: created.x402Version,
        accepted: requirements,
        payload: created.payload,
        extensions: created.extensions,
      } satisfies PaymentPayload;
      const sendTransactions = vi.fn().mockResolvedValue([transactionHash]);
      const simulateTransactions = vi.fn().mockResolvedValue(true);
      const extensionSigner = await createQuaiEvmApprovalSponsoringSigner(
        {
          provider,
          getAddress: () => Promise.resolve(facilitatorAddress),
        } as unknown as Signer,
        { sendTransactions, simulateTransactions },
        provider,
      );
      expect(extensionSigner.getAddresses()).toEqual([facilitatorAddress]);
      const context = {
        getExtension: (key: string) =>
          key === "erc20ApprovalGasSponsoring"
            ? { key: "erc20ApprovalGasSponsoring", signer: extensionSigner }
            : undefined,
      };
      const facilitator = new EvmFacilitator(extensionSigner, {
        contracts: { [chainId]: contracts },
        approvalTransactionParser: parseQuaiEvmApprovalTransaction,
      });

      expect(created.extensions).toHaveProperty("erc20ApprovalGasSponsoring");
      await expect(facilitator.verify(payload, requirements, context)).resolves.toMatchObject({
        isValid: true,
        payer,
      });
      await expect(facilitator.settle(payload, requirements, context)).resolves.toMatchObject({
        success: true,
        transaction: transactionHash,
        network: `eip155:${chainId}`,
        payer,
      });
      expect(simulateTransactions).toHaveBeenCalledOnce();
      expect(sendTransactions).toHaveBeenCalledOnce();
      const [approval, settlement] = sendTransactions.mock.calls[0][0];
      expect(parseQuaiEvmApprovalTransaction(approval as `0x${string}`, chainId)).toMatchObject({
        from: payer,
        to: contract,
      });
      expect(settlement).toMatchObject({ to: proxyAddress });
    },
  );

  it("reuses EIP-3009 authorization for sponsored native QUAI escrow payments", async () => {
    const payerWallet = new Wallet(privateKey);
    const transactionHash = `0x${"77".repeat(32)}`;
    const contracts = {
      "quai:9": { [Zone.Cyprus1]: contract },
    } as const;
    const baseRequirements = {
      scheme: "exact",
      network: "quai:9",
      asset: QUAI_ASSET,
      amount: "5",
      payTo: walletAddress,
      maxTimeoutSeconds: 60,
      extra: {},
    } satisfies PaymentRequirements;
    const requirements = await new QuaiServer(contracts).enhancePaymentRequirements(
      baseRequirements,
      {
        x402Version: 2,
        scheme: "exact",
        network: "quai:9",
        extra: {
          areFeesSponsored: true,
          assetTransferMethod: "escrow",
          sponsoredZones: [Zone.Cyprus1],
        },
      },
      [],
    );
    await expect(
      new QuaiServer(contracts).enhancePaymentRequirements(
        { ...baseRequirements, extra: { areFeesSponsored: false } },
        {
          x402Version: 2,
          scheme: "exact",
          network: "quai:9",
          extra: {
            areFeesSponsored: true,
            assetTransferMethod: "escrow",
            sponsoredZones: [Zone.Cyprus1],
          },
        },
        [],
      ),
    ).resolves.toMatchObject({ extra: { areFeesSponsored: false } });
    await expect(
      new QuaiServer(contracts).enhancePaymentRequirements(
        baseRequirements,
        {
          x402Version: 2,
          scheme: "exact",
          network: "quai:9",
          extra: {
            areFeesSponsored: true,
            assetTransferMethod: "escrow",
            sponsoredZones: [Zone.Cyprus2],
          },
        },
        [],
      ),
    ).resolves.toMatchObject({ extra: { areFeesSponsored: false } });
    const paymentSigner = createQuaiPaymentSigner({
      quai: payerWallet,
      sponsoredQuaiContracts: contracts,
    });
    const created = await new QuaiClient(paymentSigner).createPaymentPayload(2, requirements);
    const payload = {
      x402Version: 2,
      accepted: requirements,
      payload: created.payload,
    } satisfies PaymentPayload;
    const provider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 9n }),
      call: vi.fn().mockResolvedValue("0x"),
      getCode: vi
        .fn()
        .mockImplementation((address: string) =>
          Promise.resolve(address.toLowerCase() === contract.toLowerCase() ? "0x6000" : "0x"),
        ),
      waitForTransaction: vi.fn().mockResolvedValue({ status: 1, logs: [] }),
    } as unknown as Provider;
    const sendTransaction = vi.fn().mockResolvedValue({ hash: transactionHash });
    const facilitator = new QuaiFacilitator({
      provider,
      sponsoredQuai: {
        facilitators: {
          [Zone.Cyprus1]: {
            signer: {
              provider,
              getAddress: () => Promise.resolve(facilitatorAddress),
              sendTransaction,
            } as unknown as Signer,
            address: facilitatorAddress,
          },
        },
        contracts,
      },
    });
    const invalidFacilitator = new QuaiFacilitator({
      provider,
      sponsoredQuai: {
        facilitators: {
          [Zone.Cyprus1]: {
            signer: payerWallet,
            address: walletAddress,
          },
        },
        contracts: {
          "quai:9": { [Zone.Cyprus1]: zoneTwoContract },
        },
      },
    });
    expect(facilitator.getExtra("quai:9")).toEqual({
      areFeesSponsored: true,
      assetTransferMethod: "escrow",
      sponsoredZones: [Zone.Cyprus1],
    });
    expect(facilitator.getSigners("quai:9")).toEqual([facilitatorAddress]);
    expect(invalidFacilitator.getExtra("quai:9")).toEqual({ areFeesSponsored: false });
    expect(invalidFacilitator.getSigners("quai:9")).toEqual([]);

    await expect(
      facilitator.verify(
        {
          ...payload,
          payload: {
            ...(payload.payload as Record<string, unknown>),
            authorization: {
              ...(payload.payload as { authorization: Record<string, unknown> }).authorization,
              from: zoneTwoAddress,
            },
          },
        },
        requirements,
      ),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_quai_payer_zone",
    });
    await expect(
      facilitator.verify(
        {
          ...payload,
          accepted: {
            ...requirements,
            extra: { ...requirements.extra, settlementContract: undefined },
          },
        },
        requirements,
      ),
    ).resolves.toMatchObject({
      isValid: false,
      invalidReason: "invalid_exact_quai_requirements",
    });
    await expect(facilitator.verify(payload, requirements)).resolves.toMatchObject({
      isValid: true,
      payer: walletAddress,
    });
    await expect(facilitator.settle(payload, requirements)).resolves.toMatchObject({
      success: true,
      transaction: transactionHash,
      network: "quai:9",
    });
    expect(sendTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ from: facilitatorAddress, to: contract }),
    );
  });
});
