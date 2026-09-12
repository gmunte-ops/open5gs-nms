/** Supplementary observations; Deployment-derived ServiceStatus is authoritative. */
export interface KubernetesWorkloadStatus {
  namespace: string;
  deploymentUid: string | null;
  deploymentGeneration: number | null;
  status: 'available' | 'pending' | 'unavailable';
  replicaSet: { name: string; uid: string; revision: string | null } | null;
  pods: KubernetesPodStatus[];
  error?: string;
}

export interface KubernetesPodStatus {
  name: string;
  uid: string;
  node: string | null;
  phase: string;
  ready: boolean | null;
  // Sum of declared regular + init container restarts; excludes ephemeral containers.
  // Null when a declared container has no reported restart count yet.
  restartCount: number | null;
  containers: Array<{
    name: string;
    kind: 'regular' | 'init';
    ready: boolean | null;
    restartCount: number | null;
  }>;
}
