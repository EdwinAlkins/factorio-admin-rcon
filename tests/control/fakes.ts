import { vi } from "vitest";
import type { ContainerStatusDto, ServerLogLineDto } from "@/lib/api-types";

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

  function reset() {
    calls.length = 0;
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

  return { agent, rcon, calls, reset, clientModule, rconModule, statusModule };
}
