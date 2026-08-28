import { can } from "@/lib/permissions";
import type { Session } from "@/server/auth/session";
import { DEFAULT_MAX_LENGTH, schemaOf, toDto } from "@/server/actions/definitions";
import { allActions, findAction } from "@/server/actions/registry";
import { isLuaTemplateError } from "@/lib/lua-template";
import { isKnownErrorCode } from "@/server/error-text";
import { ApiFailure } from "@/server/http/errors";
import { recordAudit } from "@/server/audit/service";
import { getRcon } from "@/server/rcon";
import { invalidateStatusCache } from "@/server/rcon/status";
import { isRconError } from "@/server/rcon/errors";
import type { ActionDto } from "@/lib/api-types";
import type { RconExecution } from "@/server/rcon/service";

/**
 * Actions this role can see (the catalogue is filtered server-side).
 *
 * `locale` only matters for commands from the operator's file, which carry
 * their own text: built-in action text is still resolved on the interface side.
 */
export function catalogFor(session: Session, locale = "en"): ActionDto[] {
  return allActions()
    .filter((action) => can(session.role, action.permission))
    .map((action) => toDto(action, locale));
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
    // Only the first problem is reported: the interface shows a single error
    // line. `message` carries a key (see `fieldSchema`), except for zod's
    // structural rejections, which fall back to a generic code.
    const issue = parsed.error.issues[0];
    const name = String(issue.path[0] ?? "");
    const field = definition.fields.find((candidate) => candidate.name === name);
    const code = isKnownErrorCode(issue.message) ? issue.message : "invalid_arguments";

    throw ApiFailure.badRequest(code, {
      field: name,
      // Each bound only makes sense for the error that puts it at fault.
      ...(code === "validation_too_long"
        ? { max: field?.maxLength ?? DEFAULT_MAX_LENGTH }
        : {}),
      ...(code === "validation_min" && field?.min !== undefined ? { min: field.min } : {}),
      ...(code === "validation_max" && field?.max !== undefined ? { max: field.max } : {}),
      ...(code === "validation_enum" ? { options: (field?.options ?? []).join(", ") } : {}),
    });
  }

  let command: string;
  try {
    command = definition.build(parsed.data as Record<string, string>);
  } catch (error) {
    // Second barrier: `lua-template` refuses what validation might have let
    // through. That is invalid input, not a panel failure.
    const code = isLuaTemplateError(error) ? error.code : "invalid_arguments";
    throw ApiFailure.badRequest(isKnownErrorCode(code) ? code : "invalid_arguments", {
      field: definition.fields[0]?.name ?? definition.id,
    });
  }

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
      detail: isRconError(error) ? `${error.code}: ${error.detail}` : String(error),
      ip: ctx.ip,
      requestId: ctx.requestId,
    });
    throw error;
  }
}
