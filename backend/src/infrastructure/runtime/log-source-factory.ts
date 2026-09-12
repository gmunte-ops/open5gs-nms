import * as k8s from '@kubernetes/client-node';
import { ILogSource } from '../../domain/contracts';
import { KubernetesLogSource } from '../kubernetes/kubernetes-log-source';

/** Lazy infrastructure selection; unknown providers never fall back to host logs. */
export function createLogSource(provider: string, local: ILogSource, kubeconfig: string, namespace: string): ILogSource {
  if (provider === 'local') return local;
  if (provider === 'kubernetes') {
    const config = new k8s.KubeConfig();
    config.loadFromFile(kubeconfig);
    return new KubernetesLogSource(config.makeApiClient(k8s.AppsV1Api), config.makeApiClient(k8s.CoreV1Api), namespace);
  }
  throw new Error(`Unknown log provider '${provider}'`);
}
