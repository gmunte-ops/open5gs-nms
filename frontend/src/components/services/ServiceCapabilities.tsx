import type { ReactNode } from 'react';
import type { CapabilityLoad, CapabilityView } from './capability-view';
import { capabilityView, currentCapability } from './capability-view';

const labels: Record<string, string> = { 'fm.read': 'FM read', 'lifecycle.start': 'Start', 'lifecycle.stop': 'Stop', 'lifecycle.restart': 'Restart', 'lifecycle.enableAtBoot': 'Enable at boot', 'lifecycle.disableAtBoot': 'Disable at boot' };

export function ServiceCapabilities({ load, actionsSupported }: { load?: CapabilityLoad; actionsSupported?: boolean }) {
  const fm = load?.data?.find(item => item.id === 'fm.read');
  const view = capabilityView(fm);
  return <details className="mt-2 text-xs text-nms-text-dim">
    <summary className="cursor-pointer text-nms-accent">FM read: {view.label === 'Available' ? 'Readable' : view.label} · Capability details</summary>
    <div className="mt-2 space-y-2 max-w-lg whitespace-normal">
      {load?.status === 'loading' || !load ? <p>Loading capability assessments…</p> : null}
      {load?.status === 'unavailable' && <p>Capability assessment unavailable. {load.data ? 'Showing the last successful assessment; previous restrictions are retained. ' : ''}Existing controls and server guards still apply.</p>}
      {load?.status === 'partial' && <p>Some capability assessments are unavailable.</p>}
      {load?.data?.filter(item => labels[item.id]).map(item => currentCapability(item)).map(item => {
        const state = capabilityView(item, item.id.startsWith('lifecycle.') ? actionsSupported : undefined);
        return <div key={item.id}>
          <p className="font-semibold">{labels[item.id]}: {item.id === 'fm.read' && state.label === 'Available' ? 'Readable' : state.label}</p>
          <p>{state.reason}</p>
          <p>Support: {item.support.status}. Policy: {item.policy.status}.</p>
          <p>Access: {item.access.status === 'unknown' ? 'assessment unknown' : item.access.status}.{item.access.reason && ` ${item.access.reason}`}</p>
          <p>Availability: {item.availability.status === 'unknown' ? 'assessment unknown' : item.availability.status}.{item.availability.reason && ` ${item.availability.reason}`}</p>
          {item.availabilityEvidence && <p>FM observation: {item.availabilityEvidence.observedAt} · expires: {item.availabilityEvidence.validUntil}</p>}
        </div>;
      })}
      <p>Assessments do not authorize requests. The server checks every lifecycle action.</p>
    </div>
  </details>;
}

export function CapabilityActionButton({ view, disabled, disabledReason, onClick, children, className, label }: {
  view?: CapabilityView; disabled?: boolean; disabledReason?: string; onClick?: () => void; children: ReactNode; className: string; label?: string;
}) {
  const explanation = view?.disabled ? `${view.label}: ${view.reason}` : disabled
    ? `Unavailable: ${disabledReason || 'Action is busy or unavailable for the current service state.'}`
    : view ? `${view.label}: ${view.reason}` : undefined;
  return <span className="inline-flex" title={explanation}>
    <button disabled={disabled || view?.disabled} onClick={onClick} className={className}
      aria-label={view ? `${label || (typeof children === 'string' ? children : 'Action')}: ${explanation}` : undefined}>
      {children}
    </button>
  </span>;
}
