import { can } from "@/lib/permissions";
import type { Session } from "@/server/auth/session";
import { ACTIONS, findAction, schemaOf, toDto } from "@/server/actions/definitions";
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
    throw ApiFailure.notFound(`Action inconnue : ${actionId}`, "unknown_action");
  }

  if (!can(ctx.session.role, definition.permission)) {
    recordAudit({
      username: ctx.session.username,
      role: ctx.session.role,
      kind: "action",
      action: definition.id,
      status: "denied",
      detail: `permission requise: ${definition.permission}`,
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw ApiFailure.forbidden();
  }

  const parsed = schemaOf(definition).safeParse(values ?? {});
  if (!parsed.success) {
    throw ApiFailure.badRequest(
      parsed.error.issues.map((issue) => issue.message).join(" "),
      "invalid_arguments",
    );
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
