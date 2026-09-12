import { LocalLogSource } from '../infrastructure/system/local-log-source';
import { LogStreamingUseCase } from '../application/use-cases/log-streaming';
import * as fs from 'fs/promises';
import { createLogDownloadRouter } from '../interfaces/rest/log-download-controller';

jest.mock('fs/promises', () => ({ readFile: jest.fn(), writeFile: jest.fn(), mkdtemp: jest.fn(), rm: jest.fn() }));
const logger: any = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
function fixture(content: string) {
  const written = new Map<string, string>();
  (fs.mkdtemp as jest.Mock).mockResolvedValue('C:/test/nms-logs');
  (fs.writeFile as jest.Mock).mockImplementation(async (file, data) => { written.set(file, data); });
  (fs.readFile as jest.Mock).mockImplementation(async file => written.get(file) ?? content);
  (fs.rm as jest.Mock).mockResolvedValue(undefined);
  const router: any = createLogDownloadRouter({} as any, {} as any, logger, new LogStreamingUseCase(new LocalLogSource({} as any, logger)));
  const handler = router.stack.find((layer: any) => layer.route?.path === '/download').route.stack.at(-1).handle;
  const res: any = { setHeader: jest.fn(), send: jest.fn(), status: jest.fn().mockReturnThis(), json: jest.fn() };
  return { handler, res };
}
beforeEach(() => jest.clearAllMocks());

test('Open5GS raw download preserves trailing newline, line slicing and attachment headers', async () => {
  const { handler, res } = fixture('first\nsecond\nthird\n');
  await handler({ body: { services: ['mme'], range: { type: 'lines', lines: 2 } } }, res);
  expect(fs.readFile).toHaveBeenCalledWith('/var/log/open5gs/mme.log', 'utf8');
  expect(res.send).toHaveBeenCalledWith('third\n');
  expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
  expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', expect.stringMatching(/attachment; filename="mme-.*\.log"/));
  expect(fs.rm).toHaveBeenCalledWith('C:/test/nms-logs', { recursive: true, force: true });
});

test('raw download preserves date filtering and empty-file 404', async () => {
  const { handler, res } = fixture('07/01 09:00:00.000: before\n07/01 10:00:00.000: match\n07/01 11:00:00.000: after');
  await handler({ body: { services: ['mme'], range: { type: 'date', from: '2026-07-01T10:00:00', to: '2026-07-01T10:00:00' } } }, res);
  expect(res.send).toHaveBeenCalledWith('07/01 10:00:00.000: match');
  (fs.readFile as jest.Mock).mockRejectedValue(new Error('missing'));
  await handler({ body: { services: ['mme'] } }, res);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(res.json).toHaveBeenCalledWith({ error: 'No log content found for the specified range' });
});
