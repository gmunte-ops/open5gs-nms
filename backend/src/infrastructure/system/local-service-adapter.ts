import pino from 'pino';
import * as net from 'net';
import { ICapabilityDiscovery, ICapabilityEvidenceReader, ResourceScope } from '../../domain/contracts';
import { ServiceCapabilityDiscovery } from '../runtime/service-capability-discovery';
import { FmAvailabilityEvidence } from '../runtime/fm-availability-evidence';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { ServiceStatus, ServiceName, SERVICE_UNIT_MAP, SERVICE_RESTART_ORDER } from '../../domain/entities/service-status';
import { IServiceStatusReader, ILifecycleOperations, ServiceRef, TargetId, Observation, ServiceLifecycleAction, BulkServiceAction } from '../../domain/contracts';

/** Existing host behavior, including the legacy MongoDB Docker/TCP fallback. */
export class LocalServiceAdapter implements IServiceStatusReader<ServiceStatus>, ILifecycleOperations, ICapabilityDiscovery {
  private readonly capabilityEvidence: FmAvailabilityEvidence;
  constructor(private readonly hostExecutor: IHostExecutor, private readonly logger: pino.Logger, readonly targetId: TargetId = 'local', capabilityEvidence?: ICapabilityEvidenceReader) {
    this.capabilityEvidence = new FmAvailabilityEvidence(capabilityEvidence);
  }

  describe(scope: ResourceScope) {
    return new ServiceCapabilityDiscovery(this.targetId, () => this.listServices(), this, () => true, this.capabilityEvidence).describe(scope);
  }

  listServices(): readonly ServiceRef[] {
    return Object.keys(SERVICE_UNIT_MAP).map(nf => ({ targetId: this.targetId, nf }));
  }

  usesAuthoritativeStatus(service: ServiceRef): boolean {
    this.resolve(service);
    return false;
  }

  getActionPolicy(service: ServiceRef): { allowed: true } {
    this.resolve(service);
    return { allowed: true };
  }

  getBulkOrder(action: BulkServiceAction): readonly ServiceRef[] {
    const order = action === 'stop' ? [...SERVICE_RESTART_ORDER].reverse() : SERVICE_RESTART_ORDER;
    return order.map(nf => ({ targetId: this.targetId, nf }));
  }

  private resolve(service: ServiceRef): ServiceName {
    if (service.targetId !== this.targetId) throw new Error('Service belongs to another target');
    if (!Object.prototype.hasOwnProperty.call(SERVICE_UNIT_MAP, service.nf)) throw new Error('Unknown service: ' + service.nf);
    return service.nf as ServiceName;
  }

  async execute(service: ServiceRef, action: ServiceLifecycleAction): Promise<{ success: boolean; error: string }> {
    const unit = SERVICE_UNIT_MAP[this.resolve(service)];
    const methods = { start: 'startService', stop: 'stopService', restart: 'restartService', enableAtBoot: 'enableService', disableAtBoot: 'disableService' } as const;
    const result = await this.hostExecutor[methods[action]](unit);
    return { success: result.exitCode === 0, error: result.stderr };
  }

  async getStatus(service: ServiceRef): Promise<Observation<ServiceStatus>> {
    const name = this.resolve(service);
    const { data, collectionSucceeded } = await this.readStatus(name, SERVICE_UNIT_MAP[name]);
    const base = { data, observedAt: data.lastChecked, sources: [{ provider: 'local', scope: { kind: 'service' as const, service } }] };
    const observation: Observation<ServiceStatus> = data.source ? { ...base, status: 'ok' } : { ...base, status: 'partial', issues: [{ code: 'status-read-failed', reason: 'Legacy service status fallback' }] };
    this.capabilityEvidence.record(service, observation, collectionSucceeded);
    return observation;
  }

  async getReachability(service: ServiceRef): Promise<Observation<{ active: boolean; source: string }>> {
    if (this.resolve(service) !== 'mongodb') return { status: 'unsupported', reason: 'No independent reachability probe for this service', observedAt: new Date().toISOString(), sources: [] };
    const status = await this.getMongoDockerStatus();
    return { status: 'ok', data: { active: status.active, source: status.source || 'direct' }, observedAt: status.lastChecked, sources: [{ provider: 'local', scope: { kind: 'service', service } }] };
  }

  private checkMongoTcp(host = '127.0.0.1', port = 27017, timeoutMs = 2000): Promise<boolean> {
    return new Promise((resolve) => {
      const sock = new net.Socket();
      let done = false;
      const finish = (ok: boolean) => {
        if (done) return;
        done = true;
        sock.destroy();
        resolve(ok);
      };
      sock.setTimeout(timeoutMs);
      sock.on('connect',  () => finish(true));
      sock.on('error',    () => finish(false));
      sock.on('timeout',  () => finish(false));
      sock.connect(port, host);
    });
  }

  private async getMongoDockerStatus(): Promise<ServiceStatus> {
    const now = Date.now();
    const shouldLog = (now - this.lastMongoLogTime) >= LocalServiceAdapter.MONGO_LOG_INTERVAL_MS;
    if (shouldLog) this.lastMongoLogTime = now;

    const dockerResult = await this.hostExecutor.executeLocalCommand('bash', ['-c',
      `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null | grep -i mongo || true`,
    ]);

    if (shouldLog) {
      this.logger.info({ dockerOut: dockerResult.stdout.trim() }, 'MongoDB Docker probe output');
    }

    const line = dockerResult.stdout.trim().split('\n')[0] || '';
    const parts = line.split('\t');
    const containerName   = parts[0] || '';
    const containerStatus = parts[1] || '';
    const isRunning       = containerStatus.toLowerCase().startsWith('up');

    const tcpOk = await this.checkMongoTcp();

    if (shouldLog) {
      this.logger.info({ containerName, containerStatus, isRunning, tcpOk }, 'MongoDB Docker status resolved');
    }

    const active = tcpOk;

    return {
      name: 'mongodb',
      unitName: 'mongod',
      active,
      enabled: active,
      state:    active ? 'active'   : 'inactive',
      subState: active ? 'running'  : 'dead',
      pid:          null,
      uptime:       null,
      restartCount: 0,
      cpuPercent:   null,
      memoryBytes:  null,
      memoryPercent: null,
      lastChecked: new Date().toISOString(),
      source: containerName ? 'docker' : 'direct',
    };
  }

  // Timestamp of last MongoDB Docker probe log — used to throttle noisy log output
  private lastMongoLogTime = 0;
  private static MONGO_LOG_INTERVAL_MS = 30 * 1000; // 30 seconds

  private async readStatus(name: ServiceName, unitName: string): Promise<{ data: ServiceStatus; collectionSucceeded: boolean }> {
    // MongoDB special case: check Docker/TCP FIRST if systemctl says inactive
    // This handles users who run MongoDB in Docker instead of as a systemd service.
    if (name === 'mongodb') {
      try {
        const [isActive] = await Promise.all([
          this.hostExecutor.isServiceActive(unitName),
        ]);
        if (!isActive) {
          // systemctl says not active (expected when MongoDB runs in Docker) —
          // check Docker/TCP before reporting red. Log suppressed to once per 15 min.
          const dockerStatus = await this.getMongoDockerStatus();
          return { data: dockerStatus, collectionSucceeded: true };
        }
      } catch {
        // systemctl itself failed (also expected when no mongod unit exists) —
        // try Docker/TCP fallback. Log suppressed to once per 30 sec.
        try {
          const dockerStatus = await this.getMongoDockerStatus();
          return { data: dockerStatus, collectionSucceeded: true };
        } catch (dockerErr) {
          this.logger.warn({ dockerErr: String(dockerErr) }, 'MongoDB Docker fallback failed');
        }
      }
    }

    try {
      const [isActive, isEnabled] = await Promise.all([
        this.hostExecutor.isServiceActive(unitName),
        this.hostExecutor.isServiceEnabled(unitName),
      ]);

      const showResult = await this.hostExecutor.executeCommand(
        'systemctl',
        ['show', unitName, '--no-pager', '--property=ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp,MemoryCurrent,CPUUsageNSec'],
      );

      const props = this.parseSystemctlShow(showResult.stdout);

      const status: ServiceStatus = {
        name,
        unitName,
        active: isActive,
        enabled: isEnabled,
        state: props.ActiveState || 'unknown',
        subState: props.SubState || 'unknown',
        pid: props.MainPID ? parseInt(props.MainPID, 10) || null : null,
        uptime: props.ExecMainStartTimestamp || null,
        restartCount: props.NRestarts ? parseInt(props.NRestarts, 10) : 0,
        cpuPercent: props.CPUUsageNSec
          ? parseFloat(props.CPUUsageNSec) / 1_000_000_000
          : null,
        memoryBytes: props.MemoryCurrent && props.MemoryCurrent !== '[not set]'
          ? parseInt(props.MemoryCurrent, 10)
          : null,
        memoryPercent: null,
        lastChecked: new Date().toISOString(),
        source: 'systemd',
      };
      return { data: status, collectionSucceeded: showResult.exitCode === 0 && !!props.ActiveState && !!props.SubState };
    } catch (err) {
      this.logger.debug({ err, name }, 'Failed to get service status');
      const fallback: ServiceStatus = {
        name,
        unitName,
        active: false,
        enabled: false,
        state: 'unknown',
        subState: 'unknown',
        pid: null,
        uptime: null,
        restartCount: 0,
        cpuPercent: null,
        memoryBytes: null,
        memoryPercent: null,
        lastChecked: new Date().toISOString(),
      };
      return { data: fallback, collectionSucceeded: false };
    }
  }

  private parseSystemctlShow(output: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of output.split('\n')) {
      const eqIndex = line.indexOf('=');
      if (eqIndex > 0) {
        const key = line.substring(0, eqIndex).trim();
        const value = line.substring(eqIndex + 1).trim();
        result[key] = value;
      }
    }
    return result;
  }
}
