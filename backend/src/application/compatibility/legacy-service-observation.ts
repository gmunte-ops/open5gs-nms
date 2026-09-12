import { Observation, ServiceLifecycleAction } from '../../domain/contracts';
import { ServiceActionDto } from '../dto';

/** Preserve legacy fallback payloads without treating missing observations as empty. */
export function legacyObservationValue<T>(observation: Observation<T>): T {
  if (observation.status === 'ok' || observation.status === 'partial') return observation.data;
  throw new Error(observation.reason);
}

export function toLifecycleAction(action: ServiceActionDto['action']): ServiceLifecycleAction {
  return action === 'enable' ? 'enableAtBoot' : action === 'disable' ? 'disableAtBoot' : action;
}
