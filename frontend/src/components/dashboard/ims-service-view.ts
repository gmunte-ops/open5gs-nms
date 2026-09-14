import type { ServiceStatus } from '../../types';
import type { ImsStatus } from '../../api/ims';

export const IMS_FUNCTIONS = ['pcscf', 'icscf', 'scscf'] as const;

/** The inventory owns a logical service even when its current read is unavailable. */
export function hasSemanticService(statuses: readonly ServiceStatus[], name: string): boolean {
  return statuses.some(service => service.name === name);
}

export function imsServiceView(statuses: readonly ServiceStatus[], legacy: ImsStatus | null) {
  const services = statuses.filter(service => IMS_FUNCTIONS.includes(service.name as typeof IMS_FUNCTIONS[number]));
  if (!services.length) return { semantic: false, active: !!legacy?.imsEnabled,
    label: !legacy ? '…' : legacy.imsEnabled ? 'Active' : legacy.installed ? 'Stopped' : 'Not Installed' };
  const unavailable = services.some(service =>
    (service.observation && service.observation.status !== 'ok') ||
    ['unknown', 'unavailable', 'unsupported'].includes(service.state));
  if (unavailable) return { semantic: true, active: false, label: 'Unavailable' };
  // Do not assemble a healthy IMS installation from unrelated partial targets.
  const targets = new Set(services.map(service => service.target?.targetId ?? 'primary'));
  const complete = [...targets].every(target => IMS_FUNCTIONS.every(name => services.some(service =>
    (service.target?.targetId ?? 'primary') === target && service.name === name)));
  if (services.every(service => ['missing', 'not-deployed'].includes(service.state))) {
    return { semantic: true, active: false, label: 'Not Installed' };
  }
  const active = complete && services.every(service => service.active);
  const stopped = complete && services.every(service => ['stopped', 'inactive'].includes(service.state));
  return { semantic: true, active, label: active ? 'Active' : stopped ? 'Stopped' : 'Degraded' };
}
