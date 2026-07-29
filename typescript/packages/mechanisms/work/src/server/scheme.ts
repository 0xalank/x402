import type {
  AssetAmount,
  Network,
  PaymentRequirements,
  Price,
  SchemeNetworkServer,
  SchemePaymentRequiredContext,
  SupportedKind,
} from "@x402/core/types";
import { WORK_NAME, WORK_SCHEME, WORK_VERSION } from "../constants";
import type { WorkJobIssuer, WorkServerOptions } from "../types";
import {
  isProfileId,
  parseWorkExtra,
  parseWorkJob,
  remainingJobMs,
  supports,
  targetForAmount,
} from "../utils";

export class WorkScheme implements SchemeNetworkServer {
  readonly scheme = WORK_SCHEME;
  private readonly issuers = new Map<string, WorkJobIssuer>();
  private readonly now: () => number;

  constructor(options: WorkServerOptions) {
    this.now = options.now ?? Date.now;
    for (const issuer of options.issuers) {
      if (!isProfileId(issuer.profile)) throw new Error(`invalid work profile: ${issuer.profile}`);
      if (this.issuers.has(issuer.profile))
        throw new Error(`duplicate work issuer: ${issuer.profile}`);
      this.issuers.set(issuer.profile, issuer);
    }
    if (this.issuers.size === 0) throw new Error("at least one work issuer is required");
  }

  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    if (typeof price !== "object" || price === null || !("amount" in price)) {
      throw new Error("work payments require an explicit AssetAmount price");
    }
    const profile = price.extra?.profile;
    if (!isProfileId(profile)) throw new Error("work price requires extra.profile");
    const issuer = this.issuers.get(profile);
    if (!issuer) throw new Error(`no work issuer registered for ${profile}`);
    const result = {
      amount: price.amount,
      asset: price.asset,
      extra: { profile },
    };
    targetForAmount(result.amount);
    if (issuer.asset !== result.asset || !issuer.networks.includes(network)) {
      throw new Error(`${profile} does not support ${network} and ${result.asset}`);
    }
    return result;
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    supportedKind: SupportedKind,
  ): Promise<PaymentRequirements> {
    const profile = requirements.extra?.profile;
    if (!isProfileId(profile)) throw new Error("work requirements require extra.profile");
    const issuer = this.issuers.get(profile);
    if (!issuer || !supports(issuer, requirements)) {
      throw new Error(`${profile} does not support this work requirement`);
    }
    const profiles = supportedProfiles(supportedKind, requirements.network);
    if (!profiles.includes(profile)) {
      throw new Error(`facilitator does not support ${profile} on ${requirements.network}`);
    }
    return {
      ...requirements,
      extra: { name: WORK_NAME, version: WORK_VERSION, profile },
    };
  }

  validateFacilitatorSupport(network: Network, supportedKind: SupportedKind): string | void {
    try {
      supportedProfiles(supportedKind, network);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  async enrichPaymentRequiredResponse(
    context: SchemePaymentRequiredContext,
  ): Promise<PaymentRequirements[]> {
    const index = context.requirements.findIndex(
      requirement => requirement.scheme === WORK_SCHEME && requirement.extra.job === undefined,
    );
    if (index === -1) return context.requirements;

    const requirements = context.requirements[index];
    const profile = requirements.extra.profile;
    if (!isProfileId(profile)) throw new Error("work requirements require extra.profile");
    const issuer = this.issuers.get(profile);
    if (!issuer || !supports(issuer, requirements)) {
      throw new Error(`no work issuer for ${profile} on ${requirements.network}`);
    }
    const job = parseWorkJob(
      await issuer.issue({
        target: targetForAmount(requirements.amount),
        requirements,
        resource: context.resourceInfo,
        transportContext: context.transportContext,
      }),
    );
    remainingJobMs(job, requirements.maxTimeoutSeconds, this.now());
    const extra = {
      name: WORK_NAME,
      version: WORK_VERSION,
      profile,
      job,
    };
    parseWorkExtra(extra);
    return context.requirements.map((requirement, current) =>
      current === index ? { ...requirement, extra } : requirement,
    );
  }
}

function supportedProfiles(kind: SupportedKind, network: Network): string[] {
  if (
    kind.x402Version !== 2 ||
    kind.scheme !== WORK_SCHEME ||
    kind.network !== network ||
    kind.extra?.name !== WORK_NAME ||
    kind.extra?.version !== WORK_VERSION ||
    !Array.isArray(kind.extra?.profiles) ||
    kind.extra.profiles.some(profile => !isProfileId(profile))
  ) {
    throw new Error(`facilitator advertised invalid work support for ${network}`);
  }
  return kind.extra.profiles as string[];
}
