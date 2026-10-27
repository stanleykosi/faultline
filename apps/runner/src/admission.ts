import {demand} from '../../../packages/core/src/errors.js';
import {executionScope, type RunnerExecutionScope} from '../../../packages/core/src/experiments/protocol.js';

export interface RunnerAdmissionReservation {
  readonly token: symbol;
  readonly scope: Readonly<RunnerExecutionScope>;
}

/** In-process capacity only. Durable nonce replay is enforced by the runner ledger. */
export class RunnerAdmissionController {
  readonly #byNonce = new Map<string, RunnerAdmissionReservation>();
  readonly #owned = new Set<RunnerAdmissionReservation>();

  get size(): number { return this.#owned.size; }

  get(nonce: string): Readonly<RunnerExecutionScope> | null {
    return this.#byNonce.get(nonce)?.scope ?? null;
  }

  /** Reserve before any awaited resource acquisition or execution registration. */
  reserve(value: unknown): RunnerAdmissionReservation {
    const validated = executionScope(value);
    const scope = Object.freeze({
      nonce: validated.nonce,
      job_id: validated.job_id,
      lease_id: validated.lease_id,
      workspace_id: validated.workspace_id,
      case_id: validated.case_id,
      generation: validated.generation,
    });
    executionScope(scope);
    demand(!this.#byNonce.has(scope.nonce), 'RUNNER_TASK_REPLAY', 'Fixture execution nonce is already reserved.', 403);
    demand(this.#owned.size < 2 && ![...this.#owned].some(item => item.scope.workspace_id === scope.workspace_id),
      'RUNNER_BUSY', 'Private runner capacity is bounded.', 429);
    const reservation = Object.freeze({token: Symbol('runner-admission'), scope});
    this.#byNonce.set(scope.nonce, reservation);
    this.#owned.add(reservation);
    return reservation;
  }

  /** Only the exact controller-owned token may release its immutable scope once. */
  release(reservation: RunnerAdmissionReservation): boolean {
    if (!this.#owned.has(reservation)) return false;
    this.#owned.delete(reservation);
    this.#byNonce.delete(reservation.scope.nonce);
    return true;
  }
}
