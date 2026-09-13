import { useCallback, useEffect, useRef, useState } from 'react';
import { getNfDiagnostics } from '../api/diagnostics';
import type { NfDiagnosticsSnapshot } from '../types/nf-diagnostics';

export function useNfDiagnostics() {
  const [data, setData] = useState<NfDiagnosticsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    try {
      const result = await getNfDiagnostics();
      if (current === generation.current) { setData(result); setError(null); }
    } catch {
      if (current === generation.current) { setData(null); setError('NF diagnostics could not be retrieved. Retry the request.'); }
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(refresh, 30000);
    return () => { clearInterval(timer); generation.current++; };
  }, [refresh]);
  return { data, error, refresh };
}
