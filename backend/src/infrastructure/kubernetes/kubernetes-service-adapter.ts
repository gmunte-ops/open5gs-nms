import { IServiceStatusReader, ILifecycleOperations, ServiceRef, Observation, BulkServiceAction, ServiceLifecycleAction, LifecyclePolicy } from '../../domain/contracts';
import { ServiceName, ServiceStatus } from '../../domain/entities/service-status';
import { IServiceRuntime } from '../../domain/interfaces/service-runtime';
import { ICapabilityDiscovery, ICapabilityEvidenceReader, ResourceScope } from '../../domain/contracts';
import { ServiceCapabilityDiscovery } from '../runtime/service-capability-discovery';
import { FmAvailabilityEvidence } from '../runtime/fm-availability-evidence';

type ServiceProvider = IServiceStatusReader<ServiceStatus> & ILifecycleOperations & ICapabilityDiscovery;

/** Compatibility wrapper: Deployment mapping/resolution stays in the existing runtime. */
export class KubernetesServiceAdapter implements IServiceStatusReader<ServiceStatus>, ILifecycleOperations, ICapabilityDiscovery {
  readonly targetId: string;
  private readonly statusCache: Record<string, ServiceStatus> = {};

  private readonly capabilityEvidence: FmAvailabilityEvidence;
  constructor(private readonly runtime: IServiceRuntime, private readonly hostServices: ServiceProvider, capabilityEvidence?: ICapabilityEvidenceReader) {
    this.targetId = hostServices.targetId;
    this.capabilityEvidence = new FmAvailabilityEvidence(capabilityEvidence);
  }

  listServices(): readonly ServiceRef[] { return this.hostServices.listServices(); }
  describe(scope: ResourceScope) {
    if (scope.kind === 'service' && scope.service.targetId === this.targetId &&
      this.listServices().some(ref => ref.nf === scope.service.nf) && !this.runtime.handles(scope.service.nf as ServiceName)) {
      return this.hostServices.describe(scope);
    }
    return new ServiceCapabilityDiscovery(this.targetId, () => this.listServices(), this,
      service => !this.usesAuthoritativeStatus(service), this.capabilityEvidence).describe(scope);
  }
  getBulkOrder(action: BulkServiceAction): readonly ServiceRef[] { return this.hostServices.getBulkOrder(action); }

  private resolve(service: ServiceRef): ServiceName {
    if (service.targetId !== this.targetId) throw new Error('Service belongs to another target');
    if (!this.listServices().some(ref => ref.nf === service.nf)) throw new Error('Unknown service: ' + service.nf);
    return service.nf as ServiceName;
  }

  usesAuthoritativeStatus(service: ServiceRef): boolean {
    return this.runtime.handles(this.resolve(service));
  }

  getActionPolicy(service: ServiceRef, action: ServiceLifecycleAction): LifecyclePolicy {
    if (!this.usesAuthoritativeStatus(service)) return this.hostServices.getActionPolicy(service, action);
    const legacyAction = action === 'enableAtBoot' ? 'enable' : action === 'disableAtBoot' ? 'disable' : action;
    return {
      allowed: false,
      reason: `Action '${legacyAction}' is disabled for Kubernetes-managed service '${service.nf}' (read-only mode)`,
      logMessage: 'Blocked Kubernetes service action in read-only mode',
    };
  }

  async execute(service: ServiceRef, action: ServiceLifecycleAction): Promise<{ success: boolean; error: string }> {
    const policy = this.getActionPolicy(service, action);
    if (!policy.allowed) return { success: false, error: policy.reason };
    return this.hostServices.execute(service, action);
  }

  async getStatus(service: ServiceRef): Promise<Observation<ServiceStatus>> {
    const name = this.resolve(service);
    if (!this.runtime.handles(name)) return this.hostServices.getStatus(service);
    let status: ServiceStatus;
    let failed = false;
    try {
      const runtimeStatus = await this.runtime.getServiceStatus(name);
      if (!runtimeStatus) throw new Error('Runtime returned no service status');
      status = { ...runtimeStatus, actionsSupported: false };
    } catch (err) {
      failed = true;
      // Preserve the legacy unavailable payload and last known Deployment name.
      status = {
        name, unitName: this.statusCache[name]?.unitName ?? name,
        active: false, enabled: false, state: 'unknown', subState: 'unavailable',
        pid: null, uptime: null, restartCount: null, cpuPercent: null,
        memoryBytes: null, memoryPercent: null, lastChecked: new Date().toISOString(),
        source: 'kubernetes', actionsSupported: false,
        presentation: { domain: '5G Core', platform: 'Kubernetes' },
        error: err instanceof Error ? err.message : String(err),
      };
    }
    this.statusCache[name] = status;
    const base = { data: status, observedAt: status.lastChecked, sources: [{ provider: 'kubernetes', scope: { kind: 'service' as const, service } }] };
    const observation: Observation<ServiceStatus> = failed
      ? { ...base, status: 'partial', issues: [{ code: 'status-read-failed', reason: status.error! }] }
      : { ...base, status: 'ok' };
    this.capabilityEvidence.record(service, observation);
    return observation;
  }

  async getReachability(service: ServiceRef): Promise<Observation<{ active: boolean; source: string }>> {
    if (!this.usesAuthoritativeStatus(service)) return this.hostServices.getReachability(service);
    const observation = await this.getStatus(service);
    if (observation.status !== 'ok' && observation.status !== 'partial') return observation;
    return { ...observation, data: { active: observation.data.active, source: observation.data.source || 'direct' } };
  }
}
