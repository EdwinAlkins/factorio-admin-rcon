import { can } from "@/lib/permissions";
import type { Session } from "@/server/auth/session";
import {
  ACTIONS,
  DEFAULT_MAX_LENGTH,
  findAction,
  schemaOf,
  toDto,
} from "@/server/actions/definitions";
import { isKnownErrorCode } from "@/server/error-text";
import { ApiFailure } from "@/server/http/errors";
import { recordAudit } from "@/server/audit/service";
import { getRcon } from "@/server/rcon";
import { invalidateStatusCache } from "@/server/rcon/status";
import { RconError } from "@/server/rcon/errors";
import type { ActionDto } from "@/lib/api-types";
import type { RconExecution } from "@/server/rcon/service";

/** Actions visibles par ce rôle (le catalogue est filtré côté serveur). */
export function catalogFor(session: Session): ActionDto[] {
  return ACTIONS.filter((action) => can(session.role, action.permission)).map(toDto);
}

type ExecuteContext = {
  session: Session;
  ip: string | null;
  requestId: string;
};

export async function executeAction(
  ctx: ExecuteContext,
  actionId: string,
  values: unknown,
): Promise<RconExecution> {
  const definition = findAction(actionId);

  if (!definition) {
    throw ApiFailure.notFound("unknown_action", { action: actionId });
  }

  if (!can(ctx.session.role, definition.permission)) {
    recordAudit({
      username: ctx.session.username,
      role: ctx.session.role,
      kind: "action",
      action: definition.id,
      status: "denied",
      detail: `required permission: ${definition.permission}`,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw ApiFailure.forbidden();
  }

  const parsed = schemaOf(definition).safeParse(values ?? {});
  if (!parsed.success) {
    // On ne remonte que le premier problème : l'interface n'affiche qu'une
    // ligne d'erreur. `message` porte une clé (cf. `fieldSchema`), sauf pour
    // les rejets structurels de zod, qui retombent sur un code générique.
    const issue = parsed.error.issues[0];
    const name = String(issue.path[0] ?? "");
    const field = definition.fields.find((candidate) => candidate.name === name);
    const code = isKnownErrorCode(issue.message) ? issue.message : "invalid_arguments";

    throw ApiFailure.badRequest(code, {
      field: name,
      // La longueur maximale n'a de sens que pour le dépassement de taille.
      ...(code === "validation_too_long"
        ? { max: field?.maxLength ?? DEFAULT_MAX_LENGTH }
        : {}),
    });
  }

  const command = definition.build(parsed.data as Record<string, string>);

  try {
    const execution = await getRcon().execute(command);
    invalidateStatusCache();

    recordAudit({
      username: ctx.session.username,
      role: ctx.session.role,
      kind: "action",
      action: definition.id,
      command,
      status: "success",
      durationMs: execution.durationMs,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });

    return execution;
  } catch (error) {
    recordAudit({
      username: ctx.session.username,
      role: ctx.session.role,
      kind: "action",
      action: definition.id,
      command,
      status: "error",
      detail: error instanceof RconError ? `${error.code}: ${error.detail}` : String(error),
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw error;
  }
}
