import { readFile } from "node:fs/promises";
import { env } from "@/server/config/env";
import { errorFields } from "@/server/log";
import { ControlError, fromAgentCode } from "@/server/control/errors";
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

const globalRef = globalThis as typeof globalThis & { __factorioControlToken?: string };

/**
 * Read once, then kept: the agent reads it once too, so a rotation needs both
 * restarted anyway. A failed read is not cached, so fixing the file is enough.
 */
async function token(): Promise<string> {
  if (globalRef.__factorioControlToken) return globalRef.__factorioControlToken;

  const config = env();
  let value = config.CONTROL_AGENT_TOKEN;
  if (!value) {
    try {
      value = (await readFile(/* turbopackIgnore: true */ config.CONTROL_AGENT_TOKEN_FILE, "utf8")).trim();
    } catch (error) {
      throw new ControlError("control_config", {
        detail: `tokenFile=${config.CONTROL_AGENT_TOKEN_FILE} ${errorFields(error).error}`,
      });
    }
  }
  if (value.length < 32) {
    throw new ControlError("control_config", { detail: "control agent token shorter than 32 characters" });
  }

  return (globalRef.__factorioControlToken = value);
}

/** Forgets the cached token (tests). */
export function resetControlToken() {
  globalRef.__factorioControlToken = undefined;
}

type AgentRequest = {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
  timeoutMs?: number;
};

async function call<T>({ method, path, body, timeoutMs }: AgentRequest): Promise<T> {
  // No feature flag here: the agent serves two features (server control and
  // container metrics), and each caller checks its own.
  const config = env();
  const url = `${config.CONTROL_AGENT_URL}${path}`;
  const headers: Record<string, string> = {
    accept: "application/json",
    authorization: `Bearer ${await token()}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? config.CONTROL_AGENT_TIMEOUT_MS),
    });
  } catch (error) {
    const name = (error as Error | undefined)?.name;
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ControlError("control_timeout", { detail: `${method} ${url}: no answer` });
    }
    throw new ControlError("control_unreachable", {
      detail: `${method} ${url}: ${errorFields(error).error}`,
    });
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    // Draining the body keeps undici from leaving the socket hanging.
    await response.body?.cancel().catch(() => undefined);
    throw new ControlError("control_protocol", {
      detail: `${method} ${url} → HTTP ${response.status}, body is not JSON`,
    });
  }

  if (!response.ok) {
    const code = (payload as { code?: string } | null)?.code;
    throw new ControlError(fromAgentCode(code, response.status), {
      detail: `${method} ${url} → HTTP ${response.status} ${code ?? ""}`.trim(),
    });
  }

  return payload as T;
}

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
export async function agentHealthy(): Promise<boolean> {
  try {
    const response = await fetch(`${env().CONTROL_AGENT_URL}/healthz`, {
      signal: AbortSignal.timeout(env().CONTROL_AGENT_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return response.ok;
  } catch {
    return false;
  }
}
