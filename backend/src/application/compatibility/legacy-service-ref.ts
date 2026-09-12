import type { ServiceRef, TargetId } from '../../domain/contracts';
import { SERVICE_UNIT_MAP, ServiceName } from '../../domain/entities/service-status';

/** Identity bridge only; it does not transform status, select a runtime or perform I/O. */
export function toServiceRef(targetId: TargetId, name: ServiceName): ServiceRef {
  return { targetId, nf: name };
}

/**
 * Legacy entry points address a single configured target. Refuse to erase a
 * different target's identity or translate an unknown NF into a local service.
 * The service monitor uses this bridge while its public DTOs retain NF names.
 */
export function toLegacyServiceName(ref: ServiceRef, expectedTargetId: TargetId): ServiceName {
  if (ref.targetId !== expectedTargetId) throw new Error('Service reference belongs to a different target');
  if (!Object.prototype.hasOwnProperty.call(SERVICE_UNIT_MAP, ref.nf)) {
    throw new Error(`Service '${ref.nf}' is not supported by the legacy service contract`);
  }
  return ref.nf as ServiceName;
}
