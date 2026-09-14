import { IServiceStatusReader, ILifecycleOperations, ICapabilityDiscovery } from '../../domain/contracts';
import { ServiceStatus } from '../../domain/entities/service-status';

export type ServiceProvider<T = ServiceStatus> = IServiceStatusReader<T> & ILifecycleOperations & ICapabilityDiscovery;

/** Factories are lazy; invalid names and construction errors never select another provider. */
export class ServiceProviderRegistry<T = ServiceStatus> {
  private readonly factories = new Map<string, () => ServiceProvider<T>>();

  register(name: string, factory: () => ServiceProvider<T>): this {
    if (!name || this.factories.has(name)) throw new Error(`Duplicate or empty service provider '${name}'`);
    this.factories.set(name, factory);
    return this;
  }

  create(name: string): ServiceProvider<T> {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown service provider '${name}'`);
    return factory();
  }
}
