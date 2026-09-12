import { Observation } from './observation';
import { ServiceRef, TargetId } from './target';

export type BulkServiceAction = 'start' | 'stop' | 'restart';
export type ServiceLifecycleAction = BulkServiceAction | 'enableAtBoot' | 'disableAtBoot';
export type LifecyclePolicy = { allowed: true } | { allowed: false; reason: string; logMessage: string };

/** Payload remains generic during incremental migration of existing API DTOs. */
export interface IServiceStatusReader<T> {
  readonly targetId: TargetId;
  listServices(): readonly ServiceRef[];
  /** External authoritative status also supplies topology reachability. */
  usesAuthoritativeStatus(service: ServiceRef): boolean;
  getStatus(service: ServiceRef): Promise<Observation<T>>;
  /** Fresh reachability probe, independent of cached service-manager status. */
  getReachability(service: ServiceRef): Promise<Observation<{ active: boolean; source: string }>>;
}

export interface ILifecycleOperations {
  getActionPolicy(service: ServiceRef, action: ServiceLifecycleAction): LifecyclePolicy;
  getBulkOrder(action: BulkServiceAction): readonly ServiceRef[];
  /** Command failures are results; infrastructure exceptions remain exceptions. */
  execute(service: ServiceRef, action: ServiceLifecycleAction): Promise<{ success: boolean; error: string }>;
}
