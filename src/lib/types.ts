/** Nombre de lignes conservées dans la console : au-delà, le DOM devient lourd. */
export const MAX_LOG_ENTRIES = 500;

type LogBase = {
  id: number;
  at: string;
  command: string;
  durationMs: number | null;
};

/**
 * Union discriminée : une entrée est soit un succès avec sortie, soit une
 * erreur avec message — jamais les deux, jamais aucun des deux.
 */
export type LogEntry =
  | (LogBase & { kind: "success"; output: string })
  | (LogBase & { kind: "error"; error: string });

/** Entrée avant attribution de l'identifiant et de l'horodatage. */
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
