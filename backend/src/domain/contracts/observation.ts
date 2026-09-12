import type { ResourceScope } from './target';

export interface SourceRef {
  /** Provider identity (not necessarily the target platform), e.g. a metrics provider. */
  readonly provider: string;
  readonly scope: ResourceScope;
  readonly resourceVersion?: string;
}

export interface ObservationIssue {
  readonly code: string;
  readonly reason: string;
  readonly source?: SourceRef;
}

interface ObservationMetadata {
  /** ISO 8601 timestamp for collection/attempt time, not workload uptime. */
  readonly observedAt: string;
  /** Explicit provenance; may be empty if discovery failed before resolving a source. */
  readonly sources: readonly SourceRef[];
}

/**
 * Successful empty data is distinct from unavailable/unsupported/not-found.
 * Partial results must identify at least one issue. Unsuccessful observations
 * cannot carry data; future consumers must narrow by status before reading it.
 * These are JSON contracts, not runtime validators or collection implementations.
 */
export type Observation<T> = ObservationMetadata & (
  | { readonly status: 'ok'; readonly data: T; readonly issues?: never; readonly reason?: never }
  | { readonly status: 'partial'; readonly data: T;
      readonly issues: readonly [ObservationIssue, ...ObservationIssue[]]; readonly reason?: never }
  | { readonly status: 'unavailable' | 'unsupported' | 'not-found';
      readonly reason: string; readonly data?: never; readonly issues?: never }
);
