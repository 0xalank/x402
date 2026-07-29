import type {
  ClientEvmSigner,
  Erc20ApprovalTransactionParser,
  Erc20ApprovalGasSponsoringSigner,
  ExactEvmContractAddresses,
  ExactEvmContractAddressResolver,
  FacilitatorEvmSigner,
  TransactionRequest,
} from "@x402/evm";
import {
  Interface,
  QuaiTransaction,
  getZoneForAddress,
  isQuaiAddress,
  verifyTypedData,
  type InterfaceAbi,
  type Provider,
  type Signer,
  type TypedDataDomain,
  type TypedDataField,
  type Zone,
} from "quais";
import type { QuaiNetwork } from "./types";

type EvmAddress = `0x${string}`;
type EvmHex = `0x${string}`;

export type QuaiEvmContractDeployments = Partial<
  Record<QuaiNetwork, Partial<Record<Zone, ExactEvmContractAddresses>>>
>;

export type QuaiEvmApprovalExecutor = {
  /** Simulates the raw approval and settlement as one ordered bundle. */
  simulateTransactions(transactions: TransactionRequest[]): Promise<boolean>;
  /** Submits the same ordered bundle atomically and returns its transaction hashes. */
  sendTransactions(transactions: TransactionRequest[]): Promise<`0x${string}`[]>;
};

export type QuaiEvmFacilitatorSigners = Partial<Record<Zone, Signer>>;

/**
 * Creates a zone-aware Permit2 address resolver for the generic EVM scheme.
 *
 * Quai zones share a chain ID, so the asset contract address selects the
 * corresponding Permit2 and exact proxy deployment.
 *
 * @param deployments - Trusted Permit2 deployments by Quai network and zone
 * @returns An EVM contract resolver
 */
export function createQuaiEvmContractResolver(
  deployments: QuaiEvmContractDeployments,
): ExactEvmContractAddressResolver {
  return (network, asset) => {
    if (network !== "eip155:9" && network !== "eip155:15000") return undefined;
    if (!asset || !isQuaiAddress(asset)) {
      throw new Error("Quai Permit2 requires a valid Quai asset address");
    }
    const zone = getZoneForAddress(asset);
    const quaiNetwork = network === "eip155:9" ? "quai:9" : "quai:15000";
    const contracts = zone ? deployments[quaiNetwork]?.[zone] : undefined;
    if (!zone || !contracts) {
      throw new Error(`No Quai Permit2 contracts configured for ${quaiNetwork} ${zone}`);
    }
    for (const address of [contracts.permit2, contracts.exactPermit2Proxy]) {
      if (!isQuaiAddress(address) || getZoneForAddress(address) !== zone) {
        throw new Error("Quai Permit2 contracts must be in the asset zone");
      }
    }
    return contracts;
  };
}

function asAddress(address: string): EvmAddress {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`Invalid EVM address: ${address}`);
  }
  return address as EvmAddress;
}

function asHex(value: string): EvmHex {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new Error("Expected an even-length hexadecimal value");
  }
  return value as EvmHex;
}

function requireZone(address: string, zone: Zone): void {
  if (!isQuaiAddress(address) || getZoneForAddress(address) !== zone) {
    throw new Error(`Quai EVM address must be in signer zone ${zone}: ${address}`);
  }
}

function requireMessageZone(message: Record<string, unknown>, zone: Zone): void {
  for (const field of ["from", "to", "owner", "spender", "token"]) {
    const address = message[field];
    if (typeof address === "string") requireZone(address, zone);
  }
  for (const field of ["witness", "permitted"]) {
    const nested = message[field];
    if (nested && typeof nested === "object") {
      requireMessageZone(nested as Record<string, unknown>, zone);
    }
  }
}

function appendData(data: string, suffix?: EvmHex): EvmHex {
  return asHex(suffix ? `${data}${suffix.slice(2)}` : data);
}

function createInterface(abi: readonly unknown[]): Interface {
  return new Interface(abi as InterfaceAbi);
}

async function readContract(
  provider: Provider,
  from: EvmAddress,
  args: {
    address: EvmAddress;
    abi: readonly unknown[];
    functionName: string;
    args?: readonly unknown[];
  },
): Promise<unknown> {
  const contractInterface = createInterface(args.abi);
  const values = [...(args.args ?? [])];
  const fragment = contractInterface.getFunction(args.functionName, values);
  if (!fragment) throw new Error(`Unknown contract function: ${args.functionName}`);
  const data = contractInterface.encodeFunctionData(fragment, values);
  const encoded = await provider.call({ from, to: args.address, data });
  const result = contractInterface.decodeFunctionResult(fragment, encoded);
  return fragment.outputs.length === 1 ? result[0] : result;
}

function typedData(message: Parameters<ClientEvmSigner["signTypedData"]>[0]): {
  domain: TypedDataDomain;
  types: Record<string, TypedDataField[]>;
  value: Record<string, unknown>;
} {
  return {
    domain: message.domain as TypedDataDomain,
    types: message.types as Record<string, TypedDataField[]>,
    value: message.message,
  };
}

/**
 * Adapts a quais signer to the EIP-712 and contract-read surface used by
 * `@x402/evm`. Raw approval transaction signing is intentionally excluded:
 * Quai account transactions use protobuf encoding rather than Ethereum RLP.
 *
 * @param signer - A quais signer connected to the target Quai network
 * @param provider - Optional provider, defaulting to the signer's provider
 * @returns An x402 EVM client signer
 */
export async function createQuaiEvmClientSigner(
  signer: Signer,
  provider: Provider | null = signer.provider,
): Promise<ClientEvmSigner> {
  const address = asAddress(await signer.getAddress());
  const signerZone = getZoneForAddress(address);
  if (!signerZone || !isQuaiAddress(address)) {
    throw new Error("Quai EVM signer must use a Quai-ledger address");
  }
  const result: ClientEvmSigner = {
    address,
    signTypedData: async message => {
      const verifyingContract = message.domain.verifyingContract;
      if (typeof verifyingContract === "string") requireZone(verifyingContract, signerZone);
      requireMessageZone(message.message, signerZone);
      const data = typedData(message);
      return asHex(await signer.signTypedData(data.domain, data.types, data.value));
    },
  };

  if (provider) {
    result.readContract = args => {
      requireZone(args.address, signerZone);
      return readContract(provider, address, args);
    };
    result.getTransactionCount = args => {
      requireZone(args.address, signerZone);
      return provider.getTransactionCount(args.address, "pending");
    };
    result.estimateFeesPerGas = async () => {
      const zone = getZoneForAddress(address);
      if (!zone) throw new Error(`Unable to resolve Quai zone for ${address}`);
      const { gasPrice } = await provider.getFeeData(zone, true);
      if (gasPrice === null) throw new Error("Quai provider returned no gas price");
      return { maxFeePerGas: gasPrice, maxPriorityFeePerGas: 0n };
    };
    result.signTransaction = async args => {
      requireZone(args.to, signerZone);
      return asHex(
        await signer.signTransaction({
          type: 0,
          chainId: args.chainId,
          from: address,
          to: args.to,
          data: args.data,
          nonce: args.nonce,
          gasLimit: args.gas,
          gasPrice: args.maxFeePerGas,
          value: 0n,
          accessList: [],
        }),
      );
    };
  }

  return result;
}

/**
 * Parses and authenticates a canonical Quai protobuf account transaction for
 * the generic ERC-20 approval sponsoring extension.
 */
export const parseQuaiEvmApprovalTransaction: Erc20ApprovalTransactionParser = (
  signedTransaction,
  chainId,
) => {
  const transaction = QuaiTransaction.from(signedTransaction);
  if (!transaction.isSigned() || !transaction.from) {
    throw new Error("Quai approval transaction is not signed");
  }
  if (transaction.type !== 0) {
    throw new Error("Quai approval transaction must be type 0");
  }
  if (transaction.chainId !== BigInt(chainId)) {
    throw new Error("Quai approval transaction chain ID mismatch");
  }
  if (transaction.serialized.toLowerCase() !== signedTransaction.toLowerCase()) {
    throw new Error("Quai approval transaction is not canonically encoded");
  }
  if (
    transaction.to !== null &&
    (!isQuaiAddress(transaction.to) ||
      getZoneForAddress(transaction.to) !== getZoneForAddress(transaction.from))
  ) {
    throw new Error("Quai approval transaction must remain in the payer zone");
  }
  return {
    from: asAddress(transaction.from),
    to: transaction.to === null ? null : asAddress(transaction.to),
    data: asHex(transaction.data),
  };
};

/**
 * Adapts a funded quais signer to the facilitator surface used by
 * `@x402/evm`. Contract calls are encoded locally and submitted as native Quai
 * account transactions, so the underlying provider uses the `quai_*` RPC
 * namespace.
 *
 * @param signer - Funded facilitator signer
 * @param provider - Optional provider, defaulting to the signer's provider
 * @returns An x402 EVM facilitator signer
 */
export async function createQuaiEvmFacilitatorSigner(
  signer: Signer,
  provider: Provider | null = signer.provider,
): Promise<FacilitatorEvmSigner> {
  if (!provider) {
    throw new Error("A Quai provider is required for facilitator operations");
  }
  const address = asAddress(await signer.getAddress());
  const signerZone = getZoneForAddress(address);
  if (!signerZone || !isQuaiAddress(address)) {
    throw new Error("Quai EVM facilitator signer must use a Quai-ledger address");
  }

  return {
    getAddresses: () => [address],
    readContract: args => {
      requireZone(args.address, signerZone);
      return readContract(provider, address, args);
    },
    verifyTypedData: async args => {
      const verifyingContract = args.domain.verifyingContract;
      if (typeof verifyingContract === "string") requireZone(verifyingContract, signerZone);
      requireMessageZone(args.message, signerZone);
      const recovered = verifyTypedData(
        args.domain as TypedDataDomain,
        args.types as Record<string, TypedDataField[]>,
        args.message,
        args.signature,
      );
      return recovered.toLowerCase() === args.address.toLowerCase();
    },
    writeContract: async args => {
      requireZone(args.address, signerZone);
      const contractInterface = createInterface(args.abi);
      const values = [...args.args];
      const fragment = contractInterface.getFunction(args.functionName, values);
      if (!fragment) throw new Error(`Unknown contract function: ${args.functionName}`);
      const data = appendData(
        contractInterface.encodeFunctionData(fragment, values),
        args.dataSuffix,
      );
      const response = await signer.sendTransaction({
        from: address,
        to: args.address,
        data,
        ...(args.gas === undefined ? {} : { gasLimit: args.gas }),
      });
      return asHex(response.hash);
    },
    sendTransaction: async args => {
      requireZone(args.to, signerZone);
      const response = await signer.sendTransaction({
        from: address,
        to: args.to,
        data: args.data,
      });
      return asHex(response.hash);
    },
    waitForTransactionReceipt: async args => {
      const receipt = await provider.waitForTransaction(args.hash, 1);
      if (!receipt) throw new Error(`Transaction receipt not found: ${args.hash}`);
      return {
        status: receipt.status === 1 ? "success" : "reverted",
        logs: receipt.logs.map(log => {
          const topics = log.topics.map(asHex);
          return {
            address: asAddress(log.address),
            data: asHex(log.data),
            topics: topics.length === 0 ? [] : [topics[0], ...topics.slice(1)],
            blockHash: asHex(log.blockHash),
            blockNumber: BigInt(log.blockNumber),
            transactionHash: asHex(log.transactionHash),
            transactionIndex: log.transactionIndex,
            logIndex: log.index,
            removed: log.removed,
          };
        }),
      };
    },
    getCode: async args => {
      requireZone(args.address, signerZone);
      return asHex(await provider.getCode(args.address));
    },
  };
}

/**
 * Creates one facilitator surface that routes contract calls to a signer in
 * the target Quai zone.
 *
 * @param signers - Funded facilitator signers keyed by zone
 * @param provider - Quai provider used by every signer
 * @returns A zone-routing x402 EVM facilitator signer
 */
export async function createQuaiEvmFacilitatorSignerByZone(
  signers: QuaiEvmFacilitatorSigners,
  provider: Provider,
): Promise<FacilitatorEvmSigner> {
  const adapters = new Map<Zone, FacilitatorEvmSigner>();
  for (const [configuredZone, signer] of Object.entries(signers)) {
    if (!signer) continue;
    const zone = configuredZone as Zone;
    const adapter = await createQuaiEvmFacilitatorSigner(signer, provider);
    if (getZoneForAddress(adapter.getAddresses()[0]) !== zone) {
      throw new Error(`Quai facilitator signer does not match configured zone ${zone}`);
    }
    adapters.set(zone, adapter);
  }
  const first = adapters.values().next().value as FacilitatorEvmSigner | undefined;
  if (!first) throw new Error("At least one Quai facilitator signer is required");

  const forAddress = (address: string): FacilitatorEvmSigner => {
    if (!isQuaiAddress(address)) {
      throw new Error(`Expected a Quai-ledger address: ${address}`);
    }
    const zone = getZoneForAddress(address);
    const adapter = zone ? adapters.get(zone) : undefined;
    if (!adapter) throw new Error(`No Quai facilitator signer configured for zone ${zone}`);
    return adapter;
  };

  return {
    getAddresses: () => [...adapters.values()].flatMap(adapter => [...adapter.getAddresses()]),
    readContract: args => forAddress(args.address).readContract(args),
    verifyTypedData: args => {
      const verifyingContract = args.domain.verifyingContract;
      if (typeof verifyingContract !== "string") {
        throw new Error("Quai EIP-712 verification requires a verifying contract");
      }
      return forAddress(verifyingContract).verifyTypedData(args);
    },
    writeContract: args => forAddress(args.address).writeContract(args),
    sendTransaction: args => forAddress(args.to).sendTransaction(args),
    waitForTransactionReceipt: args => first.waitForTransactionReceipt(args),
    getCode: args => forAddress(args.address).getCode(args),
  };
}

/**
 * Adds an atomic approval-and-settlement executor to a Quai facilitator signer.
 *
 * The executor is deliberately injected because sequentially broadcasting a
 * funded approval and settlement does not satisfy the extension's atomicity
 * requirement.
 *
 * @param signer - Funded facilitator signer
 * @param executor - Network-specific atomic transaction executor
 * @param provider - Optional provider, defaulting to the signer's provider
 * @returns A Quai-compatible ERC-20 approval sponsoring signer
 */
export async function createQuaiEvmApprovalSponsoringSigner(
  signer: Signer,
  executor: QuaiEvmApprovalExecutor,
  provider: Provider | null = signer.provider,
): Promise<Erc20ApprovalGasSponsoringSigner> {
  return {
    ...(await createQuaiEvmFacilitatorSigner(signer, provider)),
    ...executor,
  };
}
