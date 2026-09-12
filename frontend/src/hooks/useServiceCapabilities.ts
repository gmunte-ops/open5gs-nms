import { useEffect, useState } from 'react';
import { serviceApi } from '../api';
import { loadCapabilities, type CapabilityLoad } from '../components/services/capability-view';

export function useServiceCapabilities(names: readonly string[]) {
  const [services, setServices] = useState<Record<string, CapabilityLoad>>({});
  const [target, setTarget] = useState<CapabilityLoad>({ status: 'loading' });
  const [revision, setRevision] = useState(0);
  const [expiryTick, setExpiryTick] = useState(0);
  const key = JSON.stringify([...new Set(names)].sort());
  useEffect(() => {
    const now = Date.now();
    const expiries = [target, ...Object.values(services)].flatMap(load => load.data ?? [])
      .filter(item => item.id === 'fm.read')
      .map(item => Date.parse(item.availabilityEvidence?.validUntil ?? ''))
      .filter(expires => Number.isFinite(expires) && expires > now);
    if (!expiries.length) return;
    // Render expiry only. The network-fetch effect does not depend on this tick.
    const timer = setTimeout(() => setExpiryTick(tick => tick + 1), Math.min(...expiries) - now + 1);
    return () => clearTimeout(timer);
  }, [services, target, expiryTick]);
  useEffect(() => {
    let current = true;
    const subjects: string[] = JSON.parse(key);
    // Keep previous restrictions while refreshing; failed refreshes do not erase them.
    const retain = (previous: CapabilityLoad | undefined, next: CapabilityLoad): CapabilityLoad =>
      next.status === 'unavailable' && previous?.data ? { ...next, data: previous.data } : next;
    void loadCapabilities(serviceApi.getCapabilities).then(result => { if (current) setTarget(previous => retain(previous, result)); });
    for (const name of subjects) {
      void loadCapabilities(serviceApi.getCapabilities, name).then(result => {
        if (current) setServices(previous => ({ ...previous, [name]: retain(previous[name], result) }));
      });
    }
    return () => { current = false; };
  }, [key, revision]);
  return { services, target, refresh: () => setRevision(value => value + 1) };
}
