import { randomUUID } from "node:crypto";
import { env } from "@/server/config/env";

/**
 * Logs structurés en JSON, exploitables par n'importe quel collecteur.
 * Aucun secret n'est jamais passé à ces fonctions (mots de passe, cookies).
 */

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, string | number | boolean | null | undefined>;

function emit(level: Level, message: string, fields: LogFields = {}) {
  let threshold = ORDER.info;
  try {
    threshold = ORDER[env().LOG_LEVEL];
  } catch {
    // Configuration invalide : on log quand même, c'est justement le moment.
  }
  if (ORDER[level] < threshold) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...fields,
  });

  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit("debug", message, fields),
  info: (message: string, fields?: LogFields) => emit("info", message, fields),
  warn: (message: string, fields?: LogFields) => emit("warn", message, fields),
  error: (message: string, fields?: LogFields) => emit("error", message, fields),
};

export function newRequestId(): string {
  return randomUUID().slice(0, 8);
}

export function errorFields(error: unknown): LogFields {
  if (error instanceof Error) {
    return { error: error.message, errorName: error.name };
  }
  return { error: String(error) };
}
