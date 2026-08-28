/** Lines kept in the console: beyond this the DOM gets heavy. */
export const MAX_LOG_ENTRIES = 500;

type LogBase = {
  id: number;
  at: string;
  command: string;
  durationMs: number | null;
};

/**
 * Discriminated union: an entry is either a success with output or an error
 * with a message — never both, never neither.
 */
export type LogEntry =
  | (LogBase & { kind: "success"; output: string })
  | (LogBase & { kind: "error"; error: string });

/** An entry before it is given an id and a timestamp. */
export type NewLogEntry =
  | { kind: "success"; command: string; output: string; durationMs: number | null }
  | { kind: "error"; command: string; error: string; durationMs: number | null };

export type ServerStatus =
  | { state: "loading" }
  | { state: "error"; message: string }
  | {
      state: "ok";
      online: string[];
      count: number;
      version: string;
      target: string;
      cachedAt: number;
    };
