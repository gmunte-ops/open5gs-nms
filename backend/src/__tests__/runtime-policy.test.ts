import { parseOpen5gsRuntime, runtimeCapabilities } from '../config/runtime-policy';
import { createRuntimeMiddleware, unsupportedRuntimeFeature } from '../interfaces/rest/middleware/runtime-middleware';

describe('runtime policy', () => {
  test('preserves the local default and rejects misspelled runtime values', () => {
    expect(parseOpen5gsRuntime(undefined)).toBe('local');
    expect(parseOpen5gsRuntime('local')).toBe('local');
    expect(parseOpen5gsRuntime('kubernetes')).toBe('kubernetes');
    expect(() => parseOpen5gsRuntime('kubernets')).toThrow('Invalid OPEN5GS_RUNTIME');
    expect(runtimeCapabilities('local').coreBinaryPatches).toBe(true);
    expect(runtimeCapabilities('kubernetes')).toMatchObject({
      hostDataplane: false, managedPrometheusConfig: false, coreBinaryPatches: false,
    });
  });

  test.each([
    ['POST', '/config/apply'], ['POST', '/config/sync-sd'],
    ['PUT', '/CONFIG/APPLY/'], ['POST', '/%63onfig/apply'],
    ['POST', '/auto-config/apply'], ['POST', '/dns-migration/rollback'],
    ['POST', '/plmn-migration/apply'], ['POST', '/backup/full/restore'],
    ['GET', '/backup/full/download'], ['POST', '/backup/restore-defaults'],
    ['POST', '/ims/install'], ['PUT', '/ims/configs/content'],
    ['POST', '/vowifi/uninstall'], ['POST', '/sms/configure'],
    ['POST', '/modules/fix-all'], ['POST', '/apn-profiles/internet/promote'],
    ['POST', '/suci/generate'], ['POST', '/ue-block/123/detach'],
    ['GET', '/interface-status'], ['POST', '/pcap/start'],
    ['GET', '/logs/context'], ['GET', '/logs/debug-bundle'],
    ['POST', '/subscribers/import'], ['GET', '/subscribers/auto-assign-ips/pool'],
    ['POST', '/snmp/install'], ['GET', '/snmp/stats'],
  ])('%s %s is blocked before its handler only in Kubernetes', (method, path) => {
    expect(unsupportedRuntimeFeature('kubernetes', method, path)).toBeDefined();
    expect(unsupportedRuntimeFeature('local', method, path)).toBeUndefined();
  });

  test.each([
    ['GET', '/config/topology/graph'], ['GET', '/runtime'],
    ['GET', '/services'], ['POST', '/services/osmo-msc/restart'],
    ['GET', '/subscribers'], ['GET', '/subscribers/001010000000001'],
    ['POST', '/chrony/restart'], ['POST', '/bind/configure'],
    ['POST', '/speedtest/start'], ['GET', '/ims/status'],
  ])('preserves independent host/data operations: %s %s', (method, path) => {
    expect(unsupportedRuntimeFeature('kubernetes', method, path)).toBeUndefined();
  });

  test('unsupported operations terminate without invoking the next handler', () => {
    const next = jest.fn();
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    createRuntimeMiddleware('kubernetes')({ method: 'POST', path: '/ims/install' } as any, res as any, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(501);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'RUNTIME_UNSUPPORTED' }));
  });
});
