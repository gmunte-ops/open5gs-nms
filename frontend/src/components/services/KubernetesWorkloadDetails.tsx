import type { KubernetesWorkloadStatus } from '../../types';

export function KubernetesWorkloadDetails({ workload }: { workload: KubernetesWorkloadStatus }): JSX.Element {
  return (
    <details className="mt-2 text-xs text-nms-text-dim">
      <summary className="cursor-pointer text-nms-accent">
        Current workload · {workload.status === 'unavailable' ? 'details unavailable'
          : workload.status === 'pending' ? 'ReplicaSet pending'
          : `${workload.pods.length} Pod${workload.pods.length === 1 ? '' : 's'}`}
      </summary>
      <div className="mt-2 space-y-2">
        <p>Namespace: <span className="font-mono">{workload.namespace}</span></p>
        {workload.replicaSet && <p>ReplicaSet: <span className="font-mono">{workload.replicaSet.name}</span>
          {workload.replicaSet.revision && ` · revision ${workload.replicaSet.revision}`}</p>}
        {workload.status === 'unavailable' && <p role="status">Pod details unavailable. Deployment status is still shown above.</p>}
        {workload.status === 'pending' && <p>No ReplicaSet matches the current Deployment template yet.</p>}
        {workload.status === 'available' && workload.pods.length === 0 && <p>No current non-terminating Pods.</p>}
        {workload.pods.length > 0 && <table className="w-full text-left">
          <thead><tr><th className="pr-3">Pod / phase</th><th className="pr-3">Node</th><th className="pr-3">Ready</th><th>Restarts</th></tr></thead>
          <tbody>{workload.pods.map(pod => <tr key={pod.uid}>
            <td className="pr-3 py-1 font-mono">{pod.name}<span className="block font-sans">{pod.phase}</span></td>
            <td className="pr-3 font-mono">{pod.node ?? 'Unscheduled'}</td>
            <td className="pr-3">{pod.ready === null ? 'Unknown' : pod.ready ? 'Yes' : 'No'}</td>
            <td title={pod.containers.map(container => `${container.name} (${container.kind}): ${container.restartCount ?? 'unknown'}`).join('; ')}>
              {pod.restartCount ?? '—'}
            </td>
          </tr>)}</tbody>
        </table>}
        <p>Supplementary Pod observations. Restarts include regular and init containers in current Pods only.</p>
      </div>
    </details>
  );
}
