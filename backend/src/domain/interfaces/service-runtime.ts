import { ServiceName, ServiceStatus } from '../entities/service-status';

export interface IServiceRuntime {
  handles(service: ServiceName): boolean;
  getServiceStatus(service: ServiceName): Promise<ServiceStatus | null>;
}
