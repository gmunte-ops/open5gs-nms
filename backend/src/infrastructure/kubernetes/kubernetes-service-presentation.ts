import { Observable, type CoreV1Api } from '@kubernetes/client-node';
import { isIP } from 'net';
import type { ServicePresentation } from '../../domain/contracts/service-target';
import type { KubernetesWorkloadStatus } from '../../domain/entities/kubernetes-workload-status';

/** Supplementary placement only. The caller has already resolved current workload ownership. */
export async function kubernetesServicePresentation(
  core: Pick<CoreV1Api, 'readNode'>, workload: KubernetesWorkloadStatus,
): Promise<ServicePresentation> {
  const result: ServicePresentation = { domain: '5G Core', platform: 'Kubernetes' };
  if (workload.status !== 'available' || !workload.replicaSet) return result;
  // Same preference as recent logs: Running+Ready, Running, then other phases;
  // deterministic name/UID ordering breaks ties. Never select an old ReplicaSet.
  const rank = (pod: typeof workload.pods[number]) => pod.phase === 'Running' ? pod.ready === true ? 0 : 1 : 2;
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const pod = [...workload.pods].sort((a, b) => rank(a) - rank(b) || compare(a.name, b.name) || compare(a.uid, b.uid))[0];
  if (!pod) return result;
  const placement = { ...result, instanceId: pod.uid, ...(pod.node ? { hostName: pod.node } : {}) };
  if (!pod.node) return placement;
  try {
    const node = await core.readNode({ name: pod.node }, {
      middlewareMergeStrategy: 'append',
      middleware: [{
        pre: context => { context.setSignal(AbortSignal.timeout(1500)); return new Observable(Promise.resolve(context)); },
        post: context => new Observable(Promise.resolve(context)),
      }],
    });
    if (node.metadata?.name !== pod.node) return placement;
    // Prefer IPv4, then lexical ordering, for deterministic dual-stack presentation.
    // No Pod IP, hostIP, ExternalIP or endpoint-address fallback.
    const addresses = (node.status?.addresses ?? []).filter(address => address.type === 'InternalIP' && isIP(address.address))
      .map(address => address.address).sort((a, b) => isIP(a) - isIP(b) || compare(a, b));
    return addresses.length ? { ...placement, hostAddress: addresses[0] } : placement;
  } catch {
    // RBAC denial, missing Node, timeouts and API errors cannot override FM state.
    return placement;
  }
}
