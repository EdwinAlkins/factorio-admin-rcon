import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { agentLogs, agentStatus, agentStop } = await import("@/server/control/client");
const { resetAgentTokens } = await import("@/server/agents/transport");
const { resetEnvCache, withEnv } = await import("../helpers");

const TOKEN = "0123456789abcdef0123456789abcdef-test";

type Seen = { url: string; init: RequestInit };
let seen: Seen[];

function respond(response: () => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return response();
    }),
  );
}

async function failure(promise: Promise<unknown>) {
  return promise.then(
    () => {
      throw new Error("expected a failure");
    },
    (error: { key: string; status: number }) => error,
  );
}

beforeEach(() => {
  seen = [];
  resetAgentTokens();
  withEnv({ CONTROL_AGENT_TOKEN: TOKEN, CONTROL_AGENT_URL: "http://agent.test:8080" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  withEnv({ CONTROL_AGENT_TOKEN: undefined, CONTROL_AGENT_URL: undefined, CONTROL_AGENT_TOKEN_FILE: undefined });
  resetAgentTokens();
  resetEnvCache();
});

describe("control agent client", () => {
  it("sends the bearer token and only fixed paths", async () => {
    respond(() => Response.json({ ok: true, container: { state: "running" } }));

    await agentStatus();
    await agentStop();

    expect(seen.map(({ url, init }) => `${init.method} ${url}`)).toEqual([
      "GET http://agent.test:8080/v1/server/status",
      "POST http://agent.test:8080/v1/server/stop",
    ]);
    for (const { init } of seen) {
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    }
  });

  it("reads the token from its file", async () => {
    withEnv({ CONTROL_AGENT_TOKEN: undefined });
    const dir = mkdtempSync(join(tmpdir(), "control-token-"));
    const file = join(dir, "token");
    writeFileSync(file, `${TOKEN}-file\n`);
    withEnv({ CONTROL_AGENT_TOKEN_FILE: file });
    respond(() => Response.json({ ok: true, lines: [] }));

    await agentLogs({ tail: 10, since: 5 });

    expect(seen[0].url).toBe("http://agent.test:8080/v1/server/logs?tail=10&since=5");
    expect((seen[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}-file`);
  });

  it("fails cleanly without a usable token, before any request", async () => {
    withEnv({ CONTROL_AGENT_TOKEN: undefined, CONTROL_AGENT_TOKEN_FILE: "/does/not/exist" });
    respond(() => Response.json({}));

    expect(await failure(agentStatus())).toMatchObject({ key: "control_config", status: 500 });
    expect(seen).toEqual([]);
  });

  it.each([
    ["unauthorized", 401, "control_rejected"],
    ["target_missing", 503, "control_target_missing"],
    ["target_ambiguous", 503, "control_target_ambiguous"],
    ["busy", 409, "control_busy"],
    ["rate_limited", 429, "control_rate_limited"],
    ["docker_timeout", 504, "control_timeout"],
    ["docker_error", 502, "control_docker"],
    ["not_found", 404, "control_protocol"],
  ])("maps the agent's %s to %s", async (code, status, key) => {
    respond(() => Response.json({ ok: false, code }, { status }));
    expect(await failure(agentStatus())).toMatchObject({ key });
  });

  it("tells an unreachable agent from a slow one and from a broken answer", async () => {
    respond(() => Promise.reject(new TypeError("fetch failed")));
    expect(await failure(agentStatus())).toMatchObject({ key: "control_unreachable", status: 502 });

    respond(() => Promise.reject(new DOMException("timed out", "TimeoutError")));
    expect(await failure(agentStatus())).toMatchObject({ key: "control_timeout", status: 504 });

    respond(() => new Response("<html>", { status: 200 }));
    expect(await failure(agentStatus())).toMatchObject({ key: "control_protocol" });
  });
});
