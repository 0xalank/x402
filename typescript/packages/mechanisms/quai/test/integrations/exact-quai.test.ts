import { describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { Mnemonic, QuaiHDWallet, QuaiTransaction, Wallet, Zone, type Provider } from "quais";
import { QUAI_ASSET } from "../../src/constants";
import { ExactQuaiScheme as Client } from "../../src/exact/client/scheme";
import { ExactQuaiScheme as Facilitator } from "../../src/exact/facilitator/scheme";
import { ExactQuaiScheme as Server } from "../../src/exact/server/scheme";
import { createQuaiPaymentSigner } from "../../src/signer";

describe("exact Quai integration", () => {
  it("creates, verifies, and settles one signed QUAI payment", async () => {
    const payerWallet = QuaiHDWallet.fromMnemonic(
      Mnemonic.fromPhrase("test test test test test test test test test test test junk"),
    );
    const recipientWallet = QuaiHDWallet.fromMnemonic(
      Mnemonic.fromPhrase(
        "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
      ),
    );
    const payer = payerWallet.getNextAddressSync(0, Zone.Cyprus1).address;
    const payTo = recipientWallet.getNextAddressSync(0, Zone.Cyprus1).address;
    const provider = {
      getNetwork: vi.fn().mockResolvedValue({ chainId: 9n }),
      getTransactionCount: vi.fn().mockResolvedValue(0),
      getBalance: vi.fn().mockResolvedValue(1_000_000n),
      getFeeData: vi.fn().mockResolvedValue({ gasPrice: 1n }),
      estimateGas: vi.fn().mockResolvedValue(21_000n),
      call: vi.fn().mockResolvedValue("0x"),
    } as unknown as Provider;
    const baseRequirements: PaymentRequirements = {
      scheme: "exact",
      network: "quai:9",
      asset: QUAI_ASSET,
      amount: "1000",
      payTo,
      maxTimeoutSeconds: 60,
      extra: {},
    };
    const requirements = await new Server().enhancePaymentRequirements(
      baseRequirements,
      { x402Version: 2, scheme: "exact", network: "quai:9" },
      [],
    );
    const signer = createQuaiPaymentSigner({
      quai: new Wallet(payerWallet.getPrivateKey(payer), provider),
    });
    const client = new Client(signer);
    const result = await client.createPaymentPayload(2, requirements);
    const payload: PaymentPayload = { ...result, accepted: requirements };
    const signedTransaction = (result.payload as { signedTransaction: string }).signedTransaction;
    const hash = QuaiTransaction.from(signedTransaction).hash!;
    const facilitator = new Facilitator({
      provider,
      submitSignedTransaction: vi.fn().mockResolvedValue({ hash, included: true }),
    });

    await expect(facilitator.verify(payload, requirements)).resolves.toEqual({
      isValid: true,
      payer,
    });
    await expect(facilitator.settle(payload, requirements)).resolves.toEqual({
      success: true,
      transaction: hash,
      network: "quai:9",
      payer,
    });
  });
});
