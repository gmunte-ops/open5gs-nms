import pino from 'pino';
import { KubernetesServiceRuntime } from '../infrastructure/kubernetes/kubernetes-service-runtime';

const mockReadDeployment = jest.fn();
const mockListReplicaSets = jest.fn();
const mockListPods = jest.fn();
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromFile: jest.fn(),
    makeApiClient: () => ({ readNamespacedDeployment: mockReadDeployment,
      listNamespacedReplicaSet: mockListReplicaSets, listNamespacedPod: mockListPods }),
  })),
  AppsV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
}));

beforeEach(() => { mockReadDeployment.mockReset(); mockListReplicaSets.mockReset(); mockListPods.mockReset(); });
const runtime = () => new KubernetesServiceRuntime('/unused/kubeconfig', 'core', pino({ level: 'silent' }));

test.each([
  [1, 1, 1, 'active'], [2, 1, 1, 'degraded'], [0, 0, 0, 'inactive'],
])('Deployment replicas determine status (%s/%s/%s)', async (desired, ready, available, state) => {
  mockReadDeployment.mockResolvedValue({ spec: { replicas: desired }, status: {
    readyReplicas: ready, availableReplicas: available,
  } });
  expect(await runtime().getServiceStatus('mme')).toMatchObject({
    unitName: 'open5gs-mme', source: 'kubernetes', state, pid: null,
    uptime: null, restartCount: null,
  });
  expect(mockReadDeployment).toHaveBeenCalledWith({ name: 'open5gs-mme', namespace: 'core' });
});

test.each(['scp', 'sepp1'] as const)('absent %s remains Kubernetes-owned', async name => {
  mockReadDeployment.mockRejectedValue({ code: 404 });
  const service = runtime();
  expect(service.handles(name)).toBe(true);
  expect(await service.getServiceStatus(name)).toMatchObject({ state: 'not-deployed', source: 'kubernetes' });
});

test('authorization failure is not reported as absent', async () => {
  mockReadDeployment.mockRejectedValue({ code: 403 });
  await expect(runtime().getServiceStatus('mme')).rejects.toEqual({ code: 403 });
});

test('unrelated host services never query Kubernetes', async () => {
  const service = runtime();
  expect(service.handles('osmo-msc')).toBe(false);
  expect(await service.getServiceStatus('osmo-msc')).toBeNull();
  expect(mockReadDeployment).not.toHaveBeenCalled();
});

test.each([true, false])('Pod lookup failure does not change Deployment active=%s', async active => {
  const template = { metadata: { labels: { app: 'mme' } }, spec: { containers: [{ name: 'mme', image: 'open5gs' }] } };
  mockReadDeployment.mockResolvedValue({ metadata: { uid: 'deployment' }, spec: { replicas: 1,
    selector: { matchLabels: { app: 'mme' } }, template },
  status: { readyReplicas: active ? 1 : 0, availableReplicas: active ? 1 : 0 } });
  mockListReplicaSets.mockResolvedValue({ items: [{ metadata: { name: 'current', uid: 'rs',
    ownerReferences: [{ uid: 'deployment', kind: 'Deployment', controller: true }] }, spec: { template } }] });
  mockListPods.mockRejectedValue(new Error('Forbidden'));
  expect(await runtime().getServiceStatus('mme')).toMatchObject({
    active, state: active ? 'active' : 'degraded', restartCount: null,
    kubernetes: { status: 'unavailable', replicaSet: { name: 'current' } },
  });
});

test('restart total includes only current Pods, without overriding Deployment readiness', async () => {
  const template = { metadata: { labels: { app: 'mme' } }, spec: { containers: [{ name: 'mme', image: 'open5gs' }] } };
  mockReadDeployment.mockResolvedValue({ metadata: { uid: 'deployment' }, spec: { replicas: 2,
    selector: { matchLabels: { app: 'mme' } }, template }, status: { readyReplicas: 2, availableReplicas: 2 } });
  mockListReplicaSets.mockResolvedValue({ items: [{ metadata: { name: 'current', uid: 'rs',
    ownerReferences: [{ uid: 'deployment', kind: 'Deployment', controller: true }] }, spec: { template } }] });
  const makePod = (name: string, owner: string, restarts: number) => ({ metadata: { name, uid: name,
    ownerReferences: [{ kind: 'ReplicaSet', uid: owner, controller: true }] },
  spec: { containers: [{ name: 'mme' }] }, status: { phase: 'Running',
    conditions: [{ type: 'Ready', status: 'False' }], containerStatuses: [{ name: 'mme', restartCount: restarts, ready: false }] } });
  mockListPods.mockResolvedValue({ items: [makePod('one', 'rs', 2), makePod('two', 'rs', 3), makePod('stale', 'old-rs', 100)] });
  const result = await runtime().getServiceStatus('mme');
  expect(result).toMatchObject({ active: true, state: 'active', restartCount: 5 });
  expect(result?.kubernetes?.pods).toHaveLength(2);
  expect(result?.kubernetes?.pods.every(pod => pod.ready === false)).toBe(true);
});
