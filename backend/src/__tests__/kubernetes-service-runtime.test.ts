import pino from 'pino';
import { KubernetesServiceRuntime } from '../infrastructure/kubernetes/kubernetes-service-runtime';

const mockReadDeployment = jest.fn();
const mockListReplicaSets = jest.fn();
const mockListPods = jest.fn();
const mockReadNode = jest.fn();
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromFile: jest.fn(),
    makeApiClient: () => ({ readNamespacedDeployment: mockReadDeployment,
      listNamespacedReplicaSet: mockListReplicaSets, listNamespacedPod: mockListPods, readNode: mockReadNode }),
  })),
  AppsV1Api: jest.fn(),
  CoreV1Api: jest.fn(),
}));

beforeEach(() => { mockReadDeployment.mockReset(); mockListReplicaSets.mockReset(); mockListPods.mockReset(); mockReadNode.mockReset(); });
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

function placementFixture() {
  const template = { metadata: { labels: { app: 'amf' } }, spec: { containers: [{ name: 'amf', image: 'open5gs' }] } };
  mockReadDeployment.mockResolvedValue({ metadata: { uid: 'deployment' }, spec: { replicas: 2,
    selector: { matchLabels: { app: 'amf' } }, template }, status: { readyReplicas: 2, availableReplicas: 2 } });
  mockListReplicaSets.mockResolvedValue({ items: [{ metadata: { name: 'current', uid: 'rs',
    ownerReferences: [{ uid: 'deployment', kind: 'Deployment', controller: true }] }, spec: { template } }] });
  const pod = (name: string, owner: string, ready: boolean, nodeName?: string) => ({
    metadata: { name, uid: `${name}-uid`, ownerReferences: [{ uid: owner, kind: 'ReplicaSet', controller: true }] },
    spec: { nodeName, containers: [{ name: 'amf' }] }, status: { phase: 'Running', podIP: '10.244.1.77', hostIP: '203.0.113.9',
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }] },
  });
  const pods = [pod('a-stale', 'old-rs', true, 'old-worker'), pod('b-not-ready', 'rs', false, 'other-worker'),
    pod('d-ready', 'rs', true, 'second-worker'), pod('c-ready', 'rs', true, 'worker')];
  mockListPods.mockResolvedValue({ items: pods });
  mockReadNode.mockResolvedValue({ metadata: { name: 'worker' }, status: { addresses: [
    { type: 'ExternalIP', address: '203.0.113.5' }, { type: 'InternalIP', address: '192.0.2.25' },
  ] } });
  return { pods };
}

test('current Pod placement exposes Node InternalIP, never Pod IP or stale owner placement', async () => {
  placementFixture();
  const status = await runtime().getServiceStatus('amf');
  expect(status).toMatchObject({ active: true, state: 'active', presentation: {
    domain: '5G Core', platform: 'Kubernetes', instanceId: 'c-ready-uid', hostName: 'worker', hostAddress: '192.0.2.25',
  } });
  expect(mockReadNode).toHaveBeenCalledTimes(1);
  expect(mockReadNode).toHaveBeenCalledWith({ name: 'worker' }, expect.objectContaining({ middlewareMergeStrategy: 'append' }));
});

test.each(['forbidden', 'missing', 'unreachable', 'no-internal-ip', 'wrong-node', 'invalid-ip', 'unscheduled', 'no-pod'])('node placement %s cannot fail Deployment FM', async scenario => {
  const { pods } = placementFixture();
  if (scenario === 'forbidden') mockReadNode.mockRejectedValue({ code: 403 });
  if (scenario === 'missing') mockReadNode.mockRejectedValue({ code: 404 });
  if (scenario === 'unreachable') mockReadNode.mockRejectedValue(new Error('connection unavailable'));
  if (scenario === 'no-internal-ip') mockReadNode.mockResolvedValue({ metadata: { name: 'worker' }, status: { addresses: [{ type: 'ExternalIP', address: '203.0.113.5' }] } });
  if (scenario === 'wrong-node') mockReadNode.mockResolvedValue({ metadata: { name: 'different' }, status: { addresses: [{ type: 'InternalIP', address: '192.0.2.25' }] } });
  if (scenario === 'invalid-ip') mockReadNode.mockResolvedValue({ metadata: { name: 'worker' }, status: { addresses: [{ type: 'InternalIP', address: 'not-an-ip' }] } });
  if (scenario === 'unscheduled') { pods[3].spec.nodeName = undefined; mockListPods.mockResolvedValue({ items: [pods[3]] }); }
  if (scenario === 'no-pod') mockListPods.mockResolvedValue({ items: [] });
  const status = await runtime().getServiceStatus('amf');
  expect(status).toMatchObject({ active: true, state: 'active', presentation: { domain: '5G Core', platform: 'Kubernetes' } });
  expect(status?.presentation?.hostAddress).toBeUndefined();
  if (scenario === 'unscheduled' || scenario === 'no-pod') expect(mockReadNode).not.toHaveBeenCalled();
});

test('placement is re-resolved when a current Pod is replaced; dual-stack ordering is deterministic', async () => {
  const { pods } = placementFixture();
  const serviceRuntime = runtime();
  expect((await serviceRuntime.getServiceStatus('amf'))?.presentation?.hostAddress).toBe('192.0.2.25');
  pods[3].metadata.uid = 'replacement-uid';
  pods[3].spec.nodeName = 'new-worker';
  mockReadNode.mockResolvedValue({ metadata: { name: 'new-worker' }, status: { addresses: [
    { type: 'InternalIP', address: '2001:db8::5' }, { type: 'InternalIP', address: '192.0.2.26' },
  ] } });
  expect((await serviceRuntime.getServiceStatus('amf'))?.presentation).toMatchObject({ instanceId: 'replacement-uid', hostAddress: '192.0.2.26' });
});
