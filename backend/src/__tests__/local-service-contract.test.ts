import pino from 'pino';
import { LocalServiceAdapter } from '../infrastructure/system/local-service-adapter';
import { ServiceMonitorUseCase } from '../application/use-cases/service-monitor';
import { legacyObservationValue, toLifecycleAction } from '../application/compatibility/legacy-service-observation';
import { IServiceStatusReader, ILifecycleOperations } from '../domain/contracts';
import { ServiceStatus } from '../domain/entities/service-status';

const logger = pino({ level: 'silent' });
const ref = { targetId: 'test-host', nf: 'mme' };

test('local contract exposes ordered logical identities without doing I/O', () => {
  const adapter = new LocalServiceAdapter({} as any, logger, ref.targetId);
  expect(adapter.listServices()).toEqual(['mongodb', 'nrf', 'scp', 'amf', 'smf', 'upf', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'sepp1', 'mme', 'hss', 'pcrf', 'sgwc', 'sgwu', 'osmo-stp', 'osmo-hlr', 'osmo-msc'].map(nf => ({ targetId: ref.targetId, nf })));
  expect(adapter.getBulkOrder('stop')).toEqual([...adapter.getBulkOrder('start')].reverse());
  expect(adapter.getBulkOrder('restart')).toEqual(adapter.getBulkOrder('start'));
});

test.each([{ ...ref, targetId: 'other' }, { ...ref, nf: 'constructor' }, { ...ref, nf: 'unknown' }])('rejects invalid identity before host I/O: %j', async invalid => {
  const adapter = new LocalServiceAdapter({} as any, logger, ref.targetId);
  await expect(adapter.getStatus(invalid)).rejects.toThrow();
  await expect(adapter.execute(invalid, 'restart')).rejects.toThrow();
  await expect(adapter.getReachability(invalid)).rejects.toThrow();
});

test('fallback is a partial observation with the original legacy data, not an empty observation', async () => {
  const adapter = new LocalServiceAdapter({ isServiceActive: async () => { throw new Error('offline'); }, isServiceEnabled: async () => false } as any, logger, ref.targetId);
  const result = await adapter.getStatus(ref);
  expect(result.status).toBe('partial');
  expect(result.sources).toEqual([{ provider: 'local', scope: { kind: 'service', service: ref } }]);
  const data = legacyObservationValue(result);
  expect(data).toMatchObject({ name: 'mme', state: 'unknown', active: false });
  expect(data).not.toHaveProperty('source');
  expect(data.lastChecked).toBe(result.observedAt);
  expect(await adapter.getReachability(ref)).toMatchObject({ status: 'unsupported' });
});

test.each(['unavailable', 'unsupported', 'not-found'] as const)('compatibility does not fabricate data for %s', status => {
  expect(() => legacyObservationValue({ status, reason: 'missing', observedAt: '', sources: [] })).toThrow('missing');
});

test('enable/disable bridge uses semantic boot actions', () => {
  expect(toLifecycleAction('enable')).toBe('enableAtBoot');
  expect(toLifecycleAction('disable')).toBe('disableAtBoot');
  expect(toLifecycleAction('restart')).toBe('restart');
});

test('application consumes semantic provider without host executor or local unit lookups', async () => {
  const data: ServiceStatus = { name: 'mme', unitName: 'opaque-identity', active: true, enabled: false, state: 'active', subState: 'running', pid: null, uptime: null, restartCount: null, cpuPercent: null, memoryBytes: null, memoryPercent: null, lastChecked: 'now' };
  const execute = jest.fn(async () => ({ success: true, error: '' }));
  const provider: IServiceStatusReader<ServiceStatus> & ILifecycleOperations = {
    targetId: ref.targetId,
    listServices: () => [ref],
    usesAuthoritativeStatus: () => false,
    getActionPolicy: () => ({ allowed: true }),
    getStatus: async () => ({ status: 'ok', observedAt: 'now', sources: [], data }),
    getReachability: async () => ({ status: 'ok', observedAt: 'now', sources: [], data: { active: true, source: 'test' } }),
    getBulkOrder: () => [ref], execute,
  };
  const monitor = new ServiceMonitorUseCase(provider, {} as any, { log: jest.fn() } as any, logger);
  expect(await monitor.getAll()).toEqual([data]);
  expect(await monitor.getMongoStatus()).toEqual({ active: true, source: 'test' });
  expect((await monitor.executeAction({ service: 'mme', action: 'enable' })).success).toBe(true);
  expect(execute).toHaveBeenCalledWith(ref, 'enableAtBoot');
});
