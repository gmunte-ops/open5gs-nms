import type { RequestHandler } from 'express';
import type { Open5gsRuntime } from '../../../config/runtime-policy';

// These feature families need a cluster adapter before they can operate on core
// data. Include reads: local files/counters must not masquerade as cluster data.
const CORE_FEATURES = new Set([
  'config', 'sepp', 'backup', 'dns-migration', 'plmn-migration', 'auto-config',
  'suci', 'apn-profiles', 'tun-interfaces', 'interface-status', 'radio-block',
  'gnb-block', 'ue-block', 'pcap', 'validation', 'swu-emulator', 'logs',
]);

// These modules remain on the NMS host, but their setup/removal workflows also
// change core config or binaries. Block the whole mutation before partial work.
const MIXED_MODULES = new Set(['ims', 'sms', 'vowifi', 'modules', 'syslog']);

export function unsupportedRuntimeFeature(runtime: Open5gsRuntime, method: string, requestPath: string): string | undefined {
  if (runtime === 'local') return undefined;
  // Express routing is case-insensitive by default. Normalize encoded segments
  // too, so an alternate spelling cannot evade a guard ahead of the routers.
  let path: string;
  try { path = decodeURIComponent(requestPath).toLowerCase().replace(/\/+$/, ''); }
  catch { return 'invalid-path'; }
  const feature = path.split('/')[1];
  const read = method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
  if (path === '/config/topology/graph' && read) return undefined;
  if (CORE_FEATURES.has(feature)) return feature;
  if (MIXED_MODULES.has(feature) && !read) return feature;
  // Subscriber writes can install host routes, and automatic assignment reads
  // local SMF/UPF pools. Keep ordinary MongoDB list/detail/export reads available.
  if (feature === 'subscribers' && (!read || /\/(framed-routes|ip-assignments|auto-assign-ips)(\/|$)/.test(path))) return feature;
  // SNMP's generated agent has its own systemd/loopback probes.
  if (feature === 'snmp' && (!read || path === '/snmp/stats')) return feature;
  return undefined;
}

/** Mounted after authentication and before any feature router. */
export function createRuntimeMiddleware(runtime: Open5gsRuntime): RequestHandler {
  return (req, res, next) => {
    const feature = unsupportedRuntimeFeature(runtime, req.method, req.path);
    if (!feature) { next(); return; }
    res.status(501).json({
      success: false,
      code: 'RUNTIME_UNSUPPORTED',
      runtime,
      feature,
      error: `${feature} is not supported in Kubernetes mode yet. Manage core configuration and lifecycle through Kubernetes/Helm.`,
    });
  };
}
