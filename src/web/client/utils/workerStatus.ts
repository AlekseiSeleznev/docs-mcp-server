/**
 * Shared mapping from worker health to a status-dot variant, used by both the
 * sidebar footer and the Overview system-health card so the two never drift
 * apart (they previously disagreed — embedded read green in one, blue in the
 * other).
 *
 * Semantics:
 * - **embedded** — the worker runs in-process; there is no separate process to
 *   health-check, so it reads as an informational `run` (blue), never green,
 *   and does not pulse (it is not continuously working).
 * - **remote + connected** — a real, health-checked link is up → `ok` (green),
 *   pulsing to signal the live connection.
 * - **remote + disconnected** — the link is down → `err` (red).
 * - **unknown** (health still loading) → `idle` (grey).
 */

import type { SystemHealth } from "../../../services/systemHealthRouter";
import type { StatusVariant } from "../components/StatusDot";

export interface WorkerStatus {
  variant: StatusVariant;
  pulse: boolean;
}

/**
 * Derives the {@link StatusVariant} and pulse state for a worker.
 *
 * @param worker - The worker slice of system health, or `undefined` while it loads.
 */
export function workerStatus(worker: SystemHealth["worker"] | undefined): WorkerStatus {
  if (!worker) return { variant: "idle", pulse: false };
  if (worker.mode === "remote") {
    return worker.connected
      ? { variant: "ok", pulse: true }
      : { variant: "err", pulse: false };
  }
  return { variant: "run", pulse: false };
}
