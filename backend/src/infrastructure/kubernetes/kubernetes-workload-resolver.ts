import type * as k8s from '@kubernetes/client-node';
import { isDeepStrictEqual } from 'util';
import { KubernetesPodStatus, KubernetesWorkloadStatus } from '../../domain/entities/kubernetes-workload-status';

function controlledBy(metadata: k8s.V1ObjectMeta | undefined, kind: string, uid: string): boolean {
  return !!metadata?.ownerReferences?.some(owner => owner.controller === true && owner.kind === kind && owner.uid === uid);
}

// Kubernetes FindNewReplicaSet compares the desired template ignoring only the
// generated hash label, and chooses the oldest match (also handles rollbacks).
// https://github.com/kubernetes/kubernetes/blob/master/pkg/controller/deployment/util/deployment_util.go
function templateWithoutHash(template: k8s.V1PodTemplateSpec): unknown {
  const copy = JSON.parse(JSON.stringify(template));
  if (copy.metadata?.labels) {
    delete copy.metadata.labels['pod-template-hash'];
    if (!Object.keys(copy.metadata.labels).length) delete copy.metadata.labels;
  }
  return copy;
}

function selectorString(selector: k8s.V1LabelSelector): string {
  const terms = Object.entries(selector.matchLabels ?? {}).map(([key, value]) => `${key}=${value}`);
  for (const expression of selector.matchExpressions ?? []) {
    switch (expression.operator) {
      case 'In': terms.push(`${expression.key} in (${(expression.values ?? []).join(',')})`); break;
      case 'NotIn': terms.push(`${expression.key} notin (${(expression.values ?? []).join(',')})`); break;
      case 'Exists': terms.push(expression.key); break;
      case 'DoesNotExist': terms.push(`!${expression.key}`); break;
      default: throw new Error('Unsupported Deployment label selector');
    }
  }
  if (!terms.length) throw new Error('Deployment has no workload selector');
  return terms.join(',');
}

function podStatus(pod: k8s.V1Pod): KubernetesPodStatus {
  const containers: KubernetesPodStatus['containers'] = [];
  for (const kind of ['regular', 'init'] as const) {
    const specs = kind === 'regular' ? pod.spec?.containers : pod.spec?.initContainers;
    const statuses = kind === 'regular' ? pod.status?.containerStatuses : pod.status?.initContainerStatuses;
    for (const spec of specs ?? []) {
      const status = statuses?.find(container => container.name === spec.name);
      containers.push({ name: spec.name, kind, ready: status?.ready ?? null, restartCount: status?.restartCount ?? null });
    }
  }
  const ready = pod.status?.conditions?.find(condition => condition.type === 'Ready')?.status;
  return {
    name: pod.metadata!.name!, uid: pod.metadata!.uid!, node: pod.spec?.nodeName ?? null,
    phase: pod.status?.phase ?? 'Unknown', ready: ready === 'True' ? true : ready === 'False' ? false : null,
    restartCount: containers.length && containers.every(container => container.restartCount !== null)
      ? containers.reduce((sum, container) => sum + container.restartCount!, 0) : null,
    containers,
  };
}

/** Read-only resolver shared by FM and future logs; no cached Pod identity. */
export class KubernetesWorkloadResolver {
  constructor(
    private readonly appsApi: Pick<k8s.AppsV1Api, 'listNamespacedReplicaSet'>,
    private readonly coreApi: Pick<k8s.CoreV1Api, 'listNamespacedPod'>,
    private readonly namespace: string,
  ) {}

  async resolve(deployment: k8s.V1Deployment): Promise<KubernetesWorkloadStatus> {
    const result: KubernetesWorkloadStatus = {
      namespace: this.namespace, deploymentUid: deployment.metadata?.uid ?? null,
      deploymentGeneration: deployment.metadata?.generation ?? null,
      status: 'pending', replicaSet: null, pods: [],
    };
    try {
      if (!deployment.metadata?.uid || !deployment.spec?.template || !deployment.spec.selector) {
        throw new Error('Deployment identity or template unavailable');
      }
      const labelSelector = selectorString(deployment.spec.selector);
      const replicaSets: k8s.V1ReplicaSet[] = [];
      let continuation: string | undefined;
      do {
        const page = await this.appsApi.listNamespacedReplicaSet({
          namespace: this.namespace, labelSelector, limit: 500, _continue: continuation,
        });
        replicaSets.push(...page.items);
        continuation = page.metadata?._continue;
      } while (continuation);
      const template = templateWithoutHash(deployment.spec.template);
      const current = replicaSets.filter(rs =>
        rs.metadata?.uid && rs.metadata.name && !rs.metadata.deletionTimestamp &&
        controlledBy(rs.metadata, 'Deployment', deployment.metadata!.uid!) &&
        rs.spec?.template && isDeepStrictEqual(templateWithoutHash(rs.spec.template), template),
      ).sort((a, b) => {
        const timestamp = (rs: k8s.V1ReplicaSet) => new Date(rs.metadata?.creationTimestamp ?? 0).getTime();
        return timestamp(a) - timestamp(b) || a.metadata!.name!.localeCompare(b.metadata!.name!);
      })[0];
      // Do not substitute an old ReplicaSet while a new template is pending.
      if (!current) return result;
      result.replicaSet = {
        name: current.metadata!.name!, uid: current.metadata!.uid!,
        revision: current.metadata?.annotations?.['deployment.kubernetes.io/revision'] ?? null,
      };
      const pods: k8s.V1Pod[] = [];
      continuation = undefined;
      do {
        const page = await this.coreApi.listNamespacedPod({
          namespace: this.namespace, labelSelector, limit: 500, _continue: continuation,
        });
        pods.push(...page.items);
        continuation = page.metadata?._continue;
      } while (continuation);
      result.pods = pods.filter(pod =>
        pod.metadata?.uid && pod.metadata.name && !pod.metadata.deletionTimestamp &&
        !['Succeeded', 'Failed'].includes(pod.status?.phase ?? '') &&
        controlledBy(pod.metadata, 'ReplicaSet', current.metadata!.uid!),
      ).map(podStatus).sort((a, b) => a.name.localeCompare(b.name));
      result.status = 'available';
    } catch (err) {
      // Never let supplementary RBAC/network errors turn a healthy Deployment red.
      result.status = 'unavailable';
      result.error = err instanceof Error ? err.message : 'Unable to read ReplicaSet/Pod details';
    }
    return result;
  }
}
