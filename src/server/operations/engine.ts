import { recordAudit, type AuditKind } from "@/server/audit/service";
import { errorFields, logger } from "@/server/log";
import { ApiFailure, isApiFailure } from "@/server/http/errors";
import { isRconError } from "@/server/rcon/errors";
import { isAgentError } from "@/server/agents/errors";
import { createOperation, finishOperation, setOperationStep } from "@/server/operations/store";
import type { ServerOperationDto, ServerOperationStep, ServerOperationType } from "@/lib/api-types";

/**
 * Long operations — start, stop, restart, and soon backup, restore and mod
 * changes — run through this one engine, under one process-wide lock: a
 * restore must never interleave with a restart or a mod install, whichever
 * screen each was launched from.
 *
 * An operation outlives the HTTP request that asked for it. The route answers
 * 202 with the operation row, the work runs in the background, and the
 * interface follows its steps through polling. The row records the outcome;
 * one left `running` by a process that died is marked `interrupted` at the
 * next startup (see `markInterruptedOperations`).
 */

/** Who asked, for the audit log and the operation row. */
export type OperationActor = {
  username: string;
  role: string;
  ip: string | null;
  requestId: string;
};

export type Recipe<Prepared> = {
  type: ServerOperationType;
  auditKind: AuditKind;
  /** Whether the operator overrode a safety check; shown in the history. */
  forced: boolean;
  /**
   * Checks run under the lock, before the operation exists, while the HTTP
   * request still waits: a refusal reaches the operator as an HTTP error
   * rather than as a failed operation a second later. Throw to refuse, after
   * calling `deny` so the refusal is audited.
   */
  prepare: (deny: (code: string, extra?: string) => void) => Promise<Prepared>;
  /** The work itself, in the background. `step` updates the progress shown. */
  run: (prepared: Prepared, step: (step: ServerOperationStep) => void) => Promise<void>;
  /** Called whatever the outcome, once the lock is released: cache resets. */
  onSettled?: () => void;
  /** What a successful run produced, for the audit log. */
  describe?: () => string | null;
};

type Running = { operation: ServerOperationDto; done: Promise<void> };

type EngineState = {
  /** `reserved` covers `prepare`, before the operation row exists. */
  current: Running | "reserved" | null;
};

const globalRef = globalThis as typeof globalThis & { __factorioOperations?: EngineState };
const engine: EngineState = (globalRef.__factorioOperations ??= { current: null });

/** Code recorded for a failure: the translation key the interface will show. */
export function errorCodeOf(error: unknown): string {
  if (isAgentError(error) || isRconError(error)) return error.key;
  if (isApiFailure(error)) return error.code;
  return "internal";
}

function detailOf(error: unknown): string {
  if (isAgentError(error) || isRconError(error)) return error.detail;
  return errorFields(error).error as string;
}

/**
 * Validates and launches an operation, then returns without waiting for it.
 */
export async function launch<Prepared>(
  recipe: Recipe<Prepared>,
  actor: OperationActor,
): Promise<ServerOperationDto> {
  const audit = (status: "success" | "denied" | "error", detail: string | null, durationMs?: number) =>
    recordAudit({
      username: actor.username,
      role: actor.role,
      kind: recipe.auditKind,
      action: recipe.type,
      status,
      detail,
      durationMs: durationMs ?? null,
      ip: actor.ip,
      requestId: actor.requestId,
    });
  const deny = (code: string, extra?: string) => audit("denied", extra ? `${code}: ${extra}` : code);

  // Checked and taken before the first `await`: Node runs this synchronously,
  // so two simultaneous requests cannot both pass.
  if (engine.current !== null) {
    deny("operation_in_progress");
    throw new ApiFailure(409, "operation_in_progress");
  }
  engine.current = "reserved";

  let prepared: Prepared;
  let operation: ServerOperationDto;
  try {
    prepared = await recipe.prepare(deny);
    operation = createOperation({
      type: recipe.type,
      username: actor.username,
      role: actor.role,
      forced: recipe.forced,
    });
  } catch (error) {
    engine.current = null;
    throw error;
  }

  logger.info("operation started", { id: operation.id, type: operation.type, forced: recipe.forced });
  const startedAt = Date.now();

  const done = recipe
    .run(prepared, (step) => setOperationStep(operation.id, step))
    .then(
      () => {
        finishOperation(operation.id, { status: "success" });
        const detail = [recipe.forced ? "forced" : null, recipe.describe?.() ?? null].filter(Boolean).join(" ");
        audit("success", detail || null, Date.now() - startedAt);
        logger.info("operation done", { id: operation.id, type: operation.type });
      },
      (error: unknown) => {
        const code = errorCodeOf(error);
        const detail = detailOf(error);
        finishOperation(operation.id, { status: "error", errorCode: code, detail });
        audit("error", `${code}: ${detail}`, Date.now() - startedAt);
        logger.warn("operation failed", { id: operation.id, type: operation.type, code, detail });
      },
    )
    .finally(() => {
      engine.current = null;
      recipe.onSettled?.();
    });
  engine.current = { operation, done };

  return operation;
}

/** The running operation, if any (tests await `done`). */
export function currentOperation(): Running | null {
  return typeof engine.current === "object" ? engine.current : null;
}
