import { DiagnosticsObservation, INfDiagnostics, NfDiagnosticsSnapshot, ObservationIssue, ServiceRef } from '../../domain/contracts';

/** Independent sources stay useful when another NF fails; empty success is evidence too. */
export function combineDiagnostics<T>(observations: readonly DiagnosticsObservation<readonly T[]>[]): DiagnosticsObservation<readonly T[]> {
  if (!observations.length) throw new Error('A diagnostics aggregation requires source observations');
  const targetId = observations[0].targetId;
  if (observations.some(o => o.targetId !== targetId)) throw new Error('Diagnostics target mismatch');
  const metadata = { targetId, requestedServices: observations.flatMap(o => o.requestedServices), observedAt: new Date().toISOString(), sources: observations.flatMap(o => o.sources) };
  const successful = observations.filter(o => o.status === 'ok' || o.status === 'partial');
  const issues: ObservationIssue[] = observations.flatMap(o => o.status === 'ok' ? [] : o.status === 'partial' ? [...o.issues]
    : [{ code: o.status, reason: o.reason, source: o.sources[0] }]);
  if (!successful.length) {
    const first = observations[0];
    const status = first && first.status !== 'ok' && first.status !== 'partial' && observations.every(o => o.status === first.status)
      ? first.status : 'unavailable';
    return { ...metadata, status, reason: [...new Set(issues.map(i => i.reason))].join('; ') || 'No diagnostics sources available' };
  }
  const data = successful.flatMap(o => o.status === 'ok' || o.status === 'partial' ? [...o.data] : []);
  return issues.length ? { ...metadata, status: 'partial', data, issues: [issues[0], ...issues.slice(1)] }
    : { ...metadata, status: 'ok', data };
}

export class GetNfDiagnostics {
  constructor(private readonly provider: INfDiagnostics) {}
  private async read<T>(service: ServiceRef, operation: () => Promise<DiagnosticsObservation<readonly T[]>>): Promise<DiagnosticsObservation<readonly T[]>> {
    try { return await operation(); }
    catch {
      return { targetId: service.targetId, requestedServices: [service], status: 'error', reason: `Unexpected diagnostics collection failure for ${service.nf}`,
        observedAt: new Date().toISOString(), sources: [{ provider: 'nf-diagnostics', scope: { kind: 'service', service } }] };
    }
  }
  async execute(): Promise<NfDiagnosticsSnapshot> {
    const targetId = this.provider.targetId;
    const [radios, ues, sessions, capabilities] = await Promise.all([
      Promise.all(['mme', 'amf'].map(nf => this.read({ targetId, nf }, () => this.provider.radios({ targetId, nf })))),
      Promise.all(['mme', 'amf'].map(nf => this.read({ targetId, nf }, () => this.provider.ues({ targetId, nf })))),
      this.read({ targetId, nf: 'smf' }, () => this.provider.sessions({ targetId, nf: 'smf' })),
      this.provider.describe({ kind: 'target', targetId }),
    ]);
    return { targetId, radios: combineDiagnostics(radios), ues: combineDiagnostics(ues), sessions,
      services: { mme: { radios: radios[0], ues: ues[0] }, amf: { radios: radios[1], ues: ues[1] } },
      capabilities: capabilities.status === 'ok' || capabilities.status === 'partial' ? capabilities.data : [] };
  }
}
