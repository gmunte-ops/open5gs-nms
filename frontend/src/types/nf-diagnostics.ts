/** JSON mirror of the backend diagnostics contract; no backend runtime dependency. */
export interface ServiceRef { targetId: string; nf: string }
export type Scope = { kind: 'target'; targetId: string } | { kind: 'service'; service: ServiceRef }
  | { kind: 'instance'; instance: { service: ServiceRef; id: string } }
  | { kind: 'resource'; resource: { targetId: string; id: string } };
export interface Source { provider: string; scope: Scope; resourceVersion?: string }
export interface Issue { code: string; reason: string; source?: Source }
export type DiagnosticsObservation<T> = { targetId: string; requestedServices: readonly ServiceRef[]; observedAt: string; sources: readonly Source[] } & (
  { status: 'ok'; data: T } | { status: 'partial'; data: T; issues: readonly Issue[] }
  | { status: 'unsupported' | 'unavailable' | 'not-found' | 'error'; reason: string });
export interface DiagnosticsCapability {
  id: string; scope: Scope;
  support: { status: 'supported' | 'unsupported'; reason?: string };
  policy: { status: 'allowed' | 'denied'; reason?: string };
  access: { status: 'allowed' | 'denied' | 'unknown'; reason?: string };
  availability: { status: 'available' | 'unavailable' | 'unknown'; reason?: string };
}
interface RecordBase { service: ServiceRef; sources: readonly Source[]; rat: '4G' | '5G' }
export interface RadioDiagnostic extends RecordBase {
  id: string; ip: string; setupSuccess: boolean; numConnectedUes: number; plmn?: string;
  selfReportedUeCount?: number | null;
}
export interface UeDiagnostic extends RecordBase {
  imsi?: string; suci?: string; cmState?: string; radioId?: string; radioIp?: string; nickname?: string;
  pdn?: readonly { apn: string; ebi: number; state?: string }[];
  ambrDownlink?: number; ambrUplink?: number; securityEnc?: string; securityInt?: string;
}
export interface SessionDiagnostic extends RecordBase {
  id?: string; psi?: number; ebi?: number; imsi: string; apn: string; ip?: string; ipv6?: string;
  state?: string; radioIp?: string; sliceSst?: number; sliceSd?: string;
}
export interface NfDiagnosticsSnapshot {
  legacyRanPolicy?: { configurationRead: boolean; tags: boolean; radioEnforcement: boolean; ueEnforcement: boolean };
  targetId: string; capabilities: readonly DiagnosticsCapability[];
  radios: DiagnosticsObservation<readonly RadioDiagnostic[]>;
  ues: DiagnosticsObservation<readonly UeDiagnostic[]>;
  sessions: DiagnosticsObservation<readonly SessionDiagnostic[]>;
  services: Record<'mme' | 'amf', { radios: DiagnosticsObservation<readonly RadioDiagnostic[]>; ues: DiagnosticsObservation<readonly UeDiagnostic[]> }>;
}
