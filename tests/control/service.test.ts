import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = await vi.hoisted(async () => (await import("./fakes")).createFakes());

vi.mock("@/server/control/client", () => fakes.clientModule);
vi.mock("@/server/rcon", () => fakes.rconModule);
vi.mock("@/server/rcon/status", () => fakes.statusModule);

const { container } = await import("./fakes");
const { currentOperation, deriveState, invalidateContainerCache, requestOperation, timing } = await import(
  "@/server/control/service"
);
const { getOperation, markInterruptedOperations, createOperation, recentOperations } = await import(
  "@/server/operations/store"
);
const { AgentError } = await import("@/server/agents/errors");
const { listAudit } = await import("@/server/audit/service");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");

import type { OperationRequest } from "@/server/control/service";
import type { ServerOperationDto } from "@/lib/api-types";

const defaults = { ...timing };

function request(type: OperationRequest["type"], force = false): OperationRequest {
  return { type, force, username: "admin", role: "admin", ip: null, requestId: "req" };
}

/** Starts an operation and waits for it to finish. */
async function runToEnd(type: OperationRequest["type"], force = false) {
  const operation = await requestOperation(request(type, force));
  await currentOperation()?.done;
  return getOperation(operation.id)!;
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).not.toBeNull();
  return error as { status: number; code: string; params?: Record<string, unknown> };
}

beforeEach(() => {
  withEnv({ LOG_LEVEL: "error" });
  useMemoryDatabase();
  fakes.reset();
  invalidateContainerCache();
  Object.assign(timing, { savePollMs: 1, rconPollMs: 1, rconWaitMs: 50 });
});

afterEach(async () => {
  await currentOperation()?.done;
  Object.assign(timing, defaults);
  vi.useRealTimers();
  resetEnvCache();
});

describe("stop", () => {
  it("saves, waits for the save, then stops", async () => {
    const done = await runToEnd("stop");

    expect(done.status).toBe("success");
    expect(fakes.calls).toEqual([
      "agent.status",
      "rcon:/server-save",
      "agent.logs",
      "agent.stop",
      "rcon.disconnect",
    ]);

    const [entry] = listAudit();
    expect(entry).toMatchObject({ kind: "server", action: "stop", status: "success" });
  });

  it("keeps reading the logs until the save is reported done", async () => {
    let reads = 0;
    fakes.agent.logs.mockImplementation(async () => {
      reads += 1;
      return reads < 3 ? [] : [{ stream: "stdout", text: "Info AppManager.cpp: Saving finished" }];
    });

    expect((await runToEnd("stop")).status).toBe("success");
    expect(reads).toBe(3);
  });

  it("leaves the server running when the save does not finish", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    fakes.agent.logs.mockImplementation(async () => []);

    const operation = await requestOperation(request("stop"));
    await vi.advanceTimersByTimeAsync(130_000);
    await currentOperation()?.done;

    const done = getOperation(operation.id)!;
    expect(done).toMatchObject({ status: "error", errorCode: "save_timeout" });
    expect(fakes.agent.stop).not.toHaveBeenCalled();
  });

  it("refuses while players are online, unless forced", async () => {
    fakes.rcon.players = 2;

    const error = await refusal(requestOperation(request("stop")));
    expect(error).toMatchObject({ status: 409, code: "players_online", params: { count: 2 } });
    expect(fakes.agent.stop).not.toHaveBeenCalled();
    expect(listAudit()[0]).toMatchObject({ status: "denied", detail: "players_online: 2 online" });

    // The refusal released the lock: the forced retry goes through.
    const done = await runToEnd("stop", true);
    expect(done).toMatchObject({ status: "success", forced: true });
  });

  it("requires force when RCON is down, and then skips the save", async () => {
    fakes.rcon.players = new Error("connection refused");

    const error = await refusal(requestOperation(request("stop")));
    expect(error).toMatchObject({ status: 409, code: "rcon_unavailable_force_required" });

    const done = await runToEnd("stop", true);
    expect(done.status).toBe("success");
    expect(fakes.rcon.execute).not.toHaveBeenCalled();
    expect(fakes.agent.stop).toHaveBeenCalledOnce();
  });

  it("refuses a server that is not running", async () => {
    fakes.agent.status.mockImplementation(async () => container("exited"));

    const error = await refusal(requestOperation(request("stop")));
    expect(error).toMatchObject({ status: 409, code: "server_not_running" });
  });

  it("records the agent's failure on the operation", async () => {
    fakes.agent.stop.mockImplementation(async () => {
      throw new AgentError("control_docker", { detail: "HTTP 500" });
    });

    const done = await runToEnd("stop");
    expect(done).toMatchObject({ status: "error", errorCode: "control_docker" });
    expect(listAudit()[0]).toMatchObject({ status: "error", detail: "control_docker: HTTP 500" });
  });
});

describe("start and restart", () => {
  it("starts, then waits for RCON", async () => {
    fakes.agent.status.mockImplementation(async () => container("exited"));
    let probes = 0;
    fakes.rcon.healthCheck.mockImplementation(async () => ({ ok: ++probes >= 3 }));

    const done = await runToEnd("start");
    expect(done.status).toBe("success");
    expect(fakes.agent.start).toHaveBeenCalledOnce();
    expect(probes).toBe(3);
  });

  it("reports a server whose RCON never comes back", async () => {
    fakes.agent.status.mockImplementation(async () => container("exited"));
    fakes.rcon.healthCheck.mockImplementation(async () => ({ ok: false }));

    const done = await runToEnd("start");
    expect(done).toMatchObject({ status: "error", errorCode: "rcon_not_back" });
  });

  it("refuses to start a running server", async () => {
    const error = await refusal(requestOperation(request("start")));
    expect(error).toMatchObject({ status: 409, code: "server_already_running" });
    expect(fakes.agent.start).not.toHaveBeenCalled();
  });

  it("restarts through the agent after saving", async () => {
    const done = await runToEnd("restart");
    expect(done.status).toBe("success");
    expect(fakes.calls).toEqual([
      "agent.status",
      "rcon:/server-save",
      "agent.logs",
      "agent.restart",
      "rcon.disconnect",
    ]);
    expect(fakes.agent.stop).not.toHaveBeenCalled();
  });
});

describe("one operation at a time", () => {
  it("refuses a second operation while one runs", async () => {
    let release!: () => void;
    fakes.agent.stop.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ changed: true, container: container("exited") });
        }),
    );

    // Both requests in the same tick: the lock is taken before any await.
    const [first, second] = await Promise.allSettled([
      requestOperation(request("stop")),
      requestOperation(request("restart")),
    ]);
    expect(first.status).toBe("fulfilled");
    expect(second).toMatchObject({ status: "rejected", reason: { code: "operation_in_progress" } });

    await vi.waitFor(() => expect(fakes.agent.stop).toHaveBeenCalled());
    release();
    await currentOperation()?.done;
    expect(currentOperation()).toBeNull();
  });

  it("releases the lock when a pre-check fails", async () => {
    fakes.agent.status.mockImplementation(async () => {
      throw new AgentError("control_unreachable");
    });
    await refusal(requestOperation(request("stop")));
    expect(currentOperation()).toBeNull();

    fakes.agent.status.mockImplementation(async () => container("running"));
    expect((await runToEnd("stop")).status).toBe("success");
  });
});

describe("history", () => {
  it("marks operations left running by a previous process as interrupted", () => {
    const left = createOperation({ type: "restart", username: "admin", role: "admin", forced: false });

    expect(markInterruptedOperations()).toBe(1);
    expect(getOperation(left.id)).toMatchObject({ status: "interrupted", step: null });
    expect(recentOperations()).toHaveLength(1);
  });
});

describe("deriveState", () => {
  const now = Date.parse("2026-10-27T12:00:00Z");
  const op = (type: ServerOperationDto["type"], step: ServerOperationDto["step"]): ServerOperationDto => ({
    id: 1,
    type,
    status: "running",
    step,
    username: "admin",
    startedAt: now,
    finishedAt: null,
    errorCode: null,
    forced: false,
  });

  it.each([
    ["running + RCON", container("running"), true, null, "running"],
    ["fresh container without RCON", container("running", { startedAt: "2026-10-27T11:58:00Z" }), false, null, "starting"],
    ["old container without RCON", container("running", { startedAt: "2026-10-27T10:00:00Z" }), false, null, "error"],
    ["exited", container("exited"), false, null, "stopped"],
    ["created, never started", container("created"), false, null, "stopped"],
    ["restarting", container("restarting"), false, null, "starting"],
    ["dead", container("dead"), false, null, "error"],
    ["paused", container("paused"), false, null, "error"],
    ["agent unreachable", null, false, null, "unknown"],
    ["stop saving", container("running"), true, op("stop", "saving"), "stopping"],
    ["restart, back up", container("running"), false, op("restart", "waiting_rcon"), "starting"],
    ["start, container starting", container("exited"), false, op("start", "starting"), "starting"],
  ] as const)("%s", (_, state, rconOk, operation, expected) => {
    expect(deriveState(state, rconOk, operation, now)).toBe(expected);
  });
});

describe("container state cache", () => {
  it("serves concurrent and repeated polls from one agent call", async () => {
    const { getServerState, invalidateContainerCache } = await import("@/server/control/service");
    invalidateContainerCache();

    await Promise.all([getServerState(), getServerState(), getServerState()]);
    await getServerState();
    expect(fakes.agent.status).toHaveBeenCalledOnce();

    // An operation ending drops the cache: the next poll sees the new state.
    await runToEnd("stop");
    fakes.agent.status.mockClear();
    await getServerState();
    expect(fakes.agent.status).toHaveBeenCalledOnce();
  });

  it("caches an unreachable agent too", async () => {
    const { getServerState, invalidateContainerCache } = await import("@/server/control/service");
    invalidateContainerCache();
    fakes.agent.status.mockImplementation(async () => {
      throw new AgentError("control_unreachable");
    });

    expect((await getServerState()).controlError).toBe("control_unreachable");
    await getServerState();
    expect(fakes.agent.status).toHaveBeenCalledOnce();
  });
});
