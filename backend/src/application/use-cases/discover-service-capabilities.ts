import { ICapabilityDiscovery, ResourceScope } from '../../domain/contracts';

/** Advisory only: existing execution policy and authorization remain authoritative. */
export class DiscoverServiceCapabilitiesUseCase {
  constructor(private readonly discovery: ICapabilityDiscovery) {}

  execute(scope: ResourceScope) {
    return this.discovery.describe(scope);
  }
}
