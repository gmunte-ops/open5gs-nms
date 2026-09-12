import { EventEmitter } from 'events';
import { PassThrough } from 'stream';
import { spawn } from 'child_process';
import { readFile } from 'fs/promises';
import { ILogSource } from '../domain/contracts';
import { LogStreamingUseCase } from '../application/use-cases/log-streaming';
import { LocalLogSource } from '../infrastructure/system/local-log-source';
import { MAJOR_EVENT_GREP_PATTERNS } from '../application/use-cases/major-event-classifier';

jest.mock('child_process', () => ({ spawn: jest.fn() }));
jest.mock('fs/promises', () => ({ readFile: jest.fn() }));
const ref = { targetId: 'local', nf: 'mme' };
function fixture() {
  const host = { executeCommand: jest.fn().mockResolvedValue({ exitCode: 0, stdout: 'entry\n' }) };
  const logger: any = { warn: jest.fn(), error: jest.fn() };
  const source = new LocalLogSource(host as any, logger);
  const child: any = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = jest.fn();
  (spawn as jest.Mock).mockReturnValue(child);
  return { source, host, child };
}
beforeEach(() => jest.resetAllMocks());

test('facade maps legacy names to the injected target without platform selection', async () => {
  const cancel = jest.fn(); const observer = { onEntry: jest.fn() };
  const source: ILogSource = {
    targetId: 'target-a', readRecent: jest.fn().mockResolvedValue([]),
    readMajorEventCandidates: jest.fn().mockResolvedValue([]), readText: jest.fn().mockResolvedValue('raw'),
    follow: jest.fn().mockReturnValue({ cancel }),
  };
  const logs = new LogStreamingUseCase(source);
  const service = { targetId: 'target-a', nf: 'mme' };
  await logs.getRecentLogs(['mme']);
  expect(source.readRecent).toHaveBeenCalledWith({ services: [service], limit: 100 });
  await logs.getMajorEventLogs(['mme'], 2000);
  expect(source.readMajorEventCandidates).toHaveBeenCalledWith({ services: [service], maxPerService: 2000 });
  expect(await logs.readText('mme', { type: 'all' })).toBe('raw');
  expect(source.readText).toHaveBeenCalledWith(service, { type: 'all' });
  logs.follow('mme', observer).cancel();
  expect(source.follow).toHaveBeenCalledWith(service, observer); expect(cancel).toHaveBeenCalledTimes(1);
});

test('facade propagates read and setup errors without reinterpreting them', async () => {
  const failure = new Error('source failed');
  const source = { targetId: 'target-a', readRecent: jest.fn().mockRejectedValue(failure),
    follow: jest.fn(() => { throw failure; }) } as unknown as ILogSource;
  const logs = new LogStreamingUseCase(source);
  await expect(logs.getRecentLogs(['mme'])).rejects.toBe(failure);
  expect(() => logs.follow('mme', { onEntry: jest.fn() })).toThrow(failure);
});

test('local recent reads accept semantic refs and retain default limits', async () => {
  const { source, host } = fixture();
  expect(await source.readRecent({ services: [ref] })).toEqual([
    { service: 'mme', message: 'entry', timestamp: expect.any(String) },
  ]);
  expect(host.executeCommand).toHaveBeenCalledWith('tail', ['-n', '100', '/var/log/open5gs/mme.log']);
});

test('wrong-target refs cannot read or start a stream', async () => {
  const { source, host } = fixture(); const foreign = { ...ref, targetId: 'other' };
  expect(() => source.readRecent({ services: [foreign] })).toThrow('different target');
  expect(() => source.readMajorEventCandidates({ services: [foreign], maxPerService: 1 })).toThrow('different target');
  await expect(source.readText(foreign, { type: 'all' })).rejects.toThrow('different target');
  expect(() => source.follow(foreign, { onEntry: jest.fn() })).toThrow('different target');
  expect(host.executeCommand).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled(); expect(readFile).not.toHaveBeenCalled();
});

test('major-event candidates retain the existing pattern order and bound', async () => {
  const { source } = fixture();
  const grep = jest.spyOn(source, 'getGreppedLogs').mockResolvedValue([]);
  const names = Object.keys(MAJOR_EVENT_GREP_PATTERNS);
  await source.readMajorEventCandidates({ services: [...names].reverse().map(nf => ({ ...ref, nf })), maxPerService: 2000 });
  expect(grep).toHaveBeenCalledWith(MAJOR_EVENT_GREP_PATTERNS, 2000);
  expect(Object.keys(grep.mock.calls[0][0])).toEqual(names);
});

test('follow emits entries and cancellation is idempotent', () => {
  const { source, child } = fixture(); const onEntry = jest.fn();
  const subscription = source.follow(ref, { onEntry });
  child.stdout.emit('data', Buffer.from('entry\n'));
  expect(onEntry).toHaveBeenCalledWith({ service: 'mme', message: 'entry', timestamp: expect.any(String) });
  subscription.cancel(); subscription.cancel(); expect(child.kill).toHaveBeenCalledTimes(1);
});

test('follow forwards asynchronous errors and completion without exposing process handles', () => {
  const { source, child } = fixture(); const onError = jest.fn(); const onEnd = jest.fn();
  const subscription = source.follow(ref, { onEntry: jest.fn(), onError, onEnd });
  const failure = new Error('stream failed'); child.emit('error', failure); child.emit('close', 1);
  expect(onError).toHaveBeenCalledWith(failure); expect(onEnd).toHaveBeenCalledWith();
  subscription.cancel(); expect(child.kill).not.toHaveBeenCalled();
});

test('setup and cancellation failures propagate to the caller', () => {
  const { source, child } = fixture(); const failure = new Error('cleanup failed');
  child.kill.mockImplementation(() => { throw failure; });
  const subscription = source.follow(ref, { onEntry: jest.fn() });
  expect(() => subscription.cancel()).toThrow(failure);
  (spawn as jest.Mock).mockImplementation(() => { throw failure; });
  expect(() => source.follow(ref, { onEntry: jest.fn() })).toThrow(failure);
});

test('raw reads preserve content and legacy empty result on filesystem errors', async () => {
  const { source } = fixture(); (readFile as jest.Mock).mockResolvedValue('raw\n');
  expect(await source.readText(ref, { type: 'all' })).toBe('raw\n');
  (readFile as jest.Mock).mockRejectedValue(new Error('read failed'));
  expect(await source.readText(ref, { type: 'all' })).toBe('');
});
