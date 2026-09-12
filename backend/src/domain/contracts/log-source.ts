import { InstanceRef, ServiceRef, TargetId } from './target';

/** Provider identity is additive; consumers need not interpret provider attributes. */
export interface LogOrigin {
  instance: InstanceRef;
  component: string;
  attributes: Readonly<Record<string, string>>;
}

export class LogSourceError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'LogSourceError'; }
}

export type LogEventType = 'radio_connect' | 'radio_disconnect' | 'ue_attach' | 'ue_detach'
  | 'ue_register' | 'ue_deregister' | 'pdu_session_up' | 'pdu_session_down'
  | 'bearer_setup_failure' | 'subscriber_auth_rejected';

export interface LogEntry {
  timestamp: string;
  service: string;
  message: string;
  origin?: LogOrigin;
  event?: { type: LogEventType; imsi?: string; radioIp?: string; apn?: string };
}

export interface LogReadRequest { services: readonly ServiceRef[]; limit?: number }
export interface LogTextRange { type: 'lines' | 'date' | 'all'; lines?: number; from?: string; to?: string }
export interface LogSubscription { cancel(): void }
export interface LogObserver {
  onEntry(entry: LogEntry): void;
  onError?(error: Error): void;
  onEnd?(): void;
}

/** Read-only NF logs. No file paths, command arguments or process handles cross this port. */
export interface ILogSource {
  readonly targetId: TargetId;
  /** Legacy local reads omit failed services, merge chronologically and apply a global limit. */
  readRecent(request: LogReadRequest): Promise<LogEntry[]>;
  /** Bounded recent candidates for the NMS Major Events view; classification remains separate. */
  readMajorEventCandidates(request: { services: readonly ServiceRef[]; maxPerService: number }): Promise<LogEntry[]>;
  /** Raw text for existing download range semantics, distinct from parsed recent entries. */
  readText(service: ServiceRef, range: LogTextRange): Promise<string>;
  /** Setup failures throw; asynchronous source errors go to onError. Cancellation is idempotent. */
  follow(service: ServiceRef, observer: LogObserver): LogSubscription;
}
