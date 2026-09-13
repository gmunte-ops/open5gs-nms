import pino from 'pino';
import { IHostExecutor } from '../../domain/interfaces/host-executor';
import { IConfigRepository } from '../../domain/interfaces/config-repository';
import { DiagnosticsObservation } from '../../domain/contracts';

/** Strict Step 9 reads; legacy transport and fallback behavior remain unchanged. */
export class LocalDiagnosticsHttp {
  constructor(private readonly hostExecutor: IHostExecutor, private readonly configRepo: IConfigRepository, private readonly logger: pino.Logger) {}
  /** Strict diagnostics read. Legacy methods below retain their compatibility behavior. */
  async observe<T>(nf: 'amf' | 'mme' | 'smf', endpoint: string,
    decode: (items: unknown) => T): Promise<DiagnosticsObservation<T>> {
    const metadata = { targetId: 'local', requestedServices: [{ targetId: 'local', nf }], observedAt: new Date().toISOString(), sources: [{
      provider: `local-open5gs-http:${endpoint}`,
      scope: { kind: 'service' as const, service: { targetId: 'local', nf } },
    }] };
    try {
      const base = await this.getApiBase(nf);
      const result = await this.hostExecutor.executeCommand('curl',
        ['-s', '--connect-timeout', '3', '--max-time', '5', '-w', '\n%{http_code}', `${base}/${endpoint}?`], 8000);
      if (result.exitCode !== 0) return { ...metadata, status: 'unavailable', reason: 'NF diagnostics request failed or timed out' };
      const boundary = result.stdout.lastIndexOf('\n');
      const code = Number(result.stdout.slice(boundary + 1));
      if (code === 404 || code === 405 || code === 501 || (code === 400 && result.stdout.slice(0, boundary).trim() === 'Bad Request' && ['gnb-info', 'enb-info', 'ue-info', 'pdu-info'].includes(endpoint))) return { ...metadata, status: 'unsupported', reason: `NF diagnostics endpoint ${endpoint} returned HTTP ${code}` };
      if (code < 200 || code >= 300 || !code) return { ...metadata, status: 'unavailable', reason: `NF diagnostics HTTP request failed (${code || 'unknown status'})` };
      try {
        const body = JSON.parse(result.stdout.slice(0, boundary));
        const data = decode(body?.items);
        return { ...metadata, status: 'ok', data };
      } catch {
        return { ...metadata, status: 'error', reason: `Malformed ${endpoint} diagnostics response` };
      }
    } catch {
      return { ...metadata, status: 'unavailable', reason: 'Unable to access local NF diagnostics' };
    }
  }

  private async getApiBase(nf: 'amf' | 'mme' | 'smf' | 'upf'): Promise<string> {
    const defaults: Record<string, string> = {
      amf: 'http://127.0.0.5:9090',
      mme: 'http://127.0.0.2:9090',
      smf: 'http://127.0.0.4:9090',
      upf: 'http://127.0.0.7:9090',
    };

    try {
      let raw: any;
      if (nf === 'amf') {
        const cfg = await this.configRepo.loadAmf();
        raw = (cfg as any).rawYaml?.amf;
      } else if (nf === 'smf') {
        const cfg = await this.configRepo.loadSmf();
        raw = (cfg as any).rawYaml?.smf;
      } else if (nf === 'upf') {
        const cfg = await (this.configRepo as any).loadGeneric('upf');
        raw = (cfg as any).rawYaml?.upf;
      } else {
        // MME
        const cfg = await (this.configRepo as any).loadMme();
        raw = (cfg as any).rawYaml?.mme;
      }

      const server = raw?.metrics?.server;
      const entry = Array.isArray(server) ? server[0] : server;
      if (entry?.address) {
        const port = entry.port || 9090;
        const base = `http://${entry.address}:${port}`;
        this.logger.debug({ nf, base }, 'Resolved Open5GS API base from config');
        return base;
      }
    } catch (err) {
      this.logger.warn({ nf, err: String(err) }, 'Could not read metrics config, using default');
    }

    this.logger.debug({ nf, base: defaults[nf] }, 'Using default Open5GS API base');
    return defaults[nf];
  }

}
