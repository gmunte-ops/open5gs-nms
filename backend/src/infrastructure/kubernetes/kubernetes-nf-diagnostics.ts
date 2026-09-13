import { DiagnosticsObservation, INfDiagnostics, RadioDiagnostic, ResourceScope, ServiceRef, SessionDiagnostic, UeDiagnostic } from '../../domain/contracts';
import { diagnosticsCapabilities } from '../diagnostics/diagnostics-capabilities';

/** Deliberately has no local executor, config, metrics, log or cluster mutation dependency. */
export class KubernetesNfDiagnostics implements INfDiagnostics {
  readonly targetId = 'kubernetes';
  async describe(scope: ResourceScope) { return diagnosticsCapabilities(this.targetId, scope, false); }
  private read<T>(service: ServiceRef): Promise<DiagnosticsObservation<readonly T[]>> {
    return Promise.resolve({ targetId: service.targetId, requestedServices: [service], status: service.targetId === this.targetId ? 'unsupported' : 'not-found',
      reason: service.targetId === this.targetId
        ? 'No verified Kubernetes-accessible Open5GS diagnostics source is configured'
        : 'Diagnostics target mismatch', observedAt: new Date().toISOString(), sources: [{ provider: 'nf-diagnostics', scope: { kind: 'service', service } }] });
  }
  radios(service: ServiceRef) { return this.read<RadioDiagnostic>(service); }
  ues(service: ServiceRef) { return this.read<UeDiagnostic>(service); }
  sessions(service: ServiceRef) { return this.read<SessionDiagnostic>(service); }
}
