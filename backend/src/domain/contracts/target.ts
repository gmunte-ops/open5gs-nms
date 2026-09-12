/** Explicit configuration identity, independent of platform and NMS host. */
export type TargetId = string;

export interface ServiceRef {
  readonly targetId: TargetId;
  /** Logical NF/service name, never a systemd unit, container name or Pod name. */
  readonly nf: string;
}

export interface InstanceRef {
  readonly service: ServiceRef;
  /** Opaque identity for one instance lifetime; replacement gets a new identity. */
  readonly id: string;
}

export interface ResourceRef {
  readonly targetId: TargetId;
  /** Opaque provider resource identity, not an instruction or access credential. */
  readonly id: string;
}

/** A capability or observation can describe a whole target or a specific subject. */
export type ResourceScope =
  | { readonly kind: 'target'; readonly targetId: TargetId }
  | { readonly kind: 'service'; readonly service: ServiceRef }
  | { readonly kind: 'instance'; readonly instance: InstanceRef }
  | { readonly kind: 'resource'; readonly resource: ResourceRef };
