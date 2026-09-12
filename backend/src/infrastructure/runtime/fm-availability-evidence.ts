import { CapabilityEvidence, CapabilityId, ICapabilityEvidenceReader, Observation, ResourceScope, ServiceRef } from '../../domain/contracts';

/** Six normal FM polling intervals; no timers, I/O or background refresh. */
export const FM_EVIDENCE_TTL_MS = 30_000;

/** Passive, process-local cache. Collection availability is not service health. */
export class FmAvailabilityEvidence implements ICapabilityEvidenceReader {
  private readonly entries = new Map<string, CapabilityEvidence>();

  constructor(private readonly explicitEvidence?: ICapabilityEvidenceReader) {}

  record<T>(service: ServiceRef, observation: Observation<T>, collectionSucceeded = observation.status === 'ok'): void {
    const observed = Date.parse(observation.observedAt);
    if (!Number.isFinite(observed) || observed > Date.now()) return;
    const key = JSON.stringify([service.targetId, service.nf]);
    const previous = this.entries.get(key);
    if (previous && Date.parse(previous.observedAt) > observed) return;
    this.entries.set(key, {
      observedAt: observation.observedAt,
      validUntil: new Date(observed + FM_EVIDENCE_TTL_MS).toISOString(),
      availability: collectionSucceeded
        ? { status: 'available', reason: 'Normal FM collection completed; this does not imply the service is active.' }
        : { status: 'unknown', reason: 'FM collection was inconclusive; the failure does not prove dependency unavailability.' },
    });
  }

  readCached(scope: ResourceScope, capability: CapabilityId): CapabilityEvidence | undefined {
    const explicit = this.explicitEvidence?.readCached(scope, capability);
    if (capability !== 'fm.read' || scope.kind !== 'service') return explicit;
    const passive = this.entries.get(JSON.stringify([scope.service.targetId, scope.service.nf]));
    if (!passive) return explicit;
    // Preserve explicit credential evidence only within its own validity window.
    // Passive reads never infer permission, even after successful collection.
    const now = Date.now();
    const access = explicit && Date.parse(explicit.observedAt) <= now && now < Date.parse(explicit.validUntil)
      ? explicit.access : undefined;
    if (!access) return passive;
    if (now >= Date.parse(passive.validUntil)) return { observedAt: explicit!.observedAt, validUntil: explicit!.validUntil, access };
    return { ...passive, access, validUntil: new Date(Math.min(Date.parse(passive.validUntil), Date.parse(explicit!.validUntil))).toISOString() };
  }
}
