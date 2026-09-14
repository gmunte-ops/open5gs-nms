import { useCallback, useEffect, useState } from 'react';
import { serviceApi } from '../api';
import type { ServiceStatus } from '../types';

/** Resolve the target before mounting any legacy IMS data source. */
export function useImsServiceInventory() {
  const [services, setServices] = useState<ServiceStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const rows = await serviceApi.getAll();
        if (!Array.isArray(rows) || rows.some(row => !row || typeof row.name !== 'string')) throw new Error('Invalid inventory');
        if (!cancelled) { setServices(rows); setError(null); }
      } catch {
        if (!cancelled) setError('Service inventory unavailable. The IMS target cannot currently be assessed.');
      } finally {
        if (!cancelled) timer = setTimeout(read, 10000);
      }
    };
    void read();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [revision]);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  return { services, error, refresh };
}
