import type { ICapabilityDiscovery } from './capability';
import type { IServiceStatusReader } from './service-operations';
import type { TargetId } from './target';
import type { ServiceStatus } from '../entities/service-status';

/** Optional per-service placement; never implies lifecycle ownership. */
export interface ServicePresentation {
  readonly domain: string;
  readonly platform: string;
  readonly hostAddress?: string;
  readonly hostName?: string;
  readonly instanceId?: string;
}

/** Presentation metadata is supplied by composition, independent of NMS hosting. */
export interface ServiceTargetMetadata {
  readonly targetId: TargetId;
  readonly label: string;
  readonly group: string;
  readonly serviceLabels: Readonly<Record<string, string>>;
}

/** Additional observation targets cannot participate in legacy lifecycle routing. */
export interface ReadOnlyServiceTarget {
  readonly metadata: ServiceTargetMetadata;
  readonly reader: IServiceStatusReader<ServiceStatus<string>> & ICapabilityDiscovery;
}
