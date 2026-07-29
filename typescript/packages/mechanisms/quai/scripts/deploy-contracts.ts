import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  ContractFactory,
  Interface,
  JsonRpcProvider,
  Wallet,
  getZoneForAddress,
  isQuaiAddress,
  type InterfaceAbi,
} from "quais";

type ForgeArtifact = {
  abi: InterfaceAbi;
  bytecode: { object: string };
  deployedBytecode: {
    object: string;
    immutableReferences?: Record<string, { start: number; length: number }[]>;
  };
};

const contractRoot = fileURLToPath(new URL("../../../../../contracts/evm/", import.meta.url));

async function artifact(path: string): Promise<ForgeArtifact> {
  return JSON.parse(await readFile(`${contractRoot}${path}`, "utf8")) as ForgeArtifact;
}

async function deploy(
  wallet: Wallet,
  compiled: ForgeArtifact,
  args: readonly unknown[] = [],
): Promise<{ address: string; transaction: string }> {
  const factory = ContractFactory.fromSolidity(compiled, wallet);
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error("Contract deployment transaction is unavailable");
  return {
    address: await contract.getAddress(),
    transaction: transaction.hash,
  };
}

function matchesRuntimeBytecode(
  code: string,
  compiled: ForgeArtifact["deployedBytecode"],
): boolean {
  const normalize = (value: string) =>
    (value.startsWith("0x") ? value.slice(2) : value).toLowerCase();
  let actual = normalize(code);
  let expected = normalize(compiled.object);
  if (actual.length !== expected.length) return false;
  for (const { start, length } of Object.values(compiled.immutableReferences ?? {}).flat()) {
    const offset = start * 2;
    const zeroes = "0".repeat(length * 2);
    actual = `${actual.slice(0, offset)}${zeroes}${actual.slice(offset + zeroes.length)}`;
    expected = `${expected.slice(0, offset)}${zeroes}${expected.slice(offset + zeroes.length)}`;
  }
  return actual === expected;
}

async function requireRuntimeBytecode(
  provider: JsonRpcProvider,
  address: string,
  compiled: ForgeArtifact,
  name: string,
): Promise<void> {
  if (!matchesRuntimeBytecode(await provider.getCode(address), compiled.deployedBytecode)) {
    throw new Error(`${name} address does not contain the expected runtime bytecode`);
  }
}

async function main(): Promise<void> {
  const rpcUrl = process.env.QUAI_RPC_URL;
  const privateKey = process.env.QUAI_PRIVATE_KEY;
  if (!rpcUrl || !privateKey) {
    throw new Error("QUAI_RPC_URL and QUAI_PRIVATE_KEY are required");
  }

  const provider = new JsonRpcProvider(rpcUrl, undefined, { usePathing: true });
  const wallet = new Wallet(privateKey, provider);
  const deployer = await wallet.getAddress();
  const zone = getZoneForAddress(deployer);
  if (!zone || !isQuaiAddress(deployer)) {
    throw new Error("QUAI_PRIVATE_KEY must resolve to a Quai-ledger zone address");
  }
  const chainId = (await provider.getNetwork()).chainId;
  if (chainId !== 9n && chainId !== 15_000n) {
    throw new Error(`Unsupported Quai chain ID: ${chainId}`);
  }

  const permit2Artifact = await artifact("out-quai-permit2/Permit2.sol/Permit2.json");
  let permit2: { address: string; transaction?: string };
  if (process.env.QUAI_PERMIT2_ADDRESS) {
    permit2 = { address: process.env.QUAI_PERMIT2_ADDRESS };
  } else {
    permit2 = await deploy(wallet, permit2Artifact);
  }
  if (!isQuaiAddress(permit2.address) || getZoneForAddress(permit2.address) !== zone) {
    throw new Error("Permit2 must be deployed in the deployer zone");
  }
  await requireRuntimeBytecode(provider, permit2.address, permit2Artifact, "Permit2");

  const proxyArtifact = await artifact(
    "out-quai/x402QuaiExactPermit2Proxy.sol/x402QuaiExactPermit2Proxy.json",
  );
  const exactPermit2Proxy = await deploy(wallet, proxyArtifact, [permit2.address]);
  await requireRuntimeBytecode(
    provider,
    exactPermit2Proxy.address,
    proxyArtifact,
    "Exact Permit2 proxy",
  );
  const proxyInterface = new Interface(proxyArtifact.abi);
  const permit2Result = await provider.call({
    from: deployer,
    to: exactPermit2Proxy.address,
    data: proxyInterface.encodeFunctionData("PERMIT2"),
  });
  const [configuredPermit2] = proxyInterface.decodeFunctionResult("PERMIT2", permit2Result);
  if (String(configuredPermit2).toLowerCase() !== permit2.address.toLowerCase()) {
    throw new Error("Deployed exact proxy returned an unexpected Permit2 address");
  }
  const escrowArtifact = await artifact(
    "out-quai/x402NativeQuaiEscrow.sol/x402NativeQuaiEscrow.json",
  );
  const nativeQuaiEscrow = await deploy(wallet, escrowArtifact);
  await requireRuntimeBytecode(
    provider,
    nativeQuaiEscrow.address,
    escrowArtifact,
    "Native QUAI escrow",
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        chainId: chainId.toString(),
        zone,
        deployer,
        permit2,
        exactPermit2Proxy,
        nativeQuaiEscrow,
      },
      null,
      2,
    )}\n`,
  );
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
