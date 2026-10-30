import { env } from "@/server/config/env";
import { agentTransport } from "@/server/agents/transport";
import type { ContainerStatusDto, ServerLogLineDto } from "@/lib/api-types";
import type { DockerStats } from "@/server/metrics/docker";

/**
 * Client of the control agent (services/agents, cmd/control-agent).
 *
 * The agent is the only component holding the Docker socket, and it exposes a
 * closed list of operations on the Factorio container. This module never
 * builds a Docker API path and never names a container: the agent resolves
 * its target itself, from its own configuration.
 */

/**
 * Deadline of a start, stop or restart: the agent answers once Docker is done,
 * which can take its full grace period (300 s at most) plus a margin.
 */
export const MUTATION_TIMEOUT_MS = 6 * 60 * 1000;

const transport = agentTransport("control", () => {
  const config = env();
  return {
    url: config.CONTROL_AGENT_URL,
    token: config.CONTROL_AGENT_TOKEN,
    tokenFile: config.CONTROL_AGENT_TOKEN_FILE,
    timeoutMs: config.CONTROL_AGENT_TIMEOUT_MS,
  };
});

// No feature flag here: the agent serves two features (server control and
// container metrics), and each caller checks its own.
const call = transport.call;

export async function agentStatus(): Promise<ContainerStatusDto> {
  const result = await call<{ container: ContainerStatusDto }>({ method: "GET", path: "/v1/server/status" });
  return result.container;
}

export async function agentStats(): Promise<DockerStats> {
  const result = await call<{ stats: DockerStats }>({ method: "GET", path: "/v1/server/stats" });
  return result.stats;
}

export async function agentLogs(options: { tail: number; since?: number }): Promise<ServerLogLineDto[]> {
  const query = new URLSearchParams({ tail: String(options.tail) });
  if (options.since !== undefined) query.set("since", String(options.since));

  const result = await call<{ lines: ServerLogLineDto[] }>({
    method: "GET",
    path: `/v1/server/logs?${query}`,
  });
  return result.lines;
}

export type AgentMutation = { changed: boolean; container: ContainerStatusDto };

export function agentStart(): Promise<AgentMutation> {
  return call({ method: "POST", path: "/v1/server/start", timeoutMs: MUTATION_TIMEOUT_MS });
}

export function agentStop(): Promise<AgentMutation> {
  return call({ method: "POST", path: "/v1/server/stop", timeoutMs: MUTATION_TIMEOUT_MS });
}

export function agentRestart(): Promise<AgentMutation> {
  return call({ method: "POST", path: "/v1/server/restart", timeoutMs: MUTATION_TIMEOUT_MS });
}

/** Liveness of the agent itself; does not touch Docker. */
export const agentHealthy = transport.healthy;
