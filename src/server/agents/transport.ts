import { readFile } from "node:fs/promises";
import { errorFields } from "@/server/log";
import { AgentError, fromAgentCode, type AgentName } from "@/server/agents/errors";

/**
 * HTTP transport shared by the clients of both agents: bearer token read from
 * a Compose secret, bounded deadline, and every failure — network, timeout,
 * refusal, unexpected body — turned into an `AgentError` with a stable key.
 */

export type AgentSettings = {
  url: string;
  token?: string;
  tokenFile: string;
  timeoutMs: number;
};

export type AgentRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  /** Sent as JSON. */
  body?: unknown;
  /** Sent as it is, in place of `body`: an upload's chunk. */
  raw?: Uint8Array<ArrayBuffer>;
  timeoutMs?: number;
};

type TokenCache = Partial<Record<AgentName, string>>;
const globalRef = globalThis as typeof globalThis & { __factorioAgentTokens?: TokenCache };
const tokens: TokenCache = (globalRef.__factorioAgentTokens ??= {});

/** Forgets the cached tokens (tests). */
export function resetAgentTokens() {
  for (const key of Object.keys(tokens) as AgentName[]) delete tokens[key];
}

export function agentTransport(agent: AgentName, settings: () => AgentSettings) {
  /**
   * Read once, then kept: the agent reads it once too, so a rotation needs
   * both restarted anyway. A failed read is not cached, so fixing the file is
   * enough.
   */
  async function token(): Promise<string> {
    const cached = tokens[agent];
    if (cached) return cached;

    const config = settings();
    let value = config.token;
    if (!value) {
      try {
        value = (await readFile(/* turbopackIgnore: true */ config.tokenFile, "utf8")).trim();
      } catch (error) {
        throw new AgentError(`${agent}_config`, {
          detail: `tokenFile=${config.tokenFile} ${errorFields(error).error}`,
        });
      }
    }
    if (value.length < 32) {
      throw new AgentError(`${agent}_config`, { detail: `${agent} agent token shorter than 32 characters` });
    }
    return (tokens[agent] = value);
  }

  /** Sends a request; resolves with the raw response once it is a success. */
  async function send({ method, path, body, raw, timeoutMs }: AgentRequest): Promise<Response> {
    const config = settings();
    const url = `${config.url}${path}`;
    const headers: Record<string, string> = { authorization: `Bearer ${await token()}` };
    if (raw !== undefined) headers["content-type"] = "application/octet-stream";
    else if (body !== undefined) headers["content-type"] = "application/json";

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
        signal: AbortSignal.timeout(timeoutMs ?? config.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error | undefined)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new AgentError(`${agent}_timeout`, { detail: `${method} ${url}: no answer` });
      }
      throw new AgentError(`${agent}_unreachable`, {
        detail: `${method} ${url}: ${errorFields(error).error}`,
      });
    }

    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { code?: string } | null;
      throw new AgentError(fromAgentCode(agent, payload?.code, response.status), {
        detail: `${method} ${url} → HTTP ${response.status} ${payload?.code ?? ""}`.trim(),
      });
    }
    return response;
  }

  /** Sends a request and decodes its JSON answer. */
  async function call<T>(request: AgentRequest): Promise<T> {
    const response = await send(request);
    try {
      return (await response.json()) as T;
    } catch {
      // Draining the body keeps undici from leaving the socket hanging.
      await response.body?.cancel().catch(() => undefined);
      throw new AgentError(`${agent}_protocol`, {
        detail: `${request.method} ${request.path} → HTTP ${response.status}, body is not JSON`,
      });
    }
  }

  /** Liveness of the agent itself; touches neither Docker nor the disk. */
  async function healthy(): Promise<boolean> {
    try {
      const response = await fetch(`${settings().url}/healthz`, {
        signal: AbortSignal.timeout(settings().timeoutMs),
      });
      await response.body?.cancel().catch(() => undefined);
      return response.ok;
    } catch {
      return false;
    }
  }

  return { send, call, healthy };
}
