export interface HardenedSandboxProviderMetadata {
  readonly adapter_id: string;
  readonly adapter_version: string;
  readonly provider_id: string;
  readonly provider_version: string;
  /** Non-secret digest of the provider scope/configuration that determines isolation. */
  readonly configuration_digest: string;
  readonly isolation: 'hardened_vm';
  readonly cleanup_verification: boolean;
  readonly crash_reconciliation: boolean;
}

export interface HardenedSandboxExecutionInput {
  readonly executionKey: string;
  readonly taskJson: string;
  readonly taskSha256: string;
  readonly programBytes: Uint8Array;
  readonly programSha256: string;
  readonly timeoutSeconds: number;
  readonly signal?: AbortSignal;
}

export interface HardenedSandboxExecution {
  readonly executionId: string;
  readonly taskSha256: string;
  readonly programSha256: string;
  readonly resultSha256: string;
  readonly result: unknown;
}

export type HardenedSandboxInspection =
  | {readonly status: 'completed'; readonly cleanup_verified: boolean; readonly execution: HardenedSandboxExecution}
  | {readonly status: 'unknown' | 'running' | 'destroyed'; readonly cleanup_verified: boolean; readonly execution?: never};

export interface HardenedSandboxCancellation {
  readonly status: 'cancelled' | 'destroyed' | 'unknown';
  readonly cleanup_verified: boolean;
}

/**
 * Provider-neutral boundary for one finite execution in a disposable hardened
 * VM. Provider credentials, resource identifiers and checkpoint configuration
 * belong to the implementation and never cross this interface.
 */
export interface HardenedSandboxProvider {
  readonly metadata: HardenedSandboxProviderMetadata;
  readonly configured: boolean;
  readonly reason: string | null;
  /**
   * Idempotent for one executionKey and its task/program hashes. Reusing a key
   * for different immutable inputs must be rejected as a conflict.
   */
  execute(input: HardenedSandboxExecutionInput): Promise<HardenedSandboxExecution>;
  inspect(executionKey: string): Promise<HardenedSandboxInspection>;
  cancel(executionKey: string): Promise<HardenedSandboxCancellation>;
}
