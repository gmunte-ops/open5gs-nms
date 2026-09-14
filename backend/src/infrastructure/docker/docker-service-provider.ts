import { Observation, ServiceRef, ResourceScope, ServiceLifecycleAction } from '../../domain/contracts';
import { ServiceStatus } from '../../domain/entities/service-status';
import { ServiceProvider } from '../runtime/service-provider-registry';
import { ServiceCapabilityDiscovery } from '../runtime/service-capability-discovery';
import { z } from 'zod';

const inventorySchema = z.array(z.object({ Id: z.string().min(1), Names: z.array(z.string()) }));
const inspectionSchema = z.object({
  Id: z.string().min(1), Name: z.string(), RestartCount: z.number().int().nonnegative().optional(),
  State: z.object({ Running: z.boolean(),
    Status: z.enum(['running', 'created', 'exited', 'paused', 'restarting', 'removing', 'dead']),
    StartedAt: z.string().optional(),
    Health: z.object({ Status: z.enum(['healthy', 'unhealthy', 'starting']) }).optional(),
  }),
});

export const IMS_SERVICES = Object.freeze({
  pcscf: 'P-CSCF', icscf: 'I-CSCF', scscf: 'S-CSCF', pyhss: 'PyHSS',
  rtpengine: 'RTPengine', dns: 'DNS', mysql: 'MySQL',
});

export interface DockerTargetOptions { targetId: string; endpoint: string }
type Request = typeof fetch;
class ApiError extends Error {
  constructor(readonly status: number) { super(`Docker API returned HTTP ${status}`); }
}

/** Only GET is implemented. No host executor, shell, logs, or lifecycle transport. */
export class DockerServiceProvider implements ServiceProvider<ServiceStatus<string>> {
  readonly targetId: string;
  private readonly endpoint: string;
  private readonly capabilities: ServiceCapabilityDiscovery;
  private inventoryRequest?: Promise<{ prefix: string; containers: z.infer<typeof inventorySchema> }>;

  constructor(options: DockerTargetOptions, private readonly request: Request = fetch) {
    const endpoint = new URL(options.endpoint);
    if (!options.targetId || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash || endpoint.pathname !== '/') throw new Error('Invalid Docker target configuration');
    this.endpoint = endpoint.origin;
    this.targetId = options.targetId;
    this.capabilities = new ServiceCapabilityDiscovery(this.targetId, () => this.listServices(), this, () => false);
  }

  listServices(): readonly ServiceRef[] {
    return Object.keys(IMS_SERVICES).map(nf => ({ targetId: this.targetId, nf }));
  }
  private accepts(service: ServiceRef): boolean {
    return service.targetId === this.targetId && Object.hasOwn(IMS_SERVICES, service.nf);
  }
  usesAuthoritativeStatus(service: ServiceRef): boolean { return this.accepts(service); }
  describe(scope: ResourceScope) { return this.capabilities.describe(scope); }
  getActionPolicy(_service: ServiceRef, _action: ServiceLifecycleAction) {
    return { allowed: false as const, reason: 'Target policy permits read-only service observations only.', logMessage: 'Read-only target lifecycle denied' };
  }
  getBulkOrder(_action: ServiceLifecycleAction): readonly ServiceRef[] { return []; }
  async execute(service: ServiceRef, action: ServiceLifecycleAction) {
    return { success: false, error: this.getActionPolicy(service, action).reason };
  }

  private async get(path: string): Promise<Response> {
    const response = await this.request(`${this.endpoint}${path}`, {
      method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new ApiError(response.status);
    return response;
  }

  private inventory() {
    // Coalesce simultaneous reads only; each subsequent FM read resolves fresh identity.
    if (!this.inventoryRequest) this.inventoryRequest = (async () => {
      const ping = await this.get('/_ping');
      if ((await ping.text()).trim() !== 'OK') throw new Error('Invalid ping response');
      const version = ping.headers.get('API-Version');
      const prefix = version && /^\d+\.\d+$/.test(version) ? `/v${version}` : '';
      const containers = inventorySchema.parse(await (await this.get(`${prefix}/containers/json?all=true`)).json());
      return { prefix, containers };
    })().finally(() => { this.inventoryRequest = undefined; });
    return this.inventoryRequest;
  }

  async getStatus(service: ServiceRef): Promise<Observation<ServiceStatus<string>>> {
    const metadata = { observedAt: new Date().toISOString(), sources: [{ provider: 'docker', scope: { kind: 'service' as const, service } }] };
    if (!this.accepts(service)) return { ...metadata, status: 'not-found', reason: 'Target or service is not registered with this provider' };
    try {
      // Re-list once if a selected container disappears during inspection. Never reuse stale identity.
      for (let attempt = 0; attempt < 2; attempt++) {
        const { prefix, containers } = await this.inventory();
        const matches = containers.filter(c => c.Names.includes(`/${service.nf}`));
        if (matches.length > 1) throw new Error('Ambiguous container identity');
        if (!matches.length) return { ...metadata, status: 'ok', data: this.row(service, metadata.observedAt, 'missing', 'absent', false) };
        const id = matches[0].Id;
        let container;
        try { container = inspectionSchema.parse(await (await this.get(`${prefix}/containers/${encodeURIComponent(id)}/json`)).json()); }
        catch (error) { if (error instanceof ApiError && error.status === 404 && attempt === 0) continue; throw error; }
        if (container.Id !== id || container.Name !== `/${service.nf}`) throw new Error('Invalid container inspection');
        const state = container.State;
        if (state.Status === 'running' && !state.Running) throw new Error('Inconsistent container state');
        const running = state.Status === 'running' && state.Running;
        const degraded = ['paused', 'restarting', 'removing', 'dead'].includes(state.Status) || (running && state.Health && state.Health.Status !== 'healthy');
        const data = this.row(service, metadata.observedAt, degraded ? 'degraded' : running ? 'running' : 'stopped', state.Health?.Status || state.Status, running && !degraded);
        data.restartCount = container.RestartCount ?? null;
        data.uptime = running && state.StartedAt && Number.isFinite(Date.parse(state.StartedAt)) ? state.StartedAt : null;
        return { ...metadata, sources: [{ provider: 'docker', scope: { kind: 'instance', instance: { service, id } } }], status: 'ok', data };
      }
      throw new Error('Container changed during observation');
    } catch (error) {
      // Never expose Engine response bodies (inspect may contain environment secrets).
      const reason = error instanceof ApiError ? error.message : 'Docker API observation unavailable: unreachable or invalid response';
      return { ...metadata, status: 'unavailable', reason };
    }
  }

  async getReachability(service: ServiceRef): Promise<Observation<{ active: boolean; source: string }>> {
    const observation = await this.getStatus(service);
    if (observation.status === 'ok' || observation.status === 'partial') return { ...observation, data: { active: observation.data.active, source: 'docker' } };
    return observation;
  }

  private row(service: ServiceRef, observedAt: string, state: string, subState: string, active: boolean): ServiceStatus<string> {
    return { name: service.nf, unitName: service.nf, active, enabled: false, state, subState,
      pid: null, uptime: null, restartCount: null, cpuPercent: null, memoryBytes: null, memoryPercent: null,
      lastChecked: observedAt, source: 'docker', actionsSupported: false };
  }
}
