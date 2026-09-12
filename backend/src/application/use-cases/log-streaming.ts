import { ILogSource, LogObserver, LogTextRange } from '../../domain/contracts';
export type { LogEntry } from '../../domain/contracts';
export interface LogStreamOptions { services: string[]; maxLines?: number }

/** Compatibility facade for existing NMS names and payloads; source selection is injected. */
export class LogStreamingUseCase {
  constructor(private readonly source: ILogSource) {}

  getRecentLogs(services: string[], limit = 100) {
    return this.source.readRecent({ services: services.map(nf => ({ targetId: this.source.targetId, nf })), limit });
  }

  getMajorEventLogs(services: string[], maxPerService: number) {
    return this.source.readMajorEventCandidates({ services: services.map(nf => ({ targetId: this.source.targetId, nf })), maxPerService });
  }

  follow(service: string, observer: LogObserver) {
    return this.source.follow({ targetId: this.source.targetId, nf: service }, observer);
  }

  readText(service: string, range: LogTextRange) {
    return this.source.readText({ targetId: this.source.targetId, nf: service }, range);
  }
}
