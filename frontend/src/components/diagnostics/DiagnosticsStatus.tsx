import type { DiagnosticsObservation, NfDiagnosticsSnapshot } from '../../types/nf-diagnostics';

export function ObservationStatus({ label, observation }: { label: string; observation: DiagnosticsObservation<readonly unknown[]> }) {
  const detail = observation.status === 'ok' ? (observation.data.length ? `${observation.data.length} observed` : 'No records observed')
    : observation.status === 'partial' ? `Partial: ${observation.issues.map(i => i.reason).join('; ')}`
    : `${observation.status}: ${observation.reason}`;
  return <div className="text-sm text-nms-text-dim"><strong>{label}: </strong>{detail}
    <div className="text-xs">Observed {observation.observedAt} · Sources: {observation.sources.map(s => s.provider).join(', ') || 'No source resolved'}</div>
  </div>;
}
export function DiagnosticsStatus({ data }: { data: NfDiagnosticsSnapshot }) {
  return <div className="nms-card space-y-3" role="status">
    <p className="text-sm text-nms-text">Diagnostics target: {data.targetId}</p>
    {data.capabilities.map(c => <p key={c.id} className="text-xs text-nms-text-dim">
      {c.id}: {c.support.status}{c.support.reason ? ` — ${c.support.reason}` : ''} · Policy: {c.policy.status} · Access: {c.access.status} · Availability: {c.availability.status}
    </p>)}
    <ObservationStatus label="Radios" observation={data.radios} />
    <ObservationStatus label="UEs" observation={data.ues} />
    <ObservationStatus label="Sessions" observation={data.sessions} />
  </div>;
}
