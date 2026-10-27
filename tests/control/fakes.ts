import { vi } from "vitest";
import type { BackupDto, ContainerStatusDto, ModDto, ServerLogLineDto } from "@/lib/api-types";

/**
 * Shared fakes for the control agent client and RCON. Each test file wires
 * them with `vi.mock(...)` and resets them in `beforeEach`.
 */

export function container(state: string, extra: Partial<ContainerStatusDto> = {}): ContainerStatusDto {
  return {
    state,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
    exitCode: 0,
    restartCount: 0,
    image: "factoriotools/factorio:stable",
    ...extra,
  };
}

export const MODS: ModDto[] = [
  { name: "base", enabled: true, builtin: true },
  { name: "even-distribution", enabled: true, version: "2.0.3", builtin: false },
];

export function backup(id: string, extra: Partial<BackupDto> = {}): BackupDto {
  return {
    id,
    source: "manual",
    createdAt: "2026-10-27T10:00:00Z",
    size: 1000,
    sha256: "a".repeat(64),
    saveName: "_autosave1.zip",
    factorioVersion: "2.0.72",
    mods: MODS,
    ...extra,
  };
}

export function createFakes() {
  const calls: string[] = [];

  const agent = {
    status: vi.fn(async (): Promise<ContainerStatusDto> => container("running")),
    logs: vi.fn(
      async (): Promise<ServerLogLineDto[]> => [
        { stream: "stdout", text: "  33.845 Info MainLoop.cpp:448: Saving progress: 100.000000%" },
      ],
    ),
    start: vi.fn(async () => ({ changed: true, container: container("running") })),
    stop: vi.fn(async () => ({ changed: true, container: container("exited") })),
    restart: vi.fn(async () => ({ changed: true, container: container("running") })),
  };

  const rcon = {
    execute: vi.fn(async (command: string) => ({ command, output: "", durationMs: 1 })),
    healthCheck: vi.fn(async (): Promise<{ ok: boolean }> => ({ ok: true })),
    disconnect: vi.fn(async () => undefined),
    /** Players online, or an Error to make the status reading fail. */
    players: 0 as number | Error,
  };

  const data = {
    backups: [] as BackupDto[],
    mods: MODS,
    create: vi.fn(async (request: { source: string }) => backup(`20261027-120000-${request.source}`, { source: request.source as BackupDto["source"] })),
    restore: vi.fn(async (id: string) => ({ saveName: "_autosave1.zip", replaced: [id] })),
    remove: vi.fn(async () => undefined),
    verify: vi.fn(async (id: string): Promise<void> => void id),
    prune: vi.fn(async () => [] as string[]),
    download: vi.fn(
      async () =>
        new Response("ZIPDATA", {
          headers: { "content-type": "application/zip", "content-length": "7", "x-content-sha256": "b".repeat(64) },
        }),
    ),
  };

  function reset() {
    calls.length = 0;
    data.backups = [backup("20261027-100000-manual")];
    data.mods = MODS;
    for (const fn of [data.create, data.restore, data.remove, data.prune, data.download, data.verify]) fn.mockClear();
    data.verify.mockImplementation(async () => undefined);
    data.create.mockImplementation(async (request: { source: string }) =>
      backup(`20261027-120000-${request.source}`, { source: request.source as BackupDto["source"] }),
    );
    data.restore.mockImplementation(async (id: string) => ({ saveName: "_autosave1.zip", replaced: [id] }));
    for (const fn of [...Object.values(agent), rcon.execute, rcon.healthCheck, rcon.disconnect]) {
      fn.mockClear();
    }
    agent.status.mockImplementation(async () => container("running"));
    agent.logs.mockImplementation(async () => [
      { stream: "stdout", text: "  33.845 Info MainLoop.cpp:448: Saving progress: 100.000000%" },
    ]);
    agent.start.mockImplementation(async () => ({ changed: true, container: container("running") }));
    agent.stop.mockImplementation(async () => ({ changed: true, container: container("exited") }));
    agent.restart.mockImplementation(async () => ({ changed: true, container: container("running") }));
    rcon.execute.mockImplementation(async (command: string) => ({ command, output: "", durationMs: 1 }));
    rcon.healthCheck.mockImplementation(async () => ({ ok: true }));
    rcon.players = 0;
  }

  /** Records the order in which the agent and RCON were called. */
  const track =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A) => {
      calls.push(name === "rcon.execute" ? `rcon:${String(args[0])}` : name);
      return fn(...args);
    };

  const clientModule = {
    agentStatus: track("agent.status", () => agent.status()),
    agentLogs: track("agent.logs", () => agent.logs()),
    agentStart: track("agent.start", () => agent.start()),
    agentStop: track("agent.stop", () => agent.stop()),
    agentRestart: track("agent.restart", () => agent.restart()),
    agentStats: async () => ({}),
    agentHealthy: async () => true,
  };

  const dataModule = {
    dataSaves: track("data.saves", async () => ({ saves: [], mods: data.mods })),
    dataBackups: track("data.backups", async () => data.backups),
    dataCreateBackup: track("data.create", (request: { source: string }) => data.create(request)),
    dataRestore: track("data.restore", (id: string) => data.restore(id)),
    dataVerify: track("data.verify", (id: string) => data.verify(id)),
    dataDeleteBackup: track("data.delete", () => data.remove()),
    dataPrune: track("data.prune", () => data.prune()),
    dataDownload: track("data.download", () => data.download()),
    dataHealthy: async () => true,
  };

  const rconModule = {
    getRcon: () => ({
      execute: track("rcon.execute", (command: string) => rcon.execute(command)),
      healthCheck: () => rcon.healthCheck(),
      disconnect: track("rcon.disconnect", () => rcon.disconnect()),
    }),
    rconTarget: () => "factorio:27015",
    shutdownRcon: async () => undefined,
  };

  const statusModule = {
    getServerStatus: async () => {
      if (rcon.players instanceof Error) throw rcon.players;
      return { online: [], count: rcon.players, version: "2.0.72", target: "factorio:27015", cachedAt: Date.now() };
    },
    invalidateStatusCache: () => undefined,
  };

  return { agent, rcon, data, calls, reset, clientModule, dataModule, rconModule, statusModule };
}
