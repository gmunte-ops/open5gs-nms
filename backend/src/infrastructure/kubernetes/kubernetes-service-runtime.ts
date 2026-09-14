import * as k8s from '@kubernetes/client-node';
import pino from 'pino';

import { IServiceRuntime } from '../../domain/interfaces/service-runtime';
import { ServiceName, ServiceStatus } from '../../domain/entities/service-status';
import { KubernetesWorkloadResolver } from './kubernetes-workload-resolver';
import { kubernetesServicePresentation } from './kubernetes-service-presentation';

export const DEPLOYMENT_MAP: Partial<Record<ServiceName, string>> = {
  mongodb: 'open5gs-mongodb',

  nrf: 'open5gs-nrf',
  scp: 'open5gs-scp',
  amf: 'open5gs-amf',
  smf: 'open5gs-smf',
  upf: 'open5gs-upf',
  ausf: 'open5gs-ausf',
  udm: 'open5gs-udm',
  udr: 'open5gs-udr',
  pcf: 'open5gs-pcf',
  nssf: 'open5gs-nssf',
  bsf: 'open5gs-bsf',
  sepp1: 'open5gs-sepp',

  mme: 'open5gs-mme',
  hss: 'open5gs-hss',
  pcrf: 'open5gs-pcrf',
  sgwc: 'open5gs-sgwc',
  sgwu: 'open5gs-sgwu',
};

export class KubernetesServiceRuntime implements IServiceRuntime {
  private readonly appsApi: k8s.AppsV1Api;
  private readonly coreApi: k8s.CoreV1Api;
  private readonly workloadResolver: KubernetesWorkloadResolver;

  constructor(
    kubeconfigPath: string,
    private readonly namespace: string,
    private readonly logger: pino.Logger,
  ) {
    const kc = new k8s.KubeConfig();
    kc.loadFromFile(kubeconfigPath);
    this.appsApi = kc.makeApiClient(k8s.AppsV1Api);
    this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    this.workloadResolver = new KubernetesWorkloadResolver(this.appsApi, this.coreApi, this.namespace);
  }

  handles(service: ServiceName): boolean {
    return Object.prototype.hasOwnProperty.call(DEPLOYMENT_MAP, service);
  }

  async getServiceStatus(service: ServiceName): Promise<ServiceStatus | null> {
    const deploymentName = DEPLOYMENT_MAP[service];

    if (!deploymentName) {
      return null;
    }

    try {
      const deployment = await this.appsApi.readNamespacedDeployment({
        name: deploymentName,
        namespace: this.namespace,
      });

      const desired = deployment.spec?.replicas ?? 0;
      const ready = deployment.status?.readyReplicas ?? 0;
      const available = deployment.status?.availableReplicas ?? 0;

      const active =
        desired > 0 &&
        ready >= desired &&
        available >= desired;

      let state: string;
      let subState: string;

      if (desired === 0) {
        state = 'inactive';
        subState = 'scaled-down';
      } else if (active) {
        state = 'active';
        subState = 'running';
      } else {
        state = 'degraded';
        subState = 'not-ready';
      }

      const workload = await this.workloadResolver.resolve(deployment);
      const presentation = await kubernetesServicePresentation(this.coreApi, workload);
      const restartCount = workload.status === 'available' && workload.pods.every(pod => pod.restartCount !== null)
        ? workload.pods.reduce((sum, pod) => sum + pod.restartCount!, 0) : null;

      return {
        name: service,
        unitName: deploymentName,
        active,
        enabled: desired > 0,
        state,
        subState,
        pid: null,
        uptime: null,
        restartCount,
        cpuPercent: null,
        memoryBytes: null,
        memoryPercent: null,
        lastChecked: new Date().toISOString(),
        source: 'kubernetes',
        kubernetes: workload,
        presentation,
      };
    } catch (err: any) {
      const statusCode =
        err?.code ??
        err?.statusCode ??
        err?.response?.statusCode ??
        err?.response?.status;

      if (statusCode === 404) {
        return {
          name: service,
          unitName: deploymentName,
          active: false,
          enabled: false,
          state: 'not-deployed',
          presentation: { domain: '5G Core', platform: 'Kubernetes' },
          subState: 'absent',
          pid: null,
          uptime: null,
          restartCount: null,
          cpuPercent: null,
          memoryBytes: null,
          memoryPercent: null,
          lastChecked: new Date().toISOString(),
          source: 'kubernetes',
        };
      }

      this.logger.error(
        {
          err: err instanceof Error ? err.message : String(err),
          service,
          deploymentName,
        },
        'Failed to query Kubernetes deployment',
      );

      throw err;
    }
  }
}
