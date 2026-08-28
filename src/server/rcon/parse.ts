/**
 * Parsing of Factorio's text output. Isolated and tested: the format is not a
 * stable contract, and these functions are the only place to fix if it changes.
 */

const HEADER = /^\s*(online\s+)?players?\b.*:\s*$/i;
const COUNT = /\((\d+)\)/;
const ONLINE_SUFFIX = /\s*\(online\)\s*$/i;
const BULLET = /^[-*•]\s*/;

export type PlayersOutput = {
  players: string[];
  /** Count announced by the header, when it differs from the rows listed. */
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

/** Online players, from the output of `/players online`. */
export function parseOnlinePlayers(output: string): string[] {
  return parsePlayers(output).players;
}

export function parseVersion(output: string): string {
  return output.trim().split(/\r?\n/)[0]?.trim() ?? "";
}
