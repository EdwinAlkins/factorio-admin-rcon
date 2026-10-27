import { env } from "@/server/config/env";
import { ApiFailure } from "@/server/http/errors";
import { getRcon } from "@/server/rcon";
import { getServerStatus } from "@/server/rcon/status";
import { agentLogs, agentRestart, agentStart, agentStatus, agentStop } from "@/server/control/client";

/**
 * The building blocks of every operation that touches the server process:
 * the lifecycle recipes use them directly, and restores and mod changes chain
 * them around their own file work.
 */

/** Delays of the polling loops, overridable by the tests. */
export const timing = {
  /** Between two reads of the logs while waiting for the save to finish. */
  savePollMs: 1000,
  /** Between two RCON probes while waiting for the map to load. */
  rconPollMs: 2000,
  /**
   * How long a start may take before RCON answers. Generous: a large modded
   * map can take minutes to load, and giving up early would report a failure
   * for a server that comes up a minute later.
   */
  rconWaitMs: 10 * 60 * 1000,
};

/**
 * Lines Factorio writes when a save is complete. A blocking save (the one
 * `/server-save` triggers) ends with "Saving progress: 100%"; a background
 * autosave with "Saving finished".
 */
const SAVE_DONE = /Saving finished|Saving progress: 100(?:\.0+)?%/;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Bringing the server down disconnects whoever is playing, and without RCON
 * the panel can neither count them nor save first. Both need an explicit
 * `force` from the operator. Returns whether RCON answered.
 */
export async function checkPlayers(
  force: boolean,
  deny: (code: string, extra?: string) => void,
): Promise<boolean> {
  let count: number;
  try {
    count = (await getServerStatus({ force: true })).count;
  } catch {
    if (!force) {
      deny("rcon_unavailable_force_required");
      throw new ApiFailure(409, "rcon_unavailable_force_required");
    }
    return false;
  }

  if (count > 0 && !force) {
    deny("players_online", `${count} online`);
    throw new ApiFailure(409, "players_online", { count });
  }
  return true;
}

/**
 * Asks Factorio to save, then waits until its log says the save is written.
 *
 * `/server-save` returns as soon as the save is scheduled, not when it is on
 * disk: stopping right after could cut it short. The logs are read from just
 * before the command, so a save finishing before the first read still counts.
 */
export async function saveGame() {
  const since = Math.floor(Date.now() / 1000) - 1;
  await getRcon().execute("/server-save");

  const deadline = Date.now() + env().CONTROL_SAVE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const lines = await agentLogs({ tail: 200, since });
    if (lines.some((line) => SAVE_DONE.test(line.text))) return;
    await sleep(timing.savePollMs);
  }

  // The server is left running: stopping it now could lose the save in
  // progress, which is exactly what this step exists to prevent.
  throw new ApiFailure(504, "save_timeout");
}

/**
 * Stops the container. The RCON socket then points at a process that no
 * longer exists: the next command must open a fresh one.
 */
export async function stopServer() {
  await agentStop();
  await getRcon().disconnect();
}

export async function restartServer() {
  await agentRestart();
  await getRcon().disconnect();
}

export async function startServer() {
  await agentStart();
}

/**
 * Waits until the freshly started server answers RCON.
 *
 * A server that crashes while loading — a broken mod, a map from another mod
 * set — never will: that is noticed at once rather than after the whole wait,
 * so a rollback starts in seconds, not minutes. Docker's restart policy may
 * bring the container straight back up, so a restart counts as a crash too.
 */
export async function waitForRcon() {
  const deadline = Date.now() + timing.rconWaitMs;
  // Taken at the first failed probe: a server that answers at once costs no
  // extra call.
  let restartsBefore: number | null = null;
  while (Date.now() < deadline) {
    const probe = await getRcon().healthCheck();
    if (probe.ok) return;

    const container = await agentStatus().catch(() => null);
    if (container) {
      restartsBefore ??= container.restartCount;
      const down = container.state === "exited" || container.state === "dead";
      if (down || container.restartCount > restartsBefore) {
        throw new ApiFailure(502, "server_crashed", { exitCode: container.exitCode });
      }
    }
    await sleep(timing.rconPollMs);
  }
  throw new ApiFailure(504, "rcon_not_back");
}
