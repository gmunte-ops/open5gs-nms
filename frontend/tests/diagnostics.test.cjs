const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
function load(file) {
  const result = esbuild.buildSync({ entryPoints: [path.join(__dirname, '../src', file)], bundle: true, platform: 'node',
    format: 'cjs', write: false, external: ['react', 'react-dom', 'react/jsx-runtime'] });
  const m = new Module(__filename, module); m.filename = __filename; m.paths = module.paths;
  m._compile(result.outputFiles[0].text, __filename); return m.exports;
}
const { diagnosticsInterfaceView, diagnosticsPermitted, readable, legacyRanManagementAllowed } = load('components/diagnostics/diagnostics-view.ts');
const { DiagnosticsStatus } = load('components/diagnostics/DiagnosticsStatus.tsx');
const meta = { observedAt: '2026-09-12T00:00:00Z', sources: [] };
const ok = data => ({ ...meta, status: 'ok', data });
const unsupported = { ...meta, status: 'unsupported', reason: 'No verified Kubernetes-accessible Open5GS diagnostics source is configured' };
let RANPage;
before(async () => {
  const mocks = {
    useNfDiagnostics: 'export const useNfDiagnostics = () => globalThis.diagnosticsFixture;',
    AuthContext: 'export const useAuth = () => ({ user: { role: "viewer" } });',
    api: 'export const radioTagsApi = {}; export const radioBlockApi = {}; export const gnbBlockApi = {}; export const configApi = {};',
    ueBlock: 'export const getBlockedUes = () => []; export const blockUe = () => {}; export const unblockUe = () => {};',
    ims: 'export const imsApi = {};',
  };
  const result = await esbuild.build({ entryPoints: [path.join(__dirname, '../src/components/ran/RANPage.tsx')], bundle: true,
    platform: 'node', format: 'cjs', write: false, external: ['react', 'react-dom', 'react/jsx-runtime'],
    plugins: [{ name: 'fixtures', setup(build) {
      build.onResolve({ filter: /\/(useNfDiagnostics|AuthContext|api|ueBlock|ims)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'fixture' }));
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    } }] });
  const m = new Module(__filename, module); m.filename = __filename; m.paths = module.paths;
  m._compile(result.outputFiles[0].text, __filename); RANPage = m.exports.RANPage;
});
function snapshot() {
  return { targetId: 'local', capabilities: ['radios', 'ues', 'sessions'].map(op => ({ id: `diagnostics.${op}.read`,
    scope: { kind: 'target', targetId: 'local' }, support: { status: 'supported' }, policy: { status: 'allowed' },
    access: { status: 'unknown' }, availability: { status: 'unknown' } })), radios: ok([]), ues: ok([]), sessions: ok([]),
    services: { mme: { radios: ok([]), ues: ok([]) }, amf: { radios: ok([]), ues: ok([]) } } };
}
test('unsupported displays reason, not a successful zero', () => {
  const s = { ...snapshot(), targetId: 'kubernetes', radios: unsupported, ues: unsupported, sessions: unsupported };
  const html = renderToStaticMarkup(React.createElement(DiagnosticsStatus, { data: s }));
  assert.match(html, /No verified Kubernetes-accessible/);
  assert.doesNotMatch(html, /No records observed|0 observed/);
  assert.equal(readable(unsupported), false);
});
test('empty and malformed have distinct presentation', () => {
  const s = snapshot();
  s.sessions = { ...meta, status: 'error', reason: 'Malformed response' };
  const html = renderToStaticMarkup(React.createElement(DiagnosticsStatus, { data: s }));
  assert.match(html, /No records observed/); assert.match(html, /error: Malformed response/);
});
test('distinct sessions sharing a DNN and IPv6-only sessions survive presentation', () => {
  const s = snapshot();
  const service = { targetId: 'local', nf: 'smf' };
  s.sessions = ok([{ service, sources: [], rat: '5G', imsi: '123', id: 'psi:1', apn: 'internet', ip: '10.0.0.1' },
    { service, sources: [], rat: '5G', imsi: '123', id: 'psi:2', apn: 'internet', ipv6: '2001:db8::1' }]);
  s.ues = unsupported;
  const rows = diagnosticsInterfaceView(s).activeUEs5G;
  assert.equal(rows.length, 1); assert.equal(rows[0].sessions.length, 2);
  assert.deepEqual(rows[0].sessions.map(s => s.id), ['psi:1', 'psi:2']);
  assert.equal(rows[0].sessions[1].ip, '2001:db8::1');
});
test('registered UE without session remains visible with no fabricated session', () => {
  const s = snapshot();
  s.ues = ok([{ service: { targetId: 'local', nf: 'amf' }, sources: [], rat: '5G', imsi: '123', cmState: 'idle' }]);
  assert.deepEqual(diagnosticsInterfaceView(s).activeUEs5G[0].sessions, []);
  assert.equal(diagnosticsInterfaceView(null), null);
});
test('capability support, policy, access and target are respected; unknown access is not denial', () => {
  const s = snapshot();
  assert.equal(diagnosticsPermitted(s, 'radios'), true);
  s.capabilities[0].access.status = 'denied';
  assert.equal(diagnosticsPermitted(s, 'radios'), false);
  s.capabilities[0].access.status = 'unknown';
  s.capabilities[0].policy.status = 'denied';
  assert.equal(diagnosticsPermitted(s, 'radios'), false);
  s.capabilities[0].policy.status = 'allowed';
  s.capabilities[0].scope.targetId = 'other';
  assert.equal(diagnosticsPermitted(s, 'radios'), false);
});
test('Radios page shows explicit unsupported reason with no zero-count cards', () => {
  const data = { ...snapshot(), targetId: 'kubernetes', capabilities: [], radios: unsupported, ues: unsupported, sessions: unsupported };
  globalThis.diagnosticsFixture = { data, error: null, refresh() {} };
  const html = renderToStaticMarkup(React.createElement(RANPage));
  assert.match(html, /No verified Kubernetes-accessible/);
  assert.doesNotMatch(html, /S1-MME Interface|N2 Interface|0 UE rows|No active UE sessions/);
});
test('failed refresh renders an error instead of stale or empty diagnostics', () => {
  globalThis.diagnosticsFixture = { data: null, error: 'NF diagnostics could not be retrieved.', refresh() {} };
  const html = renderToStaticMarkup(React.createElement(RANPage));
  assert.match(html, /could not be retrieved/);
  assert.doesNotMatch(html, /S1-MME Interface|0 UE rows/);
});
test('partial source coverage hides unavailable 4G cards while retaining 5G data', () => {
  const data = snapshot();
  data.services.mme.radios = { ...meta, status: 'unavailable', reason: 'MME unreachable' };
  data.radios = { ...meta, status: 'partial', data: [], issues: [{ code: 'unavailable', reason: 'MME unreachable' }] };
  globalThis.diagnosticsFixture = { data, error: null, refresh() {} };
  const html = renderToStaticMarkup(React.createElement(RANPage));
  assert.match(html, /MME unreachable/); assert.match(html, /N2 Interface/);
  assert.doesNotMatch(html, /S1-MME Interface/);
});


test('N3 session address alone is observed with unknown connectivity', () => {
  const s = snapshot();
  s.sessions = ok([{ service: { targetId: 'local', nf: 'smf' }, sources: [], rat: '5G', imsi: '123', apn: 'internet', radioIp: '192.0.2.1' }]);
  const result = diagnosticsInterfaceView(s);
  assert.equal(result.n3.active, null);
  assert.equal(result.n3.connectedGnodebs[0].setupSuccess, null);
  globalThis.diagnosticsFixture = { data: s, error: null, refresh() {} };
  assert.match(renderToStaticMarkup(React.createElement(RANPage)), /connectivity unknown/);
});

test('N3 retains baseline current-N2 correlation without discarding raw sessions', () => {
  const s = snapshot();
  const radio = { service: { targetId: 'local', nf: 'amf' }, sources: [], rat: '5G', id: '7', ip: '192.0.2.1', setupSuccess: true, numConnectedUes: 1 };
  s.radios = ok([radio]); s.services.amf.radios = ok([radio]);
  s.sessions = ok(['192.0.2.1', '192.0.2.2'].map((radioIp, i) => ({ service: { targetId: 'local', nf: 'smf' }, sources: [], rat: '5G', imsi: String(i), apn: 'internet', radioIp })));
  const before = JSON.stringify(s);
  const result = diagnosticsInterfaceView(s);
  assert.deepEqual(result.n3.connectedGnodebs.map(p => p.ip), ['192.0.2.1']);
  assert.equal(result.n3.active, true);
  assert.equal(result.activeUEs5G.length, 2);
  assert.equal(JSON.stringify(s), before);
});

test('MME APNs and individual EBI survive SMF unavailability in presentation', () => {
  const s = snapshot();
  s.ues = ok([{ service: { targetId: 'local', nf: 'mme' }, sources: [], rat: '4G', imsi: '123', pdn: [{ apn: 'internet', ebi: 5 }, { apn: 'ims', ebi: 6 }, { apn: 'ims', ebi: 7 }] }]);
  s.sessions = { ...meta, status: 'unavailable', reason: 'SMF unreachable' };
  const ue = diagnosticsInterfaceView(s).activeUEs4G[0];
  assert.deepEqual(ue.sessions.map(p => [p.apn, p.id]), [['internet', 'ebi:5'], ['ims', 'ebi:6'], ['ims', 'ebi:7']]);
  assert.equal(ue.sessions[0].service.nf, 'mme');
});

test('diagnostics read support never grants management rights; explicit legacy policy is independent of target name', () => {
  const s = snapshot();
  assert.equal(legacyRanManagementAllowed(s), false);
  s.legacyRanPolicy = { configurationRead: true, tags: true, radioEnforcement: true, ueEnforcement: true };
  s.targetId = 'arbitrary-target';
  assert.equal(legacyRanManagementAllowed(s), true);
  s.legacyRanPolicy.ueEnforcement = false;
  assert.equal(legacyRanManagementAllowed(s), false);
  const source = require('node:fs').readFileSync(path.join(__dirname, '../src/components/ran/RANPage.tsx'), 'utf8');
  assert.doesNotMatch(source, /targetId\s*[!=]==?\s*['"](?:local|kubernetes)['"]/);
});
