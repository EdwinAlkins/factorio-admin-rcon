/**
 * Analyse des sorties texte de Factorio. Isolé et testé : le format n'est pas
 * un contrat stable, ces fonctions sont le seul endroit à corriger s'il change.
 */

const HEADER = /^\s*(online\s+)?players?\b.*:\s*$/i;
const COUNT = /\((\d+)\)/;
const ONLINE_SUFFIX = /\s*\(online\)\s*$/i;
const BULLET = /^[-*•]\s*/;

export type PlayersOutput = {
  players: string[];
  /** Nombre annoncé par l'en-tête, s'il diffère des lignes réellement listées. */
  declared: number | null;
};

export function parsePlayers(output: string): PlayersOutput {
  const lines = output.split(/\r?\n/);
  let declared: number | null = null;
  const players: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (HEADER.test(trimmed)) {
      const match = COUNT.exec(trimmed);
      if (match) declared = Number(match[1]);
      continue;
    }

    const name = trimmed.replace(BULLET, "").replace(ONLINE_SUFFIX, "").trim();
    if (name) players.push(name);
  }

  return { players, declared };
}

/** Joueurs connectés, à partir de la sortie de `/players online`. */
export function parseOnlinePlayers(output: string): string[] {
  return parsePlayers(output).players;
}

export function parseVersion(output: string): string {
  return output.trim().split(/\r?\n/)[0]?.trim() ?? "";
}
