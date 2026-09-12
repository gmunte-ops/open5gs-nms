import type { ServiceCapability, ServiceCapabilityObservation } from '../../types/service-capabilities';

export interface CapabilityLoad {
  status: 'loading' | 'ready' | 'partial' | 'unavailable';
  data?: ServiceCapability[];
}
export type LifecycleAction = 'start' | 'stop' | 'restart' | 'enable' | 'disable';
export interface CapabilityView { disabled: boolean; label: string; reason: string }
export const capabilityId = (action: LifecycleAction) => `lifecycle.${action === 'enable' ? 'enableAtBoot' : action === 'disable' ? 'disableAtBoot' : action}`;

/** Expire a displayed FM assessment locally; this never schedules a request. */
export function currentCapability(capability: ServiceCapability, now = Date.now()): ServiceCapability {
  const evidence = capability.availabilityEvidence;
  if (capability.id !== 'fm.read' || !evidence) return capability;
  const observed = Date.parse(evidence.observedAt);
  const expires = Date.parse(evidence.validUntil);
  return Number.isFinite(observed) && Number.isFinite(expires) && observed <= now && now < expires ? capability
    : { ...capability, availability: { status: 'unknown', reason: 'FM availability evidence is stale; the current assessment is unknown.' } };
}

export function capabilityView(capability?: ServiceCapability, actionsSupported?: boolean): CapabilityView {
  if (capability) capability = currentCapability(capability);
  if (capability?.policy.status === 'denied') return { disabled: true, label: 'Blocked by target policy', reason: capability.policy.reason || 'The target policy blocks this operation.' };
  if (capability?.support.status === 'unsupported') return { disabled: true, label: 'Unavailable', reason: capability.support.reason || 'This operation is not implemented for this service.' };
  if (actionsSupported === false) return { disabled: true, label: 'Unavailable', reason: 'The service reports lifecycle actions as unsupported. Server guards remain authoritative.' };
  if (capability?.access.status === 'denied') return { disabled: true, label: 'Access denied', reason: capability.access.reason || 'The provider access assessment reports denial.' };
  if (capability?.availability.status === 'unavailable') return { disabled: true, label: 'Unavailable', reason: capability.availability.reason || 'The provider availability assessment reports unavailable.' };
  if (!capability) return { disabled: false, label: 'Assessment unknown', reason: 'Capability assessment unavailable. Existing controls and server guards still apply.' };
  return { disabled: false, label: 'Available', reason: 'Supported and allowed by target policy. Server authorization and lifecycle guards still apply.' };
}

export function actionView(load: CapabilityLoad | undefined, action: LifecycleAction, actionsSupported?: boolean): CapabilityView {
  return capabilityView(load?.data?.find(item => item.id === capabilityId(action)), actionsSupported);
}

/** Fetch failures are isolated per subject; this function accepts no mutation API. */
export async function loadCapabilities(read: (name?: string) => Promise<ServiceCapabilityObservation>, name?: string): Promise<CapabilityLoad> {
  try {
    const result = await read(name);
    if ((result.status !== 'ok' && result.status !== 'partial') || !Array.isArray(result.data)) return { status: 'unavailable' };
    const data = result.data.filter(item => item && item.scope &&
      (name === undefined ? item.scope.kind === 'target' : item.scope.kind === 'service' && item.scope.service.nf === name) &&
      ['supported', 'unsupported'].includes(item.support?.status) && ['allowed', 'denied'].includes(item.policy?.status) &&
      ['allowed', 'denied', 'unknown'].includes(item.access?.status) && ['available', 'unavailable', 'unknown'].includes(item.availability?.status));
    if (!data.length) return { status: 'unavailable' };
    return { status: result.status === 'partial' || data.length !== result.data.length ? 'partial' : 'ready', data };
  } catch { return { status: 'unavailable' }; }
}

export function bulkActionView(services: readonly { name: string; actionsSupported?: boolean }[], loads: Record<string, CapabilityLoad>, action: LifecycleAction): CapabilityView {
  const views = services.map(service => ({ name: service.name, view: actionView(loads[service.name], action, service.actionsSupported) }));
  const blocked = views.find(item => item.view.disabled);
  if (blocked) return { ...blocked.view, reason: `${blocked.name.toUpperCase()}: ${blocked.view.reason}` };
  const unknown = views.find(item => item.view.label === 'Assessment unknown');
  return unknown?.view ?? { disabled: false, label: 'Available', reason: 'Allowed by service policies. Server authorization and lifecycle guards still apply.' };
}
