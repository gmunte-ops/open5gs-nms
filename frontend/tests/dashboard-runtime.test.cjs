const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const root = path.resolve(__dirname, '..');
const options = { bundle: true, platform: 'node', format: 'cjs', write: false, absWorkingDir: root,
  external: ['react', 'react-dom', 'react/jsx-runtime', 'axios'], define: { 'import.meta.env.VITE_API_URL': '""' } };
function compile(result) {
  const m = new Module(__filename, module); m.filename = __filename; m.paths = module.paths;
  m._compile(result.outputFiles[0].text, __filename); return m.exports;
}
const model = compile(esbuild.buildSync({ ...options, entryPoints: ['src/components/dashboard/ims-service-view.ts'] }));
const presentation = compile(esbuild.buildSync({ ...options, entryPoints: ['src/components/services/service-target-view.ts'] }));
let Page;
before(async () => {
  const mocks = {
    stores: 'export const useServiceStore = s => s({ statuses: globalThis.dashboardServices, fetchStatuses: () => {} }); export const useSubscriberStore = s => s({ total: 0, fetchSubscribers: () => {} });',
    api: 'export const configApi = {}; export const serviceApi = {}; export const interfaceApi = {}; export const radioBlockApi = {};',
    sas: 'export const sasApi = {};', ims: 'export const imsApi = {};', vowifi: 'export const vowifiApi = {};',
    pstn: 'export const pstnApi = {};', secgw: 'export const secgwApi = {};', mms: 'export const mmsApi = {};',
    vectorcoreSmsc: 'export const vectorcoreSmscApi = {};', ConfirmModal: 'export const ConfirmModal = () => null;',
  };
  const result = await esbuild.build({ ...options, entryPoints: ['src/components/dashboard/DashboardPage.tsx'], plugins: [{ name: 'dashboard-fixtures', setup(build) {
    build.onResolve({ filter: /\/(stores|api|sas|ims|vowifi|pstn|secgw|mms|vectorcoreSmsc|ConfirmModal)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
  } }] });
  Page = compile(result).DashboardPage;
});
const labels = { pcscf: 'P-CSCF', icscf: 'I-CSCF', scscf: 'S-CSCF', pyhss: 'PyHSS', rtpengine: 'RTPengine', dns: 'DNS', mysql: 'MySQL' };
function services() {
  return Object.entries(labels).map(([name, displayName]) => ({ name, displayName, active: true, state: 'running',
    target: { targetId: 'ims-docker', group: 'IMS', label: 'Docker · 192.168.1.192' }, observation: { status: 'ok' } }));
}
function render(rows) { globalThis.dashboardServices = rows; return renderToStaticMarkup(React.createElement(Page)); }

test('Dashboard suppresses legacy IMS duplicates and retains all seven semantic services', () => {
  const html = render(services());
  for (const label of Object.values(labels)) assert.equal(html.split(`>${label}<`).length - 1, 1, label);
  assert.doesNotMatch(html, /Kamailio/);
  assert.match(html, /IMS \/ Docker · 192.168.1.192/);
  assert.doesNotMatch(html, /Not Installed/);
  assert.match(html, /IMS measurements unavailable/);
  assert.match(html, /IPsec SAs unavailable/);
  assert.doesNotMatch(html, />0 IPsec SAs</);
});

test('legacy rows remain only for logical functions absent from semantic inventory, even on read failure', () => {
  const html = render([{ ...services()[0], active: false, state: 'unavailable', observation: { status: 'unavailable' } }]);
  assert.equal(html.split('>P-CSCF<').length - 1, 1);
  assert.equal(html.split('>I-CSCF<').length - 1, 1);
  assert.equal(html.split('>S-CSCF<').length - 1, 1);
  assert.equal(html.split('>Kamailio<').length - 1, 2);
  assert.equal(render([]).split('>Kamailio<').length - 1, 3);
});

test('semantic service health overrides legacy Not Installed without inventing measurements', () => {
  const result = model.imsServiceView(services(), { installed: false, imsEnabled: false });
  assert.deepEqual(result, { semantic: true, active: true, label: 'Active' });
  const otherPlatform = services().map(s => ({ ...s, source: 'anything', target: { ...s.target, targetId: 'another', label: 'Other runtime' } }));
  assert.deepEqual(model.imsServiceView(otherPlatform, null), result);
  assert.equal(model.imsServiceView([], { installed: false, imsEnabled: false }).label, 'Not Installed');
  assert.equal(model.imsServiceView([], { installed: true, imsEnabled: false }).label, 'Stopped');
  assert.equal(model.imsServiceView([], { installed: true, imsEnabled: true }).label, 'Active');
});

test('missing, unavailable, stopped and incomplete semantic IMS targets remain distinct', () => {
  for (const [state, observation, expected] of [['missing', 'ok', 'Not Installed'], ['unavailable', 'unavailable', 'Unavailable'], ['stopped', 'ok', 'Stopped'], ['degraded', 'ok', 'Degraded']]) {
    assert.equal(model.imsServiceView(services().map(s => ({ ...s, state, active: false, observation: { status: observation } })), null).label, expected);
  }
  const split = services().slice(0, 3).map((s, i) => ({ ...s, target: { ...s.target, targetId: `target-${i}` } }));
  assert.equal(model.imsServiceView(split, null).label, 'Degraded');
});

test('IMS/VoWiFi layout wraps based on available card width with shrink-safe children', () => {
  const html = render(services());
  assert.match(html, /grid-cols-\[repeat\(auto-fit,minmax\(min\(100%,14rem\),1fr\)\)\]/);
  assert.match(html, /IMS Status/); assert.match(html, /VoWiFi Status/);
  assert.match(html, /flex min-w-0 items-start justify-between gap-3 p-4/);
  assert.match(html, /shrink-0 p-2.5/);
});

test('placement rendering is generic, omits unresolved addresses, and preserves Docker presentation', () => {
  const row = { name: 'amf', state: 'active', active: true, presentation: { domain: '5G Core', platform: 'Kubernetes', hostAddress: '192.0.2.25' } };
  assert.equal(presentation.servicePresentationLabel(row), '5G Core / Kubernetes · 192.0.2.25');
  assert.match(render([row]), /5G Core \/ Kubernetes · 192.0.2.25/);
  assert.equal(presentation.servicePresentationLabel({ ...row, presentation: { domain: '5G Core', platform: 'Kubernetes' } }), '5G Core / Kubernetes');
  assert.equal(presentation.servicePresentationLabel(services()[0]), 'IMS / Docker · 192.168.1.192');
  const source = ['components/dashboard/ims-service-view.ts', 'components/dashboard/DashboardPage.tsx', 'components/services/service-target-view.ts']
    .map(file => fs.readFileSync(path.join(root, 'src', file), 'utf8')).join('\n');
  assert.doesNotMatch(source, /(?:===|!==)\s*['"](?:docker|kubernetes|systemd)['"]/);
});
