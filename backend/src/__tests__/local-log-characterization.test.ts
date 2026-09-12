import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { WebSocket } from 'ws';
import { LogStreamingUseCase } from '../application/use-cases/log-streaming';
import { LocalLogSource } from '../infrastructure/system/local-log-source';
import { LogStreamHandler } from '../infrastructure/websocket/log-stream-handler';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('fs/promises', () => ({ readFile: jest.fn() }));
function child() {
  const process: any = new EventEmitter();
  process.stdout = new PassThrough(); process.stderr = new PassThrough(); process.stdin = new PassThrough();
  process.kill = jest.fn(); return process;
}
function fixture() {
  const host = { executeCommand: jest.fn().mockResolvedValue({ exitCode: 0, stdout: '' }) };
  const logger: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const legacy = new LocalLogSource(host as any, logger); const logs = new LogStreamingUseCase(legacy);
  const handler = new LogStreamHandler(logs, {} as any, logger, true, legacy);
  const ws: any = new EventEmitter(); ws.readyState = WebSocket.OPEN; ws.send = jest.fn();
  handler.handleConnection(ws);
  const send = (message: any) => ws.emit('message', JSON.stringify(message));
  return { host, logger, logs, legacy, handler, ws, send };
}
beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(new Date('2026-07-01T12:00:00Z')); jest.clearAllMocks(); });
afterEach(() => jest.useRealTimers());

test('recent reads run sequential tails, merge by host-local timestamp, and apply global limit', async () => {
  const { logs, legacy, host } = fixture();
  host.executeCommand.mockResolvedValueOnce({ exitCode: 0, stdout: '07/01 10:00:02.000: second\n07/01 10:00:04.000: fourth\n' })
    .mockResolvedValueOnce({ exitCode: 0, stdout: '07/01 10:00:01.000: first\n07/01 10:00:03.000: third\n' });
  const result = await logs.getRecentLogs(['mme', 'amf'], 3);
  expect(host.executeCommand.mock.calls).toEqual([['tail', ['-n', '3', '/var/log/open5gs/mme.log']], ['tail', ['-n', '3', '/var/log/open5gs/amf.log']]]);
  expect(result.map(item => item.message)).toEqual(['second', 'third', 'fourth']);
  expect(result[0].timestamp).toBe(new Date('2026-07-01T10:00:02.000').toISOString());
});

test('recent nonzero exits are empty, thrown per-service failures warn and continue, limit zero keeps all', async () => {
  const { logs, host, logger } = fixture();
  host.executeCommand.mockResolvedValueOnce({ exitCode: 1, stdout: 'ignored' }).mockRejectedValueOnce(new Error('missing'))
    .mockResolvedValueOnce({ exitCode: 0, stdout: '\nraw line\n99/99 00:00:00.000: invalid date\n' });
  expect((await logs.getRecentLogs(['mme', 'amf', 'smf'], 0)).map(entry => entry.message)).toEqual(['raw line', '99/99 00:00:00.000: invalid date']);
  expect(logger.warn).toHaveBeenCalledWith({ service: 'amf', err: 'Error: missing' }, 'Failed to fetch logs for service');
});

test('journal and mounted-file compatibility reads preserve parsing and failure behavior', async () => {
  const { logs, legacy, host } = fixture();
  host.executeCommand.mockResolvedValue({ exitCode: 0, stdout: '2026-07-01T10:00:00+02:00 host daemon[2]: hello\nraw\n' });
  expect(await legacy.getRecentJournalLogs('kamailio', 2)).toEqual([
    { service: 'kamailio', timestamp: '2026-07-01T08:00:00.000Z', message: 'hello' },
    { service: 'kamailio', timestamp: new Date().toISOString(), message: 'raw' },
  ]);
  expect(host.executeCommand).toHaveBeenCalledWith('journalctl', ['-u', 'kamailio', '-n', '2', '--no-pager', '-o', 'short-iso']);
  (readFile as jest.Mock).mockResolvedValue('one\n\ntwo\nthree\n');
  expect((await legacy.getRecentLogsFromPath('/mounted/log', 'access', 2)).map(entry => entry.message)).toEqual(['two', 'three']);
  (readFile as jest.Mock).mockRejectedValue(new Error('missing'));
  expect(await legacy.getRecentLogsFromPath('/mounted/log', 'access')).toEqual([]);
});

test('major-event bounded pipeline preserves commands, EPIPE tolerance, partial timeout output and kills', async () => {
  const { legacy } = fixture(); const tail = child(); const grep = child();
  (spawn as jest.Mock).mockReturnValueOnce(tail).mockReturnValueOnce(grep);
  const pending = legacy.getGreppedLogs({ mme: 'Attach complete' }, 1);
  grep.stdin.emit('error', new Error('EPIPE'));
  grep.stdout.emit('data', Buffer.from('old\nnew\n'));
  await jest.advanceTimersByTimeAsync(20_000);
  expect((await pending).map(entry => entry.message)).toEqual(['new']);
  expect(spawn).toHaveBeenNthCalledWith(1, 'nsenter', ['-t', '1', '-m', '-u', '-i', '-p', 'tail', '-c', String(300 * 1024 * 1024), '/var/log/open5gs/mme.log']);
  expect(spawn).toHaveBeenNthCalledWith(2, 'nsenter', ['-t', '1', '-m', '-u', '-i', '-p', 'grep', '-a', '-E', 'Attach complete']);
  expect(tail.kill).toHaveBeenCalledTimes(1); expect(grep.kill).toHaveBeenCalledTimes(1);
});

test('follow preserves tail command, chunk fragments, timestamps and websocket envelope', () => {
  const { send, ws } = fixture(); const process = child(); (spawn as jest.Mock).mockReturnValue(process);
  send({ type: 'subscribe_logs', services: ['mme'] });
  expect(spawn).toHaveBeenCalledWith('tail', ['-f', '-n', '0', '/var/log/open5gs/mme.log']);
  process.stdout.emit('data', Buffer.from('07/01 10:00:00.000: hello\nfragment'));
  process.stdout.emit('data', Buffer.from('rest\n\n'));
  const messages = ws.send.mock.calls.map(([data]: [string]) => JSON.parse(data));
  expect(messages.map((entry: any) => entry.log.message)).toEqual(['hello', 'fragment', 'rest']);
  expect(messages[0]).toEqual({ type: 'log_entry', source: 'open5gs', log: { service: 'mme', timestamp: new Date('2026-07-01T10:00:00.000').toISOString(), message: 'hello' } });
  ws.readyState = WebSocket.CLOSED; process.stdout.emit('data', Buffer.from('hidden\n'));
  expect(ws.send).toHaveBeenCalledTimes(3);
});

test.each(['unsubscribe_logs', 'disconnect', 'socket-error', 'cleanup'])('%s cancels active streams once', event => {
  const { send, ws, handler } = fixture(); const process = child(); (spawn as jest.Mock).mockReturnValue(process);
  send({ type: 'subscribe_logs', services: ['mme'] });
  if (event === 'unsubscribe_logs') send({ type: event });
  if (event === 'disconnect') ws.emit('close');
  if (event === 'socket-error') ws.emit('error', new Error('disconnected'));
  if (event === 'cleanup') handler.cleanup();
  handler.cleanup();
  expect(process.kill).toHaveBeenCalledTimes(1);
});

test('replacement cancels old subscription, process errors remove streams and retain logging', () => {
  const { send, logger, handler } = fixture(); const first = child(); const second = child();
  (spawn as jest.Mock).mockReturnValueOnce(first).mockReturnValueOnce(second);
  send({ type: 'subscribe_logs', services: ['mme'] }); send({ type: 'subscribe_logs', services: ['amf'] });
  expect(first.kill).toHaveBeenCalledTimes(1);
  second.stderr.emit('data', Buffer.from('warning'));
  second.emit('error', new Error('tail failed'));
  expect(logger.warn).toHaveBeenCalledWith({ service: 'amf', stderr: 'warning' }, 'tail stderr');
  expect(logger.error).toHaveBeenCalledWith({ service: 'amf', err: 'Error: tail failed' }, 'tail process error');
  handler.cleanup(); expect(second.kill).not.toHaveBeenCalled();
});

test('nonzero stream close is logged and removed; synchronous spawn errors reach message handler', () => {
  const { send, logger, handler } = fixture(); const process = child(); (spawn as jest.Mock).mockReturnValueOnce(process);
  send({ type: 'subscribe_logs', services: ['mme'] }); process.emit('close', 2);
  expect(logger.warn).toHaveBeenCalledWith({ service: 'mme', code: 2 }, 'tail process closed with error');
  handler.cleanup(); expect(process.kill).not.toHaveBeenCalled();
  (spawn as jest.Mock).mockImplementationOnce(() => { throw new Error('spawn failed'); });
  send({ type: 'subscribe_logs', services: ['amf'] });
  expect(logger.error).toHaveBeenCalledWith({ err: 'Error: spawn failed' }, 'Failed to parse WebSocket message');
});
