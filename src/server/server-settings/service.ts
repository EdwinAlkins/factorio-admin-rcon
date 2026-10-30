import { z } from "zod";
import { env } from "@/server/config/env";
import { AgentError, isAgentError } from "@/server/agents/errors";
import { ApiFailure } from "@/server/http/errors";
import { errorFields, logger } from "@/server/log";
import { recordAudit } from "@/server/audit/service";
import { agentStatus } from "@/server/control/client";
import { afterServerOperation } from "@/server/control/service";
import { checkPlayers, restartServer, saveGame, startServer, waitForRcon } from "@/server/control/steps";
import { dataServerSettings, dataServerSettingsRollback, dataServerSettingsUpdate } from "@/server/data/client";
import { currentOperation, errorCodeOf, launch, type OperationActor } from "@/server/operations/engine";
import { getOperation } from "@/server/operations/store";
import {
  ALLOW_COMMANDS,
  SECRET_MAX,
  SERVER_SECRETS,
  SERVER_SETTING_FIELDS,
  type ServerSettingField,
} from "@/lib/server-settings";
import type { ServerOperationDto, ServerSettingsDto, ServerSettingsResult } from "@/lib/api-types";

/**
 * server-settings.json: the game's listing, password, autosaves, pause.
 *
 * The file is the data agent's business — it alone mounts the config folder,
 * keeps every key it is not asked to change, and never answers a secret.
 * This module validates a change and, when asked, restarts the server so it
 * takes effect at once, putting the previous file back if the server does
 * not come back.
 */

/** The data agent serves the file: with both its features off, it is not there. */
export function requireServerSettings() {
  const config = env();
  if (!config.SAVES_ENABLED && !config.MODS_ENABLED) throw new AgentError("data_disabled");
}

const CONTROL = /[\u0000-\u001f\u007f]/;
const CONTROL_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;

function schemaFor(field: ServerSettingField): z.ZodType {
  const { min = 0, max = 0 } = field;
  switch (field.kind) {
    case "text":
      return z.string().max(max).refine((text) => !CONTROL.test(text));
    case "longText":
      return z.string().max(max).refine((text) => !CONTROL_BUT_NEWLINE.test(text));
    case "tags":
      return z.array(z.string().min(1).max(50).refine((tag) => !CONTROL.test(tag))).max(20);
    case "int":
      return z.number().int().min(min).max(max);
    case "bool":
      return z.boolean();
    case "visibility":
      return z
        .object({ public: z.boolean().optional(), lan: z.boolean().optional() })
        .strict()
        .refine((v) => v.public !== undefined || v.lan !== undefined);
    case "allowCommands":
      return z.enum(ALLOW_COMMANDS);
  }
}

const SecretChange = z.union([
  z.object({ set: z.string().min(1).max(SECRET_MAX).refine((text) => !CONTROL.test(text)) }).strict(),
  z.object({ clear: z.literal(true) }).strict(),
]);

export const ServerSettingsChange = z
  .object({
    settings: z
      .object(Object.fromEntries(SERVER_SETTING_FIELDS.map((field) => [field.key, schemaFor(field).optional()])))
      .strict()
      .default({}),
    secrets: z
      .object(Object.fromEntries(SERVER_SECRETS.map((key) => [key, SecretChange.optional()])))
      .strict()
      .default({}),
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    restart: z.boolean(),
    force: z.boolean().optional(),
  })
  .strict()
  .refine((change) => Object.keys(change.settings).length + Object.keys(change.secrets).length > 0);

export type ServerSettingsChangeInput = z.infer<typeof ServerSettingsChange>;

/** The keys a change touches, for the audit log: never a secret's value. */
export function describeChange(change: ServerSettingsChangeInput): string {
  const secrets = Object.entries(change.secrets).map(([key, value]) => `${key}:${"clear" in value! ? "cleared" : "set"}`);
  return [...Object.keys(change.settings), ...secrets].join(" ").slice(0, 500);
}

export async function readServerSettings(): Promise<Omit<ServerSettingsResult, "ok">> {
  const view = await dataServerSettings();
  const running = currentOperation();
  return { ...view, operation: running ? getOperation(running.operation.id) : null };
}

function patchOf(change: ServerSettingsChangeInput) {
  return { settings: change.settings, secrets: change.secrets, hash: change.hash } as Parameters<
    typeof dataServerSettingsUpdate
  >[0];
}

/**
 * Writes a change, for the server's next start. Factorio reads the file only
 * then and never writes it back, so this is safe while it runs. Refused while
 * an operation runs: it may be applying another change.
 */
export async function writeServerSettings(change: ServerSettingsChangeInput, actor: OperationActor): Promise<ServerSettingsDto> {
  const audit = (status: "success" | "denied" | "error", detail: string) =>
    recordAudit({
      username: actor.username,
      role: actor.role,
      kind: "server",
      action: "server_settings",
      status,
      detail,
      ip: actor.ip,
      requestId: actor.requestId,
    });
  const detail = describeChange(change);
  if (currentOperation()) {
    audit("denied", `operation_in_progress: ${detail}`);
    throw new ApiFailure(409, "operation_in_progress");
  }
  try {
    const { tx, ...view } = await dataServerSettingsUpdate(patchOf(change));
    audit("success", `${detail} (${tx})`);
    return view;
  } catch (error) {
    audit("error", `${errorCodeOf(error)}: ${detail}`);
    throw error;
  }
}

type Prepared = { running: boolean; rconOk: boolean };

/**
 * Writes a change and restarts the server for it to take effect:
 *
 *   write → save → restart → wait for RCON.
 *
 * Writing first means a refused value disconnects no one. If the server does
 * not come back, the previous file is put back and the server started again;
 * the operation ends in error either way. A stopped server is only written
 * to: it reads the file at its next start.
 */
export function requestServerSettingsApply(change: ServerSettingsChangeInput, actor: OperationActor): Promise<ServerOperationDto> {
  const force = change.force ?? false;
  let tx: string | null = null;
  return launch<Prepared>(
    {
      type: "server_settings_apply",
      auditKind: "server",
      forced: force,
      onSettled: afterServerOperation,
      describe: () => `${describeChange(change)}${tx ? ` (${tx})` : ""}`,

      async prepare(deny) {
        if (!env().CONTROL_ENABLED) {
          deny("control_disabled");
          throw new AgentError("control_disabled");
        }
        let current: ServerSettingsDto;
        try {
          current = await dataServerSettings();
        } catch (error) {
          if (isAgentError(error)) deny(error.key);
          throw error;
        }
        if (current.hash !== change.hash) {
          deny("settings_changed");
          throw new AgentError("settings_changed");
        }
        const container = await agentStatus();
        const running = container.state === "running";
        return { running, rconOk: running ? await checkPlayers(force, deny) : false };
      },

      async run({ running, rconOk }, step) {
        step("writing");
        ({ tx } = await dataServerSettingsUpdate(patchOf(change)));
        if (!running) return;

        try {
          if (rconOk) {
            step("saving");
            await saveGame();
          }
          step("stopping");
          await restartServer();
          step("waiting_rcon");
          await waitForRcon();
        } catch (error) {
          step("rolling_back");
          await rollBack(tx, error);
        }
      },
    },
    actor,
  );
}

/**
 * Puts the previous file back and brings the server up again, then throws:
 * the operation ends in error either way, and its code says whether the
 * rollback itself worked.
 */
async function rollBack(tx: string, cause: unknown): Promise<never> {
  const reason = errorCodeOf(cause);
  try {
    await dataServerSettingsRollback(tx);
    const container = await agentStatus().catch(() => null);
    if (container?.state === "running") await restartServer();
    else await startServer();
    await waitForRcon();
  } catch (error) {
    logger.error("server settings rollback failed", { tx, reason, ...errorFields(error) });
    throw new ApiFailure(500, "settings_rollback_failed", { reason });
  }
  throw new ApiFailure(502, "settings_rolled_back", { reason });
}
