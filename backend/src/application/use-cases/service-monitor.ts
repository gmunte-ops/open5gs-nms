import pino from 'pino';
import { IServiceStatusReader, ILifecycleOperations } from '../../domain/contracts';
import { toServiceRef, toLegacyServiceName } from '../compatibility/legacy-service-ref';
import { legacyObservationValue, toLifecycleAction } from '../compatibility/legacy-service-observation';
import { IWebSocketBroadcaster } from '../../domain/interfaces/websocket-broadcaster';
import { IAuditLogger } from '../../domain/interfaces/audit-logger';
import { ServiceStatus, ServiceName } from '../../domain/entities/service-status';
import { ServiceActionDto, ServiceStatusDto } from '../dto';

export class ServiceMonitorUseCase {
  private statusCache: Record<string, ServiceStatus> = {};
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly services: IServiceStatusReader<ServiceStatus> & ILifecycleOperations,
    private readonly wsBroadcaster: IWebSocketBroadcaster,
    private readonly auditLogger: IAuditLogger,
    private readonly logger: pino.Logger,
  ) {}

  async getAll(): Promise<ServiceStatusDto[]> {
    const results: ServiceStatusDto[] = [];
    for (const ref of this.services.listServices()) {
      const status = await this.getServiceStatus(toLegacyServiceName(ref, this.services.targetId));
      results.push(status);
    }
    return results;
  }

  async getOne(name: ServiceName): Promise<ServiceStatusDto> {
    return this.getServiceStatus(name);
  }

  async executeAction(dto: ServiceActionDto): Promise<{ success: boolean; message: string }> {
    const policy = this.services.getActionPolicy(toServiceRef(this.services.targetId, dto.service), toLifecycleAction(dto.action));
    if (!policy.allowed) {
      const message = policy.reason;
      this.logger.warn({ service: dto.service, action: dto.action }, policy.logMessage);

      await this.auditLogger.log({
        action: `service_${dto.action}` as any,
        user: 'admin',
        target: dto.service,
        details: message,
        success: false,
      });

      return {
        success: false,
        message,
      };
    }

    this.logger.info({ service: dto.service, action: dto.action }, 'Executing service action');

    try {
      const result = await this.services.execute(toServiceRef(this.services.targetId, dto.service), toLifecycleAction(dto.action));
      const success = result.success;
      await this.auditLogger.log({
        action: `service_${dto.action}` as any,
        user: 'admin',
        target: dto.service,
        details: success ? `${dto.action} successful` : result.error,
        success,
      });

      return {
        success,
        message: success ? `Service ${dto.service} ${dto.action} successful` : result.error,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error({ err: msg, service: dto.service }, 'Service action failed');
      return { success: false, message: msg };
    }
  }

  async executeAllAction(action: 'start' | 'stop' | 'restart', serviceFilter?: string[]): Promise<{ success: boolean; message: string; results: Array<{ service: string; success: boolean }> }> {
    this.logger.info({ action, serviceFilter }, 'Executing action on services');
    const results: Array<{ service: string; success: boolean }> = [];

    let services = this.services.getBulkOrder(action).map(ref => toLegacyServiceName(ref, this.services.targetId));

    // Filter to only the requested services if a filter was provided
    if (serviceFilter && serviceFilter.length > 0) {
      services = services.filter(s => serviceFilter.includes(s));
    }

    for (const service of services) {
      const result = await this.executeAction({ service, action });
      results.push({ service, success: result.success });
      if (!result.success) {
        this.logger.warn({ service, action }, 'Service action failed, continuing with others');
      }
      await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay between services
    }

    const allSuccess = results.every(r => r.success);
    return {
      success: allSuccess,
      message: allSuccess ? `All services ${action} successful` : `Some services failed to ${action}`,
      results,
    };
  }

  startPolling(intervalMs: number = 3000): void {
    if (this.interval) return;
    this.logger.info({ intervalMs }, 'Starting service status polling');

    this.interval = setInterval(async () => {
      try {
        const statuses = await this.getAll();
        this.wsBroadcaster.broadcastServiceStatus(statuses);
      } catch (err) {
        this.logger.error({ err }, 'Polling error');
      }
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  getStatusCache(): Record<string, ServiceStatus> {
    return { ...this.statusCache };
  }

  // Public method for topology endpoint to get fresh MongoDB status
  async getMongoStatus(): Promise<{ active: boolean; source: string }> {
    const status = this.isRuntimeManaged('mongodb')
      ? await this.getOne('mongodb')
      : legacyObservationValue(await this.services.getReachability(toServiceRef(this.services.targetId, 'mongodb')));
    return { active: status.active, source: status.source || 'direct' };
  }

  isRuntimeManaged(name: ServiceName): boolean {
    return this.services.usesAuthoritativeStatus(toServiceRef(this.services.targetId, name));
  }

  private async getServiceStatus(name: ServiceName): Promise<ServiceStatusDto> {
    const status = legacyObservationValue(await this.services.getStatus(toServiceRef(this.services.targetId, name)));
    this.statusCache[name] = status;
    return status;
  }
}
