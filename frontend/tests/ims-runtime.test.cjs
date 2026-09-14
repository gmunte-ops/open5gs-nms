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
const { selectImsServices, RuntimeImsTab } = compile(esbuild.buildSync({ ...options, entryPoints: ['src/components/ims/RuntimeImsView.tsx'] }));
let Page;
before(async () => {
  Page = compile(await esbuild.build({ ...options, entryPoints: ['src/pages/IMSPage.tsx'], plugins: [{ name: 'fixtures', setup(build) {
    build.onResolve({ filter: /useImsServiceInventory$/ }, () => ({ path: 'inventory', namespace: 'fixture' }));
    build.onResolve({ filter: /^@monaco-editor\/react$/ }, () => ({ path: 'editor', namespace: 'fixture' }));
    build.onResolve({ filter: /\/api\/ims$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: args.path === 'inventory'
      ? 'export const useImsServiceInventory = () => globalThis.imsInventory;'
      : args.path === 'editor' ? 'export default () => null;'
      : 'export const imsApi = new Proxy({}, { get() { throw new Error("Legacy IMS API must not be used for semantic targets"); } });', loader: 'js' }));
  } }] })).IMSPage;
});
const names = { pcscf: 'P-CSCF', icscf: 'I-CSCF', scscf: 'S-CSCF', pyhss: 'PyHSS', rtpengine: 'RTPengine', dns: 'DNS', mysql: 'MySQL' };
function services() {
  return Object.entries(names).map(([name, displayName]) => ({ name, displayName, active: true, state: 'running', restartCount: 0,
    lastChecked: '2026-09-14T10:00:00Z', observation: { status: 'ok' },
    target: { targetId: 'ims-target', group: 'IMS', label: 'Runtime · 192.0.2.20' } }));
}
function renderInventory(services, error = null) {
  globalThis.imsInventory = { services, error, refresh() {} };
  return renderToStaticMarkup(React.createElement(Page));
}
function renderTab(tab, rows = services()) { return renderToStaticMarkup(React.createElement(RuntimeImsTab, { services: rows, tab })); }

test('IMS menu uses all seven semantic services, without false local installation badges or controls', () => {
  const html = renderInventory(services());
  for (const label of Object.values(names)) assert.match(html, new RegExp(label));
  assert.match(html, /Service Status · Active/);
  assert.doesNotMatch(html, /Not Installed|Install IMS|PyHSS-Diam|MariaDB|BIND9 DNS|Sync Now|Remove IMS/);
  assert.match(html, /Overview/); assert.match(html, /Live Status/); assert.match(html, /Config Files/);
});

test('Live Status shows observations and explicit unavailable diagnostics, not local zero counters', () => {
  const html = renderTab('live');
  assert.match(html, /Live Service Status/);
  assert.match(html, /2026-09-14T10:00:00Z/);
  assert.match(html, /Restarts: 0/);
  assert.match(html, /IMS measurements unavailable/);
  assert.doesNotMatch(html, /Deregister|0 registered|0 calls/);
});

test('Config Files explains unsupported remote inventory and never renders the local editor', () => {
  const html = renderTab('configs');
  assert.match(html, /Config Files — unavailable/);
  assert.match(html, /Configuration remains managed by the target deployment/);
  assert.doesNotMatch(html, /Save|Restart|textarea|\/etc\//);
});

test('failed discovery and failed target observations never trigger local fallback', () => {
  assert.match(renderInventory(null, 'Inventory unavailable'), /Inventory unavailable/);
  assert.match(renderInventory(services(), 'Inventory unavailable'), /Inventory unavailable/);
  const failed = services().map(s => ({ ...s, active: false, state: 'unavailable', error: 'API unreachable', observation: { status: 'unavailable' } }));
  assert.match(renderInventory(failed), /API unreachable/);
  assert.doesNotMatch(renderInventory(failed), /Not Installed|Install IMS/);
});

test('selection uses semantic identity and target, preserving the no-semantic legacy route', () => {
  const rows = [...services(), { name: 'amf', target: undefined }, { name: 'mysql', target: { targetId: 'unrelated' } }];
  assert.equal(selectImsServices(rows).length, 7);
  assert.deepEqual(selectImsServices([{ name: 'amf' }]), []);
  assert.doesNotMatch(renderInventory([]), /IMS runtime services/);
  assert.match(renderInventory(null), /Loading IMS service inventory/);
});

test('installer is removed and no platform-name conditions were introduced', () => {
  const page = fs.readFileSync(path.join(root, 'src/pages/IMSPage.tsx'), 'utf8');
  assert.doesNotMatch(page, /InstallCard|imsApi\.install\(|Install IMS Software|setInstalling/);
  const view = fs.readFileSync(path.join(root, 'src/components/ims/RuntimeImsView.tsx'), 'utf8');
  assert.doesNotMatch(page + view, /(?:===|!==)\s*['"](?:docker|kubernetes|systemd)['"]/);
});
