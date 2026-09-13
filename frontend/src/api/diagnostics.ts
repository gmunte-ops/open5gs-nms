import axios from 'axios';
import type { NfDiagnosticsSnapshot } from '../types/nf-diagnostics';

export async function getNfDiagnostics(): Promise<NfDiagnosticsSnapshot> {
  const response = await axios.get<NfDiagnosticsSnapshot>(`${import.meta.env.VITE_API_URL || ''}/api/diagnostics`,
    { withCredentials: true, timeout: 30000 });
  return response.data;
}
