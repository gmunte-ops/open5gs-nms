import type { Observation } from './observation';
import type { ResourceScope } from './target';

/** Vocabulary only: listing an operation here does not enable it on any target. */
export const CAPABILITY_IDS = [
  'fm.read', 'fm.instances.read',
  'logs.recent', 'logs.follow',
  'pm.query', 'pm.scrapeConfig.manage',
  'diagnostics.radios.read', 'diagnostics.ues.read', 'diagnostics.sessions.read',
  'config.read', 'config.preview', 'config.apply', 'config.backup', 'config.restore',
  'subscribers.read', 'subscribers.write', 'subscribers.backup', 'subscribers.restore',
  'lifecycle.start', 'lifecycle.stop', 'lifecycle.restart',
  'lifecycle.enableAtBoot', 'lifecycle.disableAtBoot', 'lifecycle.install', 'lifecycle.upgrade',
  'dataplane.routes.reconcile', 'dataplane.interfaces.manage',
  'dataplane.enforcement', 'dataplane.capture',
] as const;

export type CapabilityId = typeof CAPABILITY_IDS[number];

export interface CapabilityAssessment<S extends string> {
  readonly status: S;
  readonly reason?: string;
}

export interface CapabilityConstraint {
  readonly name: string;
  readonly value: string | number | boolean | readonly string[];
  readonly description?: string;
}

/**
 * Independent dimensions: implemented does not imply permitted or reachable.
 * Access describes provider credentials, NOT the requesting user's authorization.
 * Unknown/missing evidence must never be interpreted as permission to execute.
 * No automatic inheritance between target/service/resource scopes is implied.
 */
export interface CapabilityDescriptor {
  readonly id: CapabilityId;
  readonly scope: ResourceScope;
  readonly support: CapabilityAssessment<'supported' | 'unsupported'>;
  readonly policy: CapabilityAssessment<'allowed' | 'denied'>;
  readonly access: CapabilityAssessment<'allowed' | 'denied' | 'unknown'>;
  readonly availability: CapabilityAssessment<'available' | 'unavailable' | 'unknown'>;
  /** Freshness of the availability assessment, independent of discovery time. */
  readonly availabilityEvidence?: { readonly observedAt: string; readonly validUntil: string };
  readonly constraints?: readonly CapabilityConstraint[];
}

/** Read-only discovery; descriptors are evidence, not authorization to execute. */
export interface ICapabilityDiscovery {
  describe(scope: ResourceScope): Promise<Observation<readonly CapabilityDescriptor[]>>;
}

/** Optional, already-collected evidence for one exact operation and scope. */
export interface CapabilityEvidence {
  readonly observedAt: string;
  readonly validUntil: string;
  readonly access?: CapabilityDescriptor['access'];
  readonly availability?: CapabilityDescriptor['availability'];
}

/** Must only read cached evidence: no probes, credential checks or mutations. */
export interface ICapabilityEvidenceReader {
  readCached(scope: ResourceScope, capability: CapabilityId): CapabilityEvidence | undefined;
}
