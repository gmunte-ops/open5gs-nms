import { ReadOnlyServiceTarget } from '../../domain/contracts/service-target';
import { ServiceStatus } from '../../domain/entities/service-status';
import { DockerServiceProvider, IMS_SERVICES } from '../docker/docker-service-provider';
import { ServiceProviderRegistry } from './service-provider-registry';

/** Explicit additional targets; OPEN5GS_RUNTIME remains the primary target selector. */
export function additionalServiceTargets(raw: string | undefined, primaryTargetId: string): ReadOnlyServiceTarget[] {
  const configs: unknown = JSON.parse(raw || '[]');
  if (!Array.isArray(configs)) throw new Error('NMS_RUNTIME_TARGETS must be an array');
  const ids = new Set([primaryTargetId]);
  return configs.map(config => {
    if (!config || typeof config.targetId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(config.targetId) ||
        ids.has(config.targetId) || typeof config.endpoint !== 'string' || typeof config.platform !== 'string') {
      throw new Error('Invalid or duplicate runtime target');
    }
    ids.add(config.targetId);
    const registry = new ServiceProviderRegistry<ServiceStatus<string>>()
      .register('docker', () => new DockerServiceProvider(config));
    const reader = registry.create(config.platform);
    return { reader, metadata: { targetId: reader.targetId, group: 'IMS',
      label: `Docker · ${new URL(config.endpoint).hostname}`, serviceLabels: IMS_SERVICES } };
  });
}
