import type * as k8s from '@kubernetes/client-node';
import { ILogSource, LogEntry, LogReadRequest, LogSourceError, ServiceRef } from '../../domain/contracts';
import { ServiceName } from '../../domain/entities/service-status';
import { KubernetesWorkloadResolver } from './kubernetes-workload-resolver';
import { DEPLOYMENT_MAP } from './kubernetes-service-runtime';

type Apps = Pick<k8s.AppsV1Api, 'readNamespacedDeployment' | 'listNamespacedReplicaSet'>;
type Core = Pick<k8s.CoreV1Api, 'listNamespacedPod' | 'readNamespacedPodLog'>;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function status(error: any): number | undefined {
  return error?.code ?? error?.statusCode ?? error?.response?.statusCode ?? error?.response?.status;
}

/** Bounded snapshots only. Never caches Pod identity or falls back to local files. */
export class KubernetesLogSource implements ILogSource {
  private readonly resolver: KubernetesWorkloadResolver;
  constructor(private readonly apps: Apps, private readonly core: Core,
    private readonly namespace: string, readonly targetId = 'kubernetes') {
    this.resolver = new KubernetesWorkloadResolver(apps, core, namespace);
  }

  private async select(service: ServiceRef) {
    if (service.targetId !== this.targetId) throw new LogSourceError('LOG_TARGET_MISMATCH', 'Log service belongs to a different target');
    // The exact same logical NF mapping as FM; no name-prefix discovery.
    const name = Object.prototype.hasOwnProperty.call(DEPLOYMENT_MAP, service.nf)
      && service.nf !== 'mongodb' ? DEPLOYMENT_MAP[service.nf as ServiceName] : undefined;
    if (!name) throw new LogSourceError('LOG_UNSUPPORTED', 'No NF log workload is configured for this service');
    const deployment = await this.apps.readNamespacedDeployment({ namespace: this.namespace, name });
    if (deployment.metadata?.deletionTimestamp || !deployment.spec?.replicas) {
      throw new LogSourceError('LOG_NOT_FOUND', 'No current NF Pod is available');
    }
    const workload = await this.resolver.resolve(deployment);
    if (workload.status === 'unavailable') throw new LogSourceError('LOG_OBSERVATION_FAILED', 'Unable to resolve current NF workload');
    const rank = (pod: typeof workload.pods[number]) => pod.phase === 'Running' ? pod.ready === true ? 0 : 1 : 2;
    const pod = [...workload.pods].sort((a, b) => rank(a) - rank(b) || compare(a.name, b.name) || compare(a.uid, b.uid))[0];
    if (!pod || !workload.replicaSet) throw new LogSourceError('LOG_NOT_FOUND', 'No current NF Pod is available');
    const declared = deployment.spec.template.spec?.containers ?? [];
    const explicit = deployment.spec.template.metadata?.annotations?.['kubectl.kubernetes.io/default-container'];
    const container = explicit ?? (declared.length === 1 ? declared[0].name : undefined);
    if (!container || !declared.some(c => c.name === container)
      || !pod.containers.some(c => c.kind === 'regular' && c.name === container)) {
      throw new LogSourceError('LOG_CONTAINER_AMBIGUOUS', 'Configure a valid default-container on the NF Deployment template');
    }
    return { name, deploymentUid: workload.deploymentUid!, generation: workload.deploymentGeneration,
      replicaSetUid: workload.replicaSet.uid, pod, container };
  }

  private async readService(service: ServiceRef, limit: number): Promise<LogEntry[]> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const selected = await this.select(service);
        let text: string;
        try {
          text = await this.core.readNamespacedPodLog({ namespace: this.namespace, name: selected.pod.name,
            container: selected.container, tailLines: limit, limitBytes: 1024 * 1024,
            timestamps: true, follow: false, previous: false });
        } catch (error) {
          if (status(error) === 404 && attempt === 0) continue;
          throw error;
        }
        // pods/log has no UID precondition: discard data if a rollout/replacement
        // changed the selected identity while the named log request was in flight.
        const current = await this.select(service);
        if (selected.deploymentUid !== current.deploymentUid || selected.generation !== current.generation
          || selected.replicaSetUid !== current.replicaSetUid || selected.pod.uid !== current.pod.uid
          || selected.pod.name !== current.pod.name || selected.container !== current.container) {
          if (attempt === 0) continue;
          throw new LogSourceError('LOG_IDENTITY_CHANGED', 'NF instance changed during log read; retry the request');
        }
        const origin = { instance: { service, id: selected.pod.uid }, component: selected.container,
          attributes: { namespace: this.namespace, deployment: selected.name, deploymentUid: selected.deploymentUid,
            replicaSetUid: selected.replicaSetUid, pod: selected.pod.name, podUid: selected.pod.uid } };
        return text.split('\n').filter(line => line.trim()).map(line => {
          // Kubernetes timestamps provide timezone-aware ordering. Preserve the NF
          // message, including its own timestamp; never assume NMS host timezone.
          const match = /^(\S+) (.*)$/.exec(line);
          if (!match || !Number.isFinite(Date.parse(match[1]))) {
            throw new LogSourceError('LOG_INVALID_RESPONSE', 'NF log response has no valid timestamp');
          }
          return { service: service.nf, timestamp: new Date(match[1]).toISOString(), message: match[2], origin };
        });
      } catch (error) {
        if (error instanceof LogSourceError) throw error;
        if (status(error) === 403 || status(error) === 401) throw new LogSourceError('LOG_ACCESS_DENIED', 'Access to NF logs was denied');
        if (status(error) === 404) throw new LogSourceError('LOG_NOT_FOUND', 'NF workload or log is no longer available');
        throw new LogSourceError('LOG_READ_FAILED', 'Unable to read NF logs from the target API');
      }
    }
    throw new LogSourceError('LOG_IDENTITY_CHANGED', 'NF instance changed during log read; retry the request');
  }

  async readRecent(request: LogReadRequest): Promise<LogEntry[]> {
    const limit = request.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new LogSourceError('LOG_INVALID_REQUEST', 'Recent log limit must be between 1 and 10000');
    const entries: LogEntry[] = [];
    for (const service of request.services) entries.push(...await this.readService(service, limit));
    return entries.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)).slice(-limit);
  }

  async readMajorEventCandidates(): Promise<LogEntry[]> { throw new LogSourceError('LOG_UNSUPPORTED', 'Major Events history is not supported by this log source'); }
  async readText(): Promise<string> { throw new LogSourceError('LOG_UNSUPPORTED', 'Raw log downloads are not supported by this log source'); }
  follow(): never { throw new LogSourceError('LOG_UNSUPPORTED', 'Following logs is not supported by this log source'); }
}
