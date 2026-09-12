export type Open5gsRuntime = 'local' | 'kubernetes';

export function parseOpen5gsRuntime(value: string | undefined): Open5gsRuntime {
  if (value === undefined || value === 'local') return 'local';
  if (value === 'kubernetes') return value;
  throw new Error(`Invalid OPEN5GS_RUNTIME '${value}': expected local or kubernetes`);
}

/** Phase one: cluster FM is available; host-dependent core features are not. */
export function runtimeCapabilities(runtime: Open5gsRuntime) {
  const local = runtime === 'local';
  return {
    runtime,
    serviceStatus: true,
    coreServiceActions: local,
    coreConfiguration: local,
    coreLogs: local,
    coreRecentLogs: true,
    coreDiagnostics: local,
    hostDataplane: local,
    managedPrometheusConfig: local,
    coreBinaryPatches: local,
  };
}
