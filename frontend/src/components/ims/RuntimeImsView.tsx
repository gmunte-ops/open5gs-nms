import { useState } from 'react';
import type { ServiceStatus } from '../../types';
import { IMS_FUNCTIONS, imsServiceView } from '../dashboard/ims-service-view';
import { servicePresentationLabel } from '../services/service-target-view';

export function selectImsServices(services: readonly ServiceStatus[]): ServiceStatus[] {
  const owners = new Set(services.filter(service => IMS_FUNCTIONS.some(name => name === service.name))
    .map(service => service.target?.targetId));
  const identities = [...IMS_FUNCTIONS, 'pyhss', 'rtpengine', 'dns', 'mysql'];
  return services.filter(service => owners.has(service.target?.targetId) && identities.includes(service.name));
}

export type ImsRuntimeTab = 'overview' | 'live' | 'configs';

export function RuntimeImsTab({ services, tab }: { services: ServiceStatus[]; tab: ImsRuntimeTab }) {
  if (tab === 'configs') return (
    <section className="nms-card space-y-2">
      <h2 className="font-semibold">Config Files — unavailable</h2>
      <p className="text-sm text-nms-text-dim">Configuration inventory is not supported by this IMS service provider. Configuration remains managed by the target deployment.</p>
      <p className="text-sm text-nms-text-dim">Local NMS host files are not configuration files for this target.</p>
    </section>
  );
  const health = imsServiceView(services, null);
  return (
    <>
      <section className="nms-card space-y-3">
        <h2 className="font-semibold">{tab === 'live' ? 'Live Service Status' : 'Service Status'} · {health.label}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {services.map(service => (
            <div key={`${service.target?.targetId ?? 'primary'}/${service.name}`} className="rounded border border-nms-border p-3 min-w-0">
              <div className="flex justify-between gap-2">
                <span className="font-semibold">{service.displayName || service.name.toUpperCase()}</span>
                <span className={service.active ? 'text-green-400' : 'text-amber-400'}>{service.state}</span>
              </div>
              <p className="text-xs text-nms-text-dim mt-1">{servicePresentationLabel(service)}</p>
              {service.error && <p className="text-xs text-amber-400 mt-1">{service.error}</p>}
              <p className="text-xs text-nms-text-dim mt-1">Observed: {service.observation?.observedAt || service.lastChecked || 'Unknown'}</p>
              {tab === 'live' && <p className="text-xs text-nms-text-dim mt-1">Restarts: {service.restartCount ?? 'Unavailable'}</p>}
            </div>
          ))}
        </div>
      </section>
      <section className="nms-card space-y-2">
        <h2 className="font-semibold">IMS measurements unavailable</h2>
        <p className="text-sm text-nms-text-dim">Service observations do not provide registrations, calls, IPsec sessions, subscriber counts or DNS validation for this target.</p>
        <p className="text-sm text-nms-text-dim">This target is observed read-only. Lifecycle operations, configuration editing and subscriber synchronization are not available here.</p>
      </section>
    </>
  );
}

export function RuntimeImsView({ services, refresh }: { services: ServiceStatus[]; refresh: () => void }) {
  const [tab, setTab] = useState<ImsRuntimeTab>('overview');
  return (
    <div className="p-6 space-y-6">
      <div className="flex justify-between items-center gap-3 flex-wrap">
        <div><h1 className="text-2xl font-semibold font-display">IMS / VoLTE</h1>
          <p className="text-sm text-nms-text-dim mt-1">IMS runtime services · read-only observations</p></div>
        <button className="nms-btn-ghost" onClick={refresh}>Refresh</button>
      </div>
      <div className="flex gap-2 flex-wrap" role="tablist" aria-label="IMS views">
        {(['overview', 'live', 'configs'] as const).map(value => (
          <button key={value} role="tab" aria-selected={tab === value} className={tab === value ? 'nms-btn' : 'nms-btn-ghost'} onClick={() => setTab(value)}>
            {{ overview: 'Overview', live: 'Live Status', configs: 'Config Files' }[value]}
          </button>
        ))}
      </div>
      <RuntimeImsTab services={services} tab={tab} />
    </div>
  );
}
