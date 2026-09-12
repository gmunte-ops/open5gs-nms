import { EventEmitter } from 'events';
import * as net from 'net';
import { ServiceMonitorUseCase } from '../application/use-cases/service-monitor';
import { LocalServiceAdapter } from '../infrastructure/system/local-service-adapter';

jest.mock('net', () => ({ Socket: jest.fn() }));
const order = ['mongodb', 'hss', 'pcrf', 'nrf', 'scp', 'ausf', 'udm', 'udr', 'pcf', 'nssf', 'bsf', 'sepp1', 'upf', 'sgwu', 'smf', 'sgwc', 'amf', 'mme'];
const showArgs = ['show', 'open5gs-mmed', '--no-pager', '--property=ActiveState,SubState,MainPID,NRestarts,ExecMainStartTimestamp,MemoryCurrent,CPUUsageNSec'];
const dockerCommand = `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Image}}' 2>/dev/null | grep -i mongo || true`;

function fixture() {
  const calls: string[] = [];
  const host: any = {
    isServiceActive: jest.fn(async () => { calls.push('active'); return true; }),
    isServiceEnabled: jest.fn(async () => { calls.push('enabled'); return true; }),
    executeCommand: jest.fn(async () => { calls.push('show'); return { stdout: 'ActiveState=active\nSubState=running\nMainPID=42\nNRestarts=3\nExecMainStartTimestamp=stamp=a\nMemoryCurrent=2048\nCPUUsageNSec=2500000000', stderr: '', exitCode: 1 }; }),
    executeLocalCommand: jest.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
  };
  for (const action of ['start', 'stop', 'restart', 'enable', 'disable']) {
    host[`${action}Service`] = jest.fn(async (unit: string) => {
      calls.push(`${action}:${unit}`);
      return { stdout: '', stderr: '', exitCode: 0 };
    });
  }
  const logger: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const audit = { log: jest.fn(async (_entry: any) => { calls.push('audit'); }) };
  const broadcaster = { broadcastServiceStatus: jest.fn() };
  const monitor = new ServiceMonitorUseCase(new LocalServiceAdapter(host, logger), broadcaster as any, audit as any, logger);
  const socket: any = new EventEmitter();
  socket.destroy = jest.fn();
  socket.setTimeout = jest.fn();
  socket.connect = jest.fn(() => { socket.emit('connect'); socket.emit('timeout'); });
  (net.Socket as unknown as jest.Mock).mockImplementation(() => socket);
  return { host, monitor, audit, logger, calls, socket, broadcaster };
}

beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-01-01T00:00:00Z')); });
afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

test('systemd status preserves command order, parser and legacy CPU units even on nonzero show exit', async () => {
  const { monitor, host, calls } = fixture();
  const status = await monitor.getOne('mme');
  expect(calls).toEqual(['active', 'enabled', 'show']);
  expect(host.isServiceActive).toHaveBeenCalledWith('open5gs-mmed');
  expect(host.isServiceEnabled).toHaveBeenCalledWith('open5gs-mmed');
  expect(host.executeCommand).toHaveBeenCalledWith('systemctl', showArgs);
  expect(status).toEqual({ name: 'mme', unitName: 'open5gs-mmed', active: true, enabled: true, state: 'active', subState: 'running', pid: 42, uptime: 'stamp=a', restartCount: 3, cpuPercent: 2.5, memoryBytes: 2048, memoryPercent: null, lastChecked: '2026-01-01T00:00:00.000Z', source: 'systemd' });
  expect(monitor.getStatusCache().mme).toEqual(status);
  const cache = monitor.getStatusCache(); delete cache.mme;
  expect(monitor.getStatusCache().mme).toEqual(status);
});

test('missing and malformed properties retain legacy null, zero, NaN and duplicate-key semantics', async () => {
  const { host, monitor } = fixture();
  host.executeCommand.mockResolvedValue({ stdout: 'ignored\n=ignored\nActiveState=first\n ActiveState = failed \nMainPID=0\nNRestarts=bad\nMemoryCurrent=[not set]\nCPUUsageNSec=bad' });
  expect(await monitor.getOne('mme')).toMatchObject({ state: 'failed', subState: 'unknown', pid: null, restartCount: NaN, cpuPercent: NaN, memoryBytes: null, uptime: null });
  host.executeCommand.mockResolvedValue({ stdout: '' });
  expect(await monitor.getOne('mme')).toMatchObject({ restartCount: 0, cpuPercent: null, memoryBytes: null });
});

test.each(['isServiceActive', 'isServiceEnabled', 'executeCommand'])('status failure in %s retains fallback without source or error', async method => {
  const { host, monitor } = fixture();
  host[method].mockRejectedValue(new Error('failure'));
  const status = await monitor.getOne('mme');
  expect(status).toEqual({ name: 'mme', unitName: 'open5gs-mmed', active: false, enabled: false, state: 'unknown', subState: 'unknown', pid: null, uptime: null, restartCount: 0, cpuPercent: null, memoryBytes: null, memoryPercent: null, lastChecked: '2026-01-01T00:00:00.000Z' });
  expect(monitor.getStatusCache().mme).toEqual(status);
});

test.each(['start', 'stop', 'restart', 'enable', 'disable'] as const)('%s preserves unit dispatch, then audit and response text', async action => {
  const { host, monitor, audit, calls } = fixture();
  expect(await monitor.executeAction({ service: 'mme', action })).toEqual({ success: true, message: `Service mme ${action} successful` });
  expect(host[`${action}Service`]).toHaveBeenCalledWith('open5gs-mmed');
  expect(calls).toEqual([`${action}:open5gs-mmed`, 'audit']);
  expect(audit.log).toHaveBeenCalledWith({ action: `service_${action}`, user: 'admin', target: 'mme', details: `${action} successful`, success: true });
});

test.each(['denied\n', ''])('command failure preserves stderr verbatim (%j) and audits failure', async stderr => {
  const { monitor, host, audit } = fixture();
  host.restartService.mockResolvedValue({ exitCode: 1, stderr });
  expect(await monitor.executeAction({ service: 'mme', action: 'restart' })).toEqual({ success: false, message: stderr });
  expect(audit.log).toHaveBeenCalledWith({ action: 'service_restart', user: 'admin', target: 'mme', details: stderr, success: false });
});

test('thrown command is not audited; thrown audit becomes action failure without retry', async () => {
  const { monitor, host, audit } = fixture();
  host.restartService.mockRejectedValueOnce('transport');
  expect(await monitor.executeAction({ service: 'mme', action: 'restart' })).toEqual({ success: false, message: 'transport' });
  expect(audit.log).not.toHaveBeenCalled();
  audit.log.mockRejectedValueOnce(new Error('audit failed'));
  expect(await monitor.executeAction({ service: 'mme', action: 'restart' })).toEqual({ success: false, message: 'audit failed' });
  expect(host.restartService).toHaveBeenCalledTimes(2);
  expect(audit.log).toHaveBeenCalledTimes(1);
});

test.each(['start', 'stop', 'restart'] as const)('bulk %s preserves order, empty-filter meaning and 500ms delay after final service', async action => {
  const { monitor, audit } = fixture();
  const expected = action === 'stop' ? [...order].reverse() : order;
  let done = false;
  const pending = monitor.executeAllAction(action, []).then(result => { done = true; return result; });
  await jest.advanceTimersByTimeAsync(500 * expected.length - 1);
  expect(done).toBe(false);
  expect(audit.log.mock.calls.map(([entry]) => entry.target)).toEqual(expected);
  await jest.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ success: true, message: `All services ${action} successful`, results: expected.map(service => ({ service, success: true })) });
});

test('bulk filtering follows dependency order, continues after failure, and never rolls back', async () => {
  const { monitor, host, audit } = fixture();
  host.startService.mockResolvedValueOnce({ exitCode: 1, stderr: 'failed' });
  const pending = monitor.executeAllAction('start', ['mme', 'nrf', 'invalid']);
  await jest.advanceTimersByTimeAsync(1000);
  expect(await pending).toEqual({ success: false, message: 'Some services failed to start', results: [{ service: 'nrf', success: false }, { service: 'mme', success: true }] });
  expect(audit.log.mock.calls.map(([entry]) => entry.target)).toEqual(['nrf', 'mme']);
  expect(host.stopService).not.toHaveBeenCalled();
  expect(await monitor.executeAllAction('stop', ['invalid'])).toEqual({ success: true, message: 'All services stop successful', results: [] });
});

test('active systemd MongoDB repeats active check and avoids Docker/TCP', async () => {
  const { monitor, host, socket } = fixture();
  expect(await monitor.getOne('mongodb')).toMatchObject({ source: 'systemd', unitName: 'mongod' });
  expect(host.isServiceActive.mock.calls).toEqual([['mongod'], ['mongod']]);
  expect(host.executeLocalCommand).not.toHaveBeenCalled();
  expect(socket.connect).not.toHaveBeenCalled();
});

test.each(['connect', 'error', 'timeout'])('inactive MongoDB uses TCP %s as authority regardless of Docker state/exit', async event => {
  const { monitor, host, socket } = fixture();
  host.isServiceActive.mockResolvedValue(false);
  host.executeLocalCommand.mockResolvedValue({ stdout: 'first\tExited\timage\nsecond\tUp\timage', exitCode: 1 });
  socket.connect.mockImplementation(() => { socket.emit(event); socket.emit('timeout'); });
  expect(await monitor.getOne('mongodb')).toMatchObject({ active: event === 'connect', enabled: event === 'connect', source: 'docker', state: event === 'connect' ? 'active' : 'inactive', subState: event === 'connect' ? 'running' : 'dead', restartCount: 0 });
  expect(host.executeLocalCommand).toHaveBeenCalledWith('bash', ['-c', dockerCommand]);
  expect(socket.setTimeout).toHaveBeenCalledWith(2000);
  expect(socket.connect).toHaveBeenCalledWith(27017, '127.0.0.1');
  expect(socket.destroy).toHaveBeenCalledTimes(1);
  expect(host.isServiceEnabled).not.toHaveBeenCalled();
});

test('failed active probe falls back once; failed Docker probe retries then falls through to systemd', async () => {
  const { monitor, host, logger } = fixture();
  host.isServiceActive.mockRejectedValueOnce(new Error('missing unit'));
  expect(await monitor.getOne('mongodb')).toMatchObject({ active: true, source: 'direct' });
  expect(host.executeLocalCommand).toHaveBeenCalledTimes(1);
  host.isServiceActive.mockResolvedValue(false);
  host.executeLocalCommand.mockRejectedValue(new Error('no bash'));
  expect(await monitor.getOne('mongodb')).toMatchObject({ active: false, source: 'systemd' });
  expect(host.executeLocalCommand).toHaveBeenCalledTimes(3);
  expect(logger.warn).toHaveBeenCalledWith({ dockerErr: 'Error: no bash' }, 'MongoDB Docker fallback failed');
});

test('topology probes fresh Mongo directly, leaves cache alone and throttles probe logs to 30 seconds', async () => {
  const { monitor, host, logger } = fixture();
  expect(await monitor.getMongoStatus()).toEqual({ active: true, source: 'direct' });
  await monitor.getMongoStatus();
  expect(host.isServiceActive).not.toHaveBeenCalled();
  expect(monitor.getStatusCache()).toEqual({});
  expect(logger.info).toHaveBeenCalledTimes(2);
  jest.setSystemTime(new Date('2026-01-01T00:00:30Z'));
  await monitor.getMongoStatus();
  expect(logger.info).toHaveBeenCalledTimes(4);
  host.executeLocalCommand.mockRejectedValueOnce(new Error('no bash'));
  await expect(monitor.getMongoStatus()).rejects.toThrow('no bash');
});

test('polling starts once, broadcasts status and stops', async () => {
  const { monitor, broadcaster } = fixture();
  const getAll = jest.spyOn(monitor, 'getAll').mockResolvedValue([]);
  monitor.startPolling(); monitor.startPolling();
  await jest.advanceTimersByTimeAsync(3000);
  expect(getAll).toHaveBeenCalledTimes(1);
  expect(broadcaster.broadcastServiceStatus).toHaveBeenCalledWith([]);
  monitor.stopPolling();
  await jest.advanceTimersByTimeAsync(3000);
  expect(getAll).toHaveBeenCalledTimes(1);
});
