import { IServiceStatusReader, ILifecycleOperations, ICapabilityDiscovery } from '../../domain/contracts';
import { ServiceStatus } from '../../domain/entities/service-status';

export type ServiceProvider = IServiceStatusReader<ServiceStatus> & ILifecycleOperations & ICapabilityDiscovery;

/** Factories are lazy; invalid names and construction errors never select another provider. */
export class ServiceProviderRegistry {
  private readonly factories = new Map<string, () => ServiceProvider>();

  register(name: string, factory: () => ServiceProvider): this {
    if (!name || this.factories.has(name)) throw new Error(`Duplicate or empty service provider '${name}'`);
    this.factories.set(name, factory);
    return this;
  }

  create(name: string): ServiceProvider {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown service provider '${name}'`);
    return factory();
  }
}
