import { KubernetesLogSource } from '../infrastructure/kubernetes/kubernetes-log-source';
import { LogStreamingUseCase } from '../application/use-cases/log-streaming';
import { LogSourceError } from '../domain/contracts';
import { LogStreamHandler } from '../infrastructure/websocket/log-stream-handler';
import { createLogSource } from '../infrastructure/runtime/log-source-factory';
import { runtimeCapabilities } from '../config/runtime-policy';
import { EventEmitter } from 'events';
import * as k8s from '@kubernetes/client-node';

jest.mock('@kubernetes/client-node', () => ({ KubeConfig: jest.fn(), AppsV1Api: class {}, CoreV1Api: class {} }));
const service = { targetId: 'kubernetes', nf: 'mme' };
function pod(name = 'pod-a', uid = `${name}-uid`, owner = 'rs-uid'): any {
  return { metadata: { name, uid, ownerReferences: [{ kind: 'ReplicaSet', uid: owner, controller: true }] },
    spec: { containers: [{ name: 'nf' }, { name: 'sidecar' }] },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] } };
}
function fixture() {
  const template = { metadata: { labels: { app: 'nf' } }, spec: { containers: [{ name: 'nf', image: 'v2' }] } };
  const deployment: any = { metadata: { name: 'open5gs-mme', uid: 'deployment-uid', generation: 1 },
    spec: { replicas: 2, selector: { matchLabels: { app: 'nf' } }, template } };
  const rs: any = { metadata: { name: 'rs', uid: 'rs-uid',
    ownerReferences: [{ kind: 'Deployment', uid: 'deployment-uid', controller: true }] }, spec: { template } };
  const apps = { readNamespacedDeployment: jest.fn().mockResolvedValue(deployment),
    listNamespacedReplicaSet: jest.fn().mockResolvedValue({ items: [rs] }) };
  const core = { listNamespacedPod: jest.fn().mockResolvedValue({ items: [pod()] }),
    readNamespacedPodLog: jest.fn().mockResolvedValue('2026-09-12T10:00:00.123456789Z NF message\n') };
  const source = new KubernetesLogSource(apps as any, core as any, 'core');
  return { apps, core, source, deployment, rs };
}
beforeEach(() => jest.clearAllMocks());

test('exact Deployment ownership resolves current Pod/container and adds explicit identity', async () => {
  const { source, apps, core } = fixture();
  core.listNamespacedPod.mockResolvedValue({ items: [pod('open5gs-mme-stale', 'stale', 'old-rs'), pod()] });
  expect(await source.readRecent({ services: [service], limit: 20 })).toEqual([{
    service: 'mme', timestamp: '2026-09-12T10:00:00.123Z', message: 'NF message',
    origin: { instance: { service, id: 'pod-a-uid' }, component: 'nf', attributes: {
      namespace: 'core', deployment: 'open5gs-mme', deploymentUid: 'deployment-uid',
      replicaSetUid: 'rs-uid', pod: 'pod-a', podUid: 'pod-a-uid',
    } },
  }]);
  expect(apps.readNamespacedDeployment).toHaveBeenCalledWith({ namespace: 'core', name: 'open5gs-mme' });
  expect(core.readNamespacedPodLog).toHaveBeenCalledWith({ namespace: 'core', name: 'pod-a', container: 'nf',
    tailLines: 20, limitBytes: 1048576, timestamps: true, follow: false, previous: false });
  expect(core.listNamespacedPod).toHaveBeenCalledTimes(2);
});

test('every request resolves replacement rather than caching Pod names', async () => {
  const { source, core } = fixture(); await source.readRecent({ services: [service] });
  core.listNamespacedPod.mockResolvedValue({ items: [pod('replacement')] });
  expect((await source.readRecent({ services: [service] }))[0].origin?.instance.id).toBe('replacement-uid');
  expect(core.readNamespacedPodLog.mock.calls[1][0].name).toBe('replacement');
});

test('replacement during read discards old bytes and retries with new identity', async () => {
  const { source, core } = fixture();
  core.listNamespacedPod.mockResolvedValueOnce({ items: [pod()] }).mockResolvedValue({ items: [pod('replacement')] });
  core.readNamespacedPodLog.mockResolvedValueOnce('2026-09-12T10:00:00Z stale bytes\n');
  const entries = await source.readRecent({ services: [service] });
  expect(entries[0].message).toBe('NF message'); expect(entries[0].origin?.instance.id).toBe('replacement-uid');
  expect(core.readNamespacedPodLog).toHaveBeenCalledTimes(2);
});

test('same-name Pod with a new UID also discards data', async () => {
  const { source, core } = fixture();
  core.listNamespacedPod.mockResolvedValueOnce({ items: [pod()] }).mockResolvedValue({ items: [pod('pod-a', 'new-uid')] });
  expect((await source.readRecent({ services: [service] }))[0].origin?.instance.id).toBe('new-uid');
  expect(core.readNamespacedPodLog).toHaveBeenCalledTimes(2);
});

test('continuous replacement fails after one retry without returning stale logs', async () => {
  const { source, core } = fixture(); let n = 0;
  core.listNamespacedPod.mockImplementation(async () => ({ items: [pod(`pod-${++n}`)] }));
  await expect(source.readRecent({ services: [service] })).rejects.toMatchObject({ code: 'LOG_IDENTITY_CHANGED' });
  expect(core.readNamespacedPodLog).toHaveBeenCalledTimes(2);
});

test('404 from pods/log re-resolves once and reads replacement', async () => {
  const { source, core } = fixture();
  core.readNamespacedPodLog.mockRejectedValueOnce({ code: 404 });
  core.listNamespacedPod.mockResolvedValueOnce({ items: [pod()] }).mockResolvedValue({ items: [pod('replacement')] });
  expect((await source.readRecent({ services: [service] }))[0].origin?.instance.id).toBe('replacement-uid');
  expect(core.readNamespacedPodLog).toHaveBeenCalledTimes(2);
});

test.each(['missing', 'terminating', 'terminal', 'old-template', 'scaled-down'])('%s Pod is never substituted', async scenario => {
  const { source, core, deployment, apps, rs } = fixture(); const current = pod();
  if (scenario === 'missing') core.listNamespacedPod.mockResolvedValue({ items: [] });
  if (scenario === 'terminating') { current.metadata.deletionTimestamp = new Date(); core.listNamespacedPod.mockResolvedValue({ items: [current] }); }
  if (scenario === 'terminal') { current.status.phase = 'Failed'; core.listNamespacedPod.mockResolvedValue({ items: [current] }); }
  if (scenario === 'old-template') {
    const old = JSON.parse(JSON.stringify(rs)); old.spec.template.spec.containers[0].image = 'old';
    apps.listNamespacedReplicaSet.mockResolvedValue({ items: [old] });
  }
  if (scenario === 'scaled-down') deployment.spec.replicas = 0;
  await expect(source.readRecent({ services: [service] })).rejects.toMatchObject({ code: 'LOG_NOT_FOUND' });
  expect(core.readNamespacedPodLog).not.toHaveBeenCalled();
});

test('multiple replicas use Ready/Running then Running then lexical name, independent of API ordering', async () => {
  const { source, core } = fixture(); const unready = pod('aaa'); unready.status.conditions[0].status = 'False';
  const pending = pod('000'); pending.status.phase = 'Pending';
  const pods = [pod('z'), unready, pending, pod('b')];
  core.listNamespacedPod.mockResolvedValue({ items: pods });
  expect((await source.readRecent({ services: [service] }))[0].origin?.attributes.pod).toBe('b');
  core.listNamespacedPod.mockResolvedValue({ items: pods.reverse() });
  expect((await source.readRecent({ services: [service] }))[0].origin?.attributes.pod).toBe('b');
  core.listNamespacedPod.mockResolvedValue({ items: [pending, unready] });
  expect((await source.readRecent({ services: [service] }))[0].origin?.attributes.pod).toBe('aaa');
});

test.each([undefined, 'unknown', 'setup'])('ambiguous or invalid default container %s is refused', async name => {
  const { source, deployment, core } = fixture();
  deployment.spec.template.spec.containers.push({ name: 'sidecar' });
  deployment.spec.template.metadata.annotations = { 'kubectl.kubernetes.io/default-container': name };
  await expect(source.readRecent({ services: [service] })).rejects.toMatchObject({ code: 'LOG_CONTAINER_AMBIGUOUS' });
  expect(core.readNamespacedPodLog).not.toHaveBeenCalled();
});

test('explicit Deployment default container selects only that regular container', async () => {
  const { source, deployment, core } = fixture();
  deployment.spec.template.spec.containers.push({ name: 'sidecar' });
  deployment.spec.template.metadata.annotations = { 'kubectl.kubernetes.io/default-container': 'sidecar' };
  expect((await source.readRecent({ services: [service] }))[0].origin?.component).toBe('sidecar');
  expect(core.readNamespacedPodLog.mock.calls[0][0].container).toBe('sidecar');
});

test.each([[403, 'LOG_ACCESS_DENIED'], [401, 'LOG_ACCESS_DENIED'], [503, 'LOG_READ_FAILED'], [404, 'LOG_NOT_FOUND']])(
  'pods/log status %s is explicit error %s, never successful empty logs', async (code, expected) => {
    const { source, core } = fixture(); core.readNamespacedPodLog.mockRejectedValue({ code });
    await expect(source.readRecent({ services: [service] })).rejects.toMatchObject({ code: expected });
    expect(core.readNamespacedPodLog).toHaveBeenCalledTimes(code === 404 ? 2 : 1);
  });

test('API unreachable and resolver failure are distinct from empty logs', async () => {
  const { source, apps, core } = fixture();
  apps.readNamespacedDeployment.mockRejectedValueOnce(new Error('ECONNREFUSED'));
  await expect(source.readRecent({ services: [service] })).rejects.toMatchObject({ code: 'LOG_READ_FAILED' });
  core.listNamespacedPod.mockRejectedValue(new Error('unreachable'));
  await expect(source.readRecent({ services: [service] })).rejects.toMatchObject({ code: 'LOG_OBSERVATION_FAILED' });
  expect(core.readNamespacedPodLog).not.toHaveBeenCalled();
});

test('missing Deployment is not replaced by a similarly named workload', async () => {
  const { source, apps, core } = fixture(); apps.readNamespacedDeployment.mockRejectedValue({ code: 404 });
  await expect(source.readRecent({ services: [service] })).rejects.toMatchObject({ code: 'LOG_NOT_FOUND' });
  expect(apps.listNamespacedReplicaSet).not.toHaveBeenCalled(); expect(core.readNamespacedPodLog).not.toHaveBeenCalled();
});

test('multi-service reads merge chronologically with a global limit', async () => {
  const { source, core } = fixture();
  core.readNamespacedPodLog.mockResolvedValueOnce('2026-09-12T10:00:03Z third\n2026-09-12T10:00:04Z fourth\n')
    .mockResolvedValueOnce('2026-09-12T10:00:01Z first\n2026-09-12T10:00:02Z second\n');
  expect((await source.readRecent({ services: [service, { ...service, nf: 'amf' }], limit: 3 })).map(e => e.message)).toEqual(['second', 'third', 'fourth']);
});

test('successful empty response remains empty; malformed timestamp is a failed response', async () => {
  const { source, core } = fixture(); core.readNamespacedPodLog.mockResolvedValueOnce('');
  expect(await source.readRecent({ services: [service] })).toEqual([]);
  core.readNamespacedPodLog.mockResolvedValue('no timestamp');
  await expect(source.readRecent({ services: [service] })).rejects.toMatchObject({ code: 'LOG_INVALID_RESPONSE' });
});

test('invalid requests and unsupported operations perform no reads', async () => {
  const { source, apps } = fixture();
  for (const limit of [0, -1, 10001, NaN, 1.5]) await expect(source.readRecent({ services: [service], limit })).rejects.toMatchObject({ code: 'LOG_INVALID_REQUEST' });
  for (const nf of ['open5gs-mme-prefix', 'mongodb', 'toString']) await expect(source.readRecent({ services: [{ ...service, nf }] })).rejects.toMatchObject({ code: 'LOG_UNSUPPORTED' });
  await expect(source.readRecent({ services: [{ ...service, targetId: 'local' }] })).rejects.toMatchObject({ code: 'LOG_TARGET_MISMATCH' });
  await expect(source.readText()).rejects.toMatchObject({ code: 'LOG_UNSUPPORTED' });
  await expect(source.readMajorEventCandidates()).rejects.toMatchObject({ code: 'LOG_UNSUPPORTED' });
  expect(() => source.follow()).toThrow(LogSourceError); expect(apps.readNamespacedDeployment).not.toHaveBeenCalled();
});

test('factory retains local instance, rejects unknown names, and constructs explicit managed adapter', () => {
  const local: any = {}; const loadFromFile = jest.fn(); const makeApiClient = jest.fn().mockReturnValue({});
  (k8s.KubeConfig as jest.Mock).mockImplementation(() => ({ loadFromFile, makeApiClient }));
  expect(createLogSource('local', local, 'config', 'core')).toBe(local);
  expect(k8s.KubeConfig).not.toHaveBeenCalled();
  expect(() => createLogSource('typo', local, 'config', 'core')).toThrow('Unknown log provider');
  expect(createLogSource('kubernetes', local, 'config', 'core')).toBeInstanceOf(KubernetesLogSource);
  expect(loadFromFile).toHaveBeenCalledWith('config');
});

test('WebSocket permits only recent snapshots, returns semantic errors, and keeps follow/Major Events guarded', async () => {
  const { source, core } = fixture(); const logs = new LogStreamingUseCase(source);
  const ws: any = new EventEmitter(); ws.send = jest.fn();
  const logger: any = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };
  const policy = runtimeCapabilities('kubernetes');
  new LogStreamHandler(logs, {} as any, logger, policy.coreLogs, undefined, policy.coreRecentLogs).handleConnection(ws);
  const send = (data: any) => ws.emit('message', JSON.stringify(data));
  send({ type: 'get_recent_logs', services: ['mme'] });
  await new Promise(resolve => setImmediate(resolve));
  expect(JSON.parse(ws.send.mock.calls[0][0])).toMatchObject({ type: 'recent_logs', source: 'open5gs', logs: [{ origin: { component: 'nf' } }] });
  const calls = core.readNamespacedPodLog.mock.calls.length;
  send({ type: 'subscribe_logs', services: ['mme'] }); send({ type: 'get_recent_logs', services: ['mme'], majorEventsOnly: true });
  expect(ws.send.mock.calls.slice(1).map(([text]: [string]) => JSON.parse(text).code)).toEqual(['RUNTIME_UNSUPPORTED', 'RUNTIME_UNSUPPORTED']);
  expect(core.readNamespacedPodLog).toHaveBeenCalledTimes(calls);
  send({ type: 'subscribe_logs', source: 'unknown-alias', services: ['mme'] });
  expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({ code: 'RUNTIME_UNSUPPORTED' });
  core.readNamespacedPodLog.mockRejectedValue({ code: 403 }); send({ type: 'get_recent_logs', services: ['mme'] });
  await new Promise(resolve => setImmediate(resolve));
  expect(JSON.parse(ws.send.mock.calls.at(-1)[0])).toMatchObject({ type: 'error', code: 'LOG_ACCESS_DENIED' });
});
