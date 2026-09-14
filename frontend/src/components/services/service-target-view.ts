import type { ServiceStatus } from '../../types';
import type { CapabilityLoad } from './capability-view';

export function servicePresentationLabel(service: ServiceStatus): string | undefined {
  const placement = service.presentation;
  if (placement) return `${placement.domain} / ${placement.platform}${placement.hostAddress ? ` · ${placement.hostAddress}` : ''}`;
  return service.target ? `${service.target.group} / ${service.target.label}` : undefined;
}

/** Metadata routes presentation; it never selects a platform or grants control. */
export function serviceTargetGroups(statuses: readonly ServiceStatus[]) {
  const groups = new Map<string, { key: string; label: string; services: ServiceStatus[] }>();
  for (const service of statuses) {
    if (!service.target) continue;
    const { targetId, group, label } = service.target;
    if (!groups.has(targetId)) groups.set(targetId, { key: targetId, label: `${group} / ${label}`, services: [] });
    groups.get(targetId)!.services.push(service);
  }
  return [...groups.values()];
}

export function serviceCapabilityLoad(service: ServiceStatus, primary: Record<string, CapabilityLoad>): CapabilityLoad {
  if (service.target) return service.capabilities ? { status: 'ready', data: service.capabilities } : { status: 'unavailable' };
  return primary[service.name] ?? { status: 'loading' };
}
