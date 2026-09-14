import pino from 'pino';
import { LocalServiceAdapter } from '../infrastructure/system/local-service-adapter';
import { KubernetesServiceAdapter } from '../infrastructure/kubernetes/kubernetes-service-adapter';
import { KubernetesServiceRuntime } from '../infrastructure/kubernetes/kubernetes-service-runtime';
import { ServiceProvider, ServiceProviderRegistry } from '../infrastructure/runtime/service-provider-registry';
import { ServiceMonitorUseCase } from '../application/use-cases/service-monitor';
import { legacyObservationValue } from '../application/compatibility/legacy-service-observation';
import { parseOpen5gsRuntime } from '../config/runtime-policy';

const mockReadDeployment = jest.fn();
const mockListReplicaSets = jest.fn();
const mockListPods = jest.fn();
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: jest.fn().mockImplementation(() => ({
    loadFromFile: jest.fn(),
    makeApiClient: () => ({ readNamespacedDeployment: mockReadDeployment,
      listNamespacedReplicaSet: mockListReplicaSets, listNamespacedPod: mockListPods }),
  })),
  AppsV1Api: jest.fn(), CoreV1Api: jest.fn(),
}));

const logger = pino({ level: 'silent' });
const ref = { targetId: 'local', nf: 'mme' };
function fixture(kind: 'local' | 'kubernetes') {
  const host = {
    isServiceActive: jest.fn().mockResolvedValue(true),
    isServiceEnabled: jest.fn().mockResolvedValue(true),
    executeCommand: jest.fn().mockResolvedValue({ stdout: 'ActiveState=active\nSubState=running', stderr: '', exitCode: 0 }),
    executeLocalCommand: jest.fn(),
    restartService: jest.fn().mockResolvedValue({ exitCode: 0, stderr: '' }),
  };
  const local = new LocalServiceAdapter(host as any, logger);
  const runtime = new KubernetesServiceRuntime('/unused', 'core', logger);
  const provider: ServiceProvider = kind === 'local' ? local : new KubernetesServiceAdapter(runtime, local);
  const audit = { log: jest.fn(), getAll: jest.fn(), getByAction: jest.fn(), count: jest.fn() };
  const monitor = new ServiceMonitorUseCase(provider, {} as any, audit, logger);
  return { host, local, runtime, provider, monitor, audit };
}

beforeEach(() => {
  jest.useFakeTimers(); jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  mockReadDeployment.mockReset().mockResolvedValue({ spec: { replicas: 1 }, status: { readyReplicas: 1, availableReplicas: 1 } });
  mockListReplicaSets.mockReset(); mockListPods.mockReset();
});
afterEach(() => jest.useRealTimers());

describe.each(['local', 'kubernetes'] as const)('%s semantic provider contract', kind => {
  test('inventory, identity, order, observations and reachability use the same interfaces', async () => {
    const { provider } = fixture(kind);
    expect(provider.listServices()).toContainEqual(ref);
    expect(provider.listServices().every(service => service.targetId === provider.targetId)).toBe(true);
    expect(provider.getBulkOrder('stop')).toEqual([...provider.getBulkOrder('start')].reverse());
    const observation = await provider.getStatus(ref);
    expect(observation.status).toBe('ok');
    expect(observation.sources[0].scope).toEqual({ kind: 'service', service: ref });
    expect(legacyObservationValue(observation)).toMatchObject({ name: 'mme', active: true, lastChecked: observation.observedAt });
    expect(await provider.getReachability(ref)).toMatchObject({ status: kind === 'local' ? 'unsupported' : 'ok' });
  });

  test.each([{ ...ref, targetId: 'other' }, { ...ref, nf: 'constructor' }, { ...ref, nf: 'unknown' }])('rejects invalid references without I/O: %j', async invalid => {
    const { provider, host } = fixture(kind);
    await expect(provider.getStatus(invalid)).rejects.toThrow();
    await expect(provider.getReachability(invalid)).rejects.toThrow();
    await expect(provider.execute(invalid, 'restart')).rejects.toThrow();
    expect(() => provider.getActionPolicy(invalid, 'restart')).toThrow();
    expect(host.isServiceActive).not.toHaveBeenCalled();
    expect(mockReadDeployment).not.toHaveBeenCalled();
  });

  test('lifecycle policy agrees with execution and retains host-service compatibility', async () => {
    const { provider, host } = fixture(kind);
    expect(provider.getActionPolicy(ref, 'restart').allowed).toBe(kind === 'local');
    expect((await provider.execute(ref, 'restart')).success).toBe(kind === 'local');
    expect(host.restartService).toHaveBeenCalledTimes(kind === 'local' ? 1 : 0);
    const unrelated = { ...ref, nf: 'osmo-msc' };
    expect(provider.usesAuthoritativeStatus(unrelated)).toBe(false);
    expect((await provider.execute(unrelated, 'restart')).success).toBe(true);
    expect(host.restartService).toHaveBeenLastCalledWith('osmo-msc');
  });
});

test.each([[1, 1, 1, 'active'], [2, 1, 1, 'degraded'], [0, 0, 0, 'inactive']])('wrapper preserves complete runtime mapping for Deployment %s/%s/%s', async (desired, ready, available, state) => {
  mockReadDeployment.mockResolvedValue({ spec: { replicas: desired }, status: { readyReplicas: ready, availableReplicas: available } });
  const { provider, runtime, host } = fixture('kubernetes');
  const original = await runtime.getServiceStatus('mme');
  expect(legacyObservationValue(await provider.getStatus(ref))).toEqual({ ...original, actionsSupported: false });
  expect(original?.state).toBe(state);
  expect(host.isServiceActive).not.toHaveBeenCalled();
});

test('absent Deployment remains owned, absent and read-only with no local fallback', async () => {
  mockReadDeployment.mockRejectedValue({ code: 404 });
  const { monitor, provider, host } = fixture('kubernetes');
  expect(await monitor.getOne('mme')).toMatchObject({ state: 'not-deployed', subState: 'absent', unitName: 'open5gs-mme', source: 'kubernetes', actionsSupported: false });
  expect(provider.usesAuthoritativeStatus(ref)).toBe(true);
  expect(provider.getActionPolicy(ref, 'start').allowed).toBe(false);
  expect(host.isServiceActive).not.toHaveBeenCalled();
});

test.each([new Error('Forbidden'), { code: 403 }, { code: 500 }])('API failure retains exact legacy unavailable response and never probes host: %j', async error => {
  mockReadDeployment.mockRejectedValue(error);
  const { monitor, host } = fixture('kubernetes');
  const { presentation, ...legacyStatus } = await monitor.getOne('mme');
  expect(presentation).toEqual({ domain: '5G Core', platform: 'Kubernetes' });
  expect(legacyStatus).toEqual({ name: 'mme', unitName: 'mme', active: false, enabled: false, state: 'unknown', subState: 'unavailable', pid: null, uptime: null, restartCount: null, cpuPercent: null, memoryBytes: null, memoryPercent: null, lastChecked: '2026-01-01T00:00:00.000Z', source: 'kubernetes', actionsSupported: false, error: error instanceof Error ? error.message : String(error) });
  expect(host.executeCommand).not.toHaveBeenCalled();
  expect(host.executeLocalCommand).not.toHaveBeenCalled();
});

test('failure retains previous Deployment identity; topology refreshes status cache without local TCP', async () => {
  const { monitor, host } = fixture('kubernetes');
  await monitor.getOne('mme');
  mockReadDeployment.mockRejectedValueOnce(new Error('offline'));
  expect(await monitor.getOne('mme')).toMatchObject({ unitName: 'open5gs-mme', state: 'unknown' });
  expect(await monitor.getMongoStatus()).toEqual({ active: true, source: 'kubernetes' });
  expect(monitor.getStatusCache().mongodb).toMatchObject({ source: 'kubernetes', active: true });
  expect(host.executeLocalCommand).not.toHaveBeenCalled();
});

test.each(['start', 'stop', 'restart', 'enable', 'disable'] as const)('blocked %s preserves warning, audit and response, including audit rejection propagation', async action => {
  const { provider, audit, host } = fixture('kubernetes');
  const logs = { warn: jest.fn(), info: jest.fn() };
  const monitor = new ServiceMonitorUseCase(provider, {} as any, audit, logs as any);
  const message = `Action '${action}' is disabled for Kubernetes-managed service 'mme' (read-only mode)`;
  expect(await monitor.executeAction({ service: 'mme', action })).toEqual({ success: false, message });
  expect(logs.warn).toHaveBeenCalledWith({ service: 'mme', action }, 'Blocked Kubernetes service action in read-only mode');
  expect(logs.info).not.toHaveBeenCalled();
  expect(audit.log).toHaveBeenCalledWith({ action: `service_${action}`, user: 'admin', target: 'mme', details: message, success: false });
  expect(host.restartService).not.toHaveBeenCalled();
  expect(mockReadDeployment).not.toHaveBeenCalled();
  const semanticAction = action === 'enable' ? 'enableAtBoot' : action === 'disable' ? 'disableAtBoot' : action;
  expect(await provider.execute(ref, semanticAction)).toEqual({ success: false, error: message });
  audit.log.mockRejectedValueOnce(new Error('audit failed'));
  await expect(monitor.executeAction({ service: 'mme', action })).rejects.toThrow('audit failed');
});

test('provider selection is explicit and lazy, retains default, and never falls back on errors', () => {
  const { provider } = fixture('local');
  const local = jest.fn(() => provider);
  const cluster = jest.fn(() => { throw new Error('kubeconfig failure'); });
  const registry = new ServiceProviderRegistry().register('local', local).register('kubernetes', cluster);
  expect(registry.create(parseOpen5gsRuntime(undefined))).toBe(provider);
  expect(cluster).not.toHaveBeenCalled();
  expect(() => registry.create('kubernetes')).toThrow('kubeconfig failure');
  expect(local).toHaveBeenCalledTimes(1);
  for (const unknown of ['', 'docker', 'constructor', 'LOCAL', 'typo']) {
    expect(() => registry.create(unknown)).toThrow('Unknown service provider');
    expect(() => parseOpen5gsRuntime(unknown)).toThrow('Invalid OPEN5GS_RUNTIME');
  }
  expect(() => registry.register('local', local)).toThrow();
  expect(() => registry.register('', local)).toThrow();
  expect(local).toHaveBeenCalledTimes(1);
});
