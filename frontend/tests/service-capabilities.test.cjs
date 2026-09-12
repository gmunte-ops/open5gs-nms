const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const Module = require('node:module');
const esbuild = require('esbuild');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
function compile(result) {
  const module = new Module(path.join(__dirname, 'compiled.cjs'), moduleParent);
  module.filename = path.join(__dirname, 'compiled.cjs');
  module.paths = Module._nodeModulePaths(__dirname);
  module._compile(result.outputFiles[0].text, module.filename);
  return module.exports;
}
const moduleParent = module;
const options = { bundle: true, platform: 'node', format: 'cjs', write: false, absWorkingDir: root,
  external: ['react', 'react-dom', 'react/jsx-runtime', 'axios'], define: { 'import.meta.env.VITE_API_URL': '""' }, logLevel: 'silent' };
const model = compile(esbuild.buildSync({ ...options, entryPoints: ['src/components/services/capability-view.ts'] }));
const components = compile(esbuild.buildSync({ ...options, entryPoints: ['src/components/services/ServiceCapabilities.tsx'] }));
let Page;
before(async () => {
  const mocks = {
    stores: 'export const useServiceStore = selector => selector(globalThis.servicesFixture.store);',
    useServiceCapabilities: 'export const useServiceCapabilities = () => globalThis.servicesFixture.capabilities;',
    api: 'export const serviceApi = {};',
    vowifi: 'export const vowifiApi = {};', mms: 'export const mmsApi = {};', vectorcoreSmsc: 'export const vectorcoreSmscApi = {};',
    SpeedTestServerModal: 'export const SpeedTestServerModal = () => null;',
  };
  const result = await esbuild.build({ ...options, entryPoints: ['src/components/services/ServicesPage.tsx'], plugins: [{ name: 'page-fixtures', setup(build) {
    build.onResolve({ filter: /\/(stores|useServiceCapabilities|api|vowifi|mms|vectorcoreSmsc|SpeedTestServerModal)$/ }, args => ({ path: args.path.split('/').pop(), namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({ contents: mocks[args.path], loader: 'js' }));
  } }] });
  Page = compile(result).ServicesPage;
});

function descriptor(id = 'lifecycle.restart', changes = {}) {
  return { id, scope: { kind: 'service', service: { targetId: 'local', nf: 'mme' } },
    support: { status: 'supported' }, policy: { status: 'allowed' }, access: { status: 'unknown' }, availability: { status: 'unknown' }, ...changes };
}
function load(changes = {}) {
  return { status: 'ready', data: [descriptor('fm.read'), ...['start', 'stop', 'restart', 'enableAtBoot', 'disableAtBoot'].map(action => descriptor(`lifecycle.${action}`, changes))] };
}
function renderPage(assessment, serviceChanges = {}) {
  globalThis.servicesFixture = {
    store: { statuses: [{ name: 'mme', unitName: 'unit', active: true, enabled: true, state: 'active', subState: 'running', ...serviceChanges }], fetchStatuses: () => {} },
    capabilities: { services: { mme: assessment }, target: { status: 'unavailable' }, refresh: () => {} },
  };
  return renderToStaticMarkup(React.createElement(Page));
}
function restartTag(markup) {
  return markup.match(/<button\b[^>]*aria-label="Restart:[^>]*>/)?.[0];
}

test('local restart is shown available, normal state controls remain in force', () => {
  const html = renderPage(load());
  assert.match(restartTag(html), /Restart: Available/);
  assert.doesNotMatch(restartTag(html), /disabled/);
  assert.match(html, /server checks every lifecycle action/i);
  assert.match(html, /<button disabled=""[^>]*aria-label="Start:/);
});

test('managed restart is visibly blocked with reason, independent of source name', () => {
  const html = renderPage(load({ support: { status: 'unsupported' }, policy: { status: 'denied', reason: 'Read-only target policy' } }), { source: 'kubernetes', actionsSupported: false });
  assert.match(restartTag(html), /disabled/);
  assert.match(html, /Restart: Blocked by target policy/);
  assert.match(html, /Read-only target policy/);
});

test('unsupported without policy denial is unavailable with an implementation reason', () => {
  const view = model.capabilityView(descriptor(undefined, { support: { status: 'unsupported', reason: 'Operation not implemented' } }));
  assert.equal(view.disabled, true);
  assert.equal(view.label, 'Unavailable');
  assert.equal(view.reason, 'Operation not implemented');
});

test('FM is readable even when lifecycle is blocked', () => {
  const html = renderPage(load({ policy: { status: 'denied' } }), { actionsSupported: false });
  assert.match(html, /FM read: Readable/);
  assert.match(html, /Restart: Blocked by target policy/);
});

test('unknown access and availability are distinct from denied access and unavailable provider', () => {
  const unknown = renderPage(load());
  assert.match(unknown, /Access: assessment unknown/);
  assert.match(unknown, /Availability: assessment unknown/);
  assert.doesNotMatch(unknown, /Access: denied|Availability: unavailable/);
  assert.doesNotMatch(restartTag(unknown), /disabled/);
  const denied = renderPage(load({ access: { status: 'denied', reason: 'Permission assessment denied' } }));
  assert.match(denied, /Access: denied/);
  assert.match(restartTag(denied), /disabled/);
  const unavailable = renderPage(load({ availability: { status: 'unavailable', reason: 'Provider unreachable' } }));
  assert.match(unavailable, /Availability: unavailable/);
  assert.match(restartTag(unavailable), /disabled/);
});

test('discovery rejection is isolated and page retains status and legacy restrictions', async () => {
  const failed = await model.loadCapabilities(async () => { throw new Error('API offline'); }, 'mme');
  assert.deepEqual(failed, { status: 'unavailable' });
  const protectedPage = renderPage(failed, { actionsSupported: false });
  assert.match(protectedPage, /active\/running/);
  assert.match(protectedPage, /Capability assessment unavailable/);
  assert.match(restartTag(protectedPage), /disabled/);
  assert.match(protectedPage, /<button[^>]*disabled=""[^>]*>.*?Restart All/s);
  const localPage = renderPage(failed);
  assert.match(restartTag(localPage), /Assessment unknown/);
  assert.doesNotMatch(restartTag(localPage), /disabled/);
});

test('optimistic discovery cannot override server-reported unsupported lifecycle', () => {
  const html = renderPage(load(), { actionsSupported: false });
  assert.match(restartTag(html), /disabled/);
  assert.match(html, /service reports lifecycle actions as unsupported/);
});

test('last successful restrictions are explained as retained on refresh failure', () => {
  const stale = { ...load({ policy: { status: 'denied', reason: 'Target policy' } }), status: 'unavailable' };
  const html = renderPage(stale);
  assert.match(html, /Showing the last successful assessment/);
  assert.match(restartTag(html), /disabled/);
});

test('incomplete, failed and mismatched observations do not fabricate permission', async () => {
  for (const result of [undefined, {}, { status: 'not-found' }, { status: 'ok', data: [] }, { status: 'ok', data: [descriptor('fm.read', { scope: { kind: 'service', service: { nf: 'other' } } })] }]) {
    assert.equal((await model.loadCapabilities(async () => result, 'mme')).status, 'unavailable');
  }
  const partial = await model.loadCapabilities(async () => ({ status: 'partial', data: [descriptor()] }), 'mme');
  assert.equal(partial.status, 'partial');
  assert.equal(partial.data.length, 1);
});

test('group assessment uses service scopes, including boot action translation', () => {
  assert.equal(model.capabilityId('enable'), 'lifecycle.enableAtBoot');
  assert.equal(model.capabilityId('disable'), 'lifecycle.disableAtBoot');
  assert.equal(model.bulkActionView([{ name: 'mme' }], { mme: load({ policy: { status: 'denied', reason: 'Policy block' } }) }, 'restart').disabled, true);
  assert.equal(model.bulkActionView([{ name: 'mme', actionsSupported: false }], {}, 'restart').disabled, true);
  assert.equal(model.bulkActionView([{ name: 'mme' }], {}, 'restart').disabled, false);
});

test('button respects existing busy/state restrictions even with available capability', () => {
  const html = renderToStaticMarkup(React.createElement(components.CapabilityActionButton, { view: model.capabilityView(descriptor()), disabled: true, className: '', label: 'Restart' }, 'Restart'));
  assert.match(html, /disabled=""/);
});

test('Services UI contains no platform-name conditionals', () => {
  for (const file of ['ServicesPage.tsx', 'ServiceCapabilities.tsx', 'capability-view.ts', 'KubernetesWorkloadDetails.tsx']) {
    const source = ts.createSourceFile(file, fs.readFileSync(path.join(root, 'src/components/services', file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function inspect(node) {
      if (ts.isTypeNode(node)) return; // Legacy payload types are not runtime platform checks.
      if (ts.isStringLiteral(node) && ['local', 'systemd', 'kubernetes', 'docker'].includes(node.text)) {
        assert.fail(`${file} includes a platform-name literal in UI logic: ${node.text}`);
      }
      ts.forEachChild(node, inspect);
    }
    inspect(source);
  }
});

test('discovery uses GET only and existing lifecycle routes preserve server refusal', async () => {
  const calls = [];
  const refusal = { success: false, message: 'Blocked by server lifecycle policy' };
  globalThis.capabilityApiFixture = { interceptors: { response: { use: () => {} } },
    get: async url => { calls.push(['GET', url]); return { data: { success: true, data: { status: 'ok', data: [] } } }; },
    post: async (...args) => { calls.push(['POST', ...args]); return { data: refusal }; },
  };
  const result = await esbuild.build({ ...options, entryPoints: ['src/api/index.ts'], plugins: [{ name: 'http-fixture', setup(build) {
    build.onResolve({ filter: /^axios$/ }, () => ({ path: 'axios', namespace: 'http-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'http-fixture' }, () => ({ contents: 'export default { create: () => globalThis.capabilityApiFixture };', loader: 'js' }));
  } }] });
  const api = compile(result).serviceApi;
  await api.getCapabilities();
  await api.getCapabilities('mme');
  assert.deepEqual(calls, [['GET', '/service-capabilities'], ['GET', '/service-capabilities/mme']]);
  assert.deepEqual(await api.action('mme', 'restart'), refusal);
  assert.deepEqual(await api.bulkAction('restart', ['mme']), refusal);
  assert.deepEqual(calls.slice(2), [['POST', '/services/mme/restart'], ['POST', '/services/all/restart', { services: ['mme'] }]]);
});

test('fresh FM evidence is displayed, while expired evidence becomes unknown without an outage', () => {
  const now = Date.now();
  const fresh = descriptor('fm.read', { availability: { status: 'available' }, availabilityEvidence: {
    observedAt: new Date(now - 1000).toISOString(), validUntil: new Date(now + 29_000).toISOString(),
  } });
  const freshPage = renderPage({ status: 'ready', data: [fresh] });
  assert.match(freshPage, /Availability: available/);
  assert.match(freshPage, /FM observation:/);
  const stale = { ...fresh, availabilityEvidence: { ...fresh.availabilityEvidence, validUntil: new Date(now - 1).toISOString() } };
  const stalePage = renderPage({ status: 'ready', data: [stale] });
  assert.match(stalePage, /Availability: assessment unknown/);
  assert.match(stalePage, /FM availability evidence is stale/);
  assert.doesNotMatch(stalePage, /Availability: unavailable/);
  assert.doesNotMatch(restartTag(stalePage), /disabled/);
  assert.equal(model.currentCapability(fresh, now + 29_000).availability.status, 'unknown');
  assert.equal(model.currentCapability(fresh, now + 28_999).availability.status, 'available');
  assert.equal(model.currentCapability(stale).access.status, 'unknown');
});

test('expiry of FM evidence does not change lifecycle policy or server restrictions', () => {
  const staleFm = descriptor('fm.read', { availability: { status: 'unavailable' }, availabilityEvidence: {
    observedAt: '2000-01-01T00:00:00Z', validUntil: '2000-01-01T00:00:30Z',
  } });
  const state = load({ policy: { status: 'denied', reason: 'Policy remains authoritative' } });
  state.data[0] = staleFm;
  const html = renderPage(state, { actionsSupported: false });
  assert.match(html, /Availability: assessment unknown/);
  assert.match(restartTag(html), /disabled/);
  assert.match(html, /Policy remains authoritative/);
});
