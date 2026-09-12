/** Read-only transport model; capabilities never authorize lifecycle requests. */
export interface ServiceCapability {
  id: string;
  scope: { kind: 'target'; targetId: string } | { kind: 'service'; service: { targetId: string; nf: string } };
  support: { status: 'supported' | 'unsupported'; reason?: string };
  policy: { status: 'allowed' | 'denied'; reason?: string };
  access: { status: 'allowed' | 'denied' | 'unknown'; reason?: string };
  availability: { status: 'available' | 'unavailable' | 'unknown'; reason?: string };
  availabilityEvidence?: { observedAt: string; validUntil: string };
}

export interface ServiceCapabilityObservation {
  status: 'ok' | 'partial' | 'unavailable' | 'unsupported' | 'not-found';
  data?: ServiceCapability[];
}
