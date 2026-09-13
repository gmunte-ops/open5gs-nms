import type { CapabilityDescriptor, ICapabilityDiscovery } from './capability';
import type { Observation, SourceRef } from './observation';
import type { ServiceRef, TargetId } from './target';

/** Error is diagnostics-specific so existing Observation consumers remain compatible. */
export type DiagnosticsObservation<T> = { readonly targetId: TargetId; readonly requestedServices: readonly ServiceRef[] } & (Observation<T> | {
  readonly status: 'error'; readonly reason: string; readonly observedAt: string;
  readonly sources: readonly SourceRef[]; readonly data?: never;
});
export interface DiagnosticRecord {
  service: ServiceRef;
  sources: readonly SourceRef[];
  rat: '4G' | '5G';
}
export interface RadioDiagnostic extends DiagnosticRecord {
  id: string; ip: string; setupSuccess: boolean; numConnectedUes: number; plmn?: string;
  selfReportedUeCount?: number | null;
}
export interface UeDiagnostic extends DiagnosticRecord {
  imsi?: string; suci?: string; cmState?: string; radioId?: string; radioIp?: string;
  nickname?: string; ambrDownlink?: number; ambrUplink?: number;
  securityEnc?: string; securityInt?: string;
  pdn?: readonly { apn: string; ebi: number; state?: string }[];
}
export interface SessionDiagnostic extends DiagnosticRecord {
  /** NF session identifier when supplied; absence is not replaced with a fabricated ID. */
  id?: string; psi?: number; ebi?: number; imsi: string; apn: string;
  ip?: string; ipv6?: string; state?: string; radioIp?: string;
  sliceSst?: number; sliceSd?: string;
}
export interface INfDiagnostics extends ICapabilityDiscovery {
  readonly targetId: TargetId;
  radios(service: ServiceRef): Promise<DiagnosticsObservation<readonly RadioDiagnostic[]>>;
  ues(service: ServiceRef): Promise<DiagnosticsObservation<readonly UeDiagnostic[]>>;
  sessions(service: ServiceRef): Promise<DiagnosticsObservation<readonly SessionDiagnostic[]>>;
}
/** Compatibility policy for the existing RAN controls, not diagnostics authorization. */
export interface LegacyRanPolicy { configurationRead: boolean; tags: boolean; radioEnforcement: boolean; ueEnforcement: boolean }
export interface NfDiagnosticsSnapshot {
  legacyRanPolicy?: LegacyRanPolicy;
  targetId: TargetId;
  capabilities: readonly CapabilityDescriptor[];
  radios: DiagnosticsObservation<readonly RadioDiagnostic[]>;
  ues: DiagnosticsObservation<readonly UeDiagnostic[]>;
  sessions: DiagnosticsObservation<readonly SessionDiagnostic[]>;
  /** Keep source-level coverage so an unavailable MME cannot look like an empty 4G network. */
  services: {
    mme: { radios: DiagnosticsObservation<readonly RadioDiagnostic[]>; ues: DiagnosticsObservation<readonly UeDiagnostic[]> };
    amf: { radios: DiagnosticsObservation<readonly RadioDiagnostic[]>; ues: DiagnosticsObservation<readonly UeDiagnostic[]> };
  };
}
