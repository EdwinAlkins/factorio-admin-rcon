import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = await vi.hoisted(async () => (await import("../control/fakes")).createFakes());

vi.mock("@/server/control/client", () => fakes.clientModule);
vi.mock("@/server/data/client", () => fakes.dataModule);
vi.mock("@/server/rcon", () => fakes.rconModule);
vi.mock("@/server/rcon/status", () => fakes.statusModule);

const { container, plan, PLAN_HASH } = await import("../control/fakes");
const { listMods, requestModsApply } = await import("@/server/mods/service");
const { currentOperation, requestOperation, timing, invalidateContainerCache } = await import("@/server/control/service");
const { getOperation } = await import("@/server/operations/store");
const { AgentError } = await import("@/server/agents/errors");
const { listAudit } = await import("@/server/audit/service");
const { lastFactorioVersion, resetFactorioVersionMemory } = await import("@/server/factorio-version");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");

const actor = { username: "admin", role: "admin", ip: null, requestId: "req" };
const changes = [{ action: "update" as const, name: "even-distribution" }];
const apply = (extra: { force?: boolean; planHash?: string } = {}) =>
  requestModsApply({ ...actor, changes, planHash: extra.planHash ?? PLAN_HASH, force: extra.force ?? false });
const defaults = { ...timing };

async function finish(operation: { id: number }) {
  await currentOperation()?.done;
  return getOperation(operation.id)!;
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).not.toBeNull();
  return error as { status: number; code?: string; key?: string };
}

beforeEach(() => {
  withEnv({ LOG_LEVEL: "error" });
  useMemoryDatabase();
  resetFactorioVersionMemory();
  fakes.reset();
  invalidateContainerCache();
  Object.assign(timing, { savePollMs: 1, rconPollMs: 1, rconWaitMs: 50 });
});

afterEach(async () => {
  await currentOperation()?.done;
  Object.assign(timing, defaults);
  resetEnvCache();
});

describe("apply", () => {
  it("downloads before stopping, archives the map, swaps, restarts", async () => {
    const op = await apply();
    expect(op).toMatchObject({ type: "mods_apply", status: "running" });
    expect((await finish(op)).status).toBe("success");

    expect(fakes.calls).toEqual([
      "data.modsPlan",
      "agent.status",
      "data.modsStage",
      "rcon:/server-save",
      "agent.logs",
      "agent.stop",
      "rcon.disconnect",
      "data.create",
      "data.modsCommit",
      "agent.start",
    ]);
    expect(fakes.data.modsPlan).toHaveBeenCalledWith(changes, "2.0.72");
    expect(fakes.data.create).toHaveBeenCalledWith(
      expect.objectContaining({ source: "pre-mods", label: "before mods: +flib ↑even-distribution", createdBy: "admin" }),
    );
    expect(fakes.data.modsCommit).toHaveBeenCalledWith("20261027-120000-abcdef");
    expect(listAudit()[0]).toMatchObject({ kind: "mods", action: "mods_apply", status: "success" });
  });

  it("leaves the server alone when a download fails", async () => {
    fakes.data.modsStage.mockImplementation(async () => {
      throw new AgentError("download_checksum");
    });
    const op = await apply();
    expect(await finish(op)).toMatchObject({ status: "error", errorCode: "download_checksum" });
    expect(fakes.agent.stop).not.toHaveBeenCalled();
    expect(fakes.data.modsCommit).not.toHaveBeenCalled();
  });

  it("rolls the mods back when the server does not come back", async () => {
    // RCON answers again only once the old mods are back.
    fakes.rcon.healthCheck.mockImplementation(async () => ({ ok: fakes.data.modsRollback.mock.calls.length > 0 }));

    const op = await apply();
    const done = await finish(op);
    expect(done).toMatchObject({ status: "error", errorCode: "mods_rolled_back" });
    expect(fakes.data.modsRollback).toHaveBeenCalledWith("20261027-120000-abcdef");
    // Stopped again before the rollback, started once more after it.
    expect(fakes.agent.stop).toHaveBeenCalledTimes(2);
    expect(fakes.agent.start).toHaveBeenCalledTimes(2);
  });

  it("notices a crash at once rather than waiting for RCON", async () => {
    // A broken mod: Factorio exits while loading, until the old mods are back.
    Object.assign(timing, { rconWaitMs: 60_000 });
    const crashed = () => fakes.data.modsCommit.mock.calls.length > 0 && fakes.data.modsRollback.mock.calls.length === 0;
    fakes.agent.status.mockImplementation(async () => container(crashed() ? "exited" : "running", { exitCode: 1 }));
    fakes.rcon.healthCheck.mockImplementation(async () => ({ ok: !crashed() }));

    const started = Date.now();
    const op = await apply();
    const done = await finish(op);
    expect(done).toMatchObject({ status: "error", errorCode: "mods_rolled_back" });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(listAudit()[0].detail).toContain("server_crashed");
  });

  it("says so when the rollback fails too", async () => {
    fakes.rcon.healthCheck.mockImplementation(async () => ({ ok: false }));
    const op = await apply();
    expect(await finish(op)).toMatchObject({ status: "error", errorCode: "mods_rollback_failed" });
  });

  it("keeps a stopped server stopped", async () => {
    fakes.agent.status.mockImplementation(async () => container("exited"));
    // The version was seen while the server ran.
    await listMods();
    fakes.rcon.players = new Error("rcon down");

    const op = await apply();
    expect((await finish(op)).status).toBe("success");
    expect(fakes.data.modsCommit).toHaveBeenCalled();
    expect(fakes.agent.stop).not.toHaveBeenCalled();
    expect(fakes.agent.start).not.toHaveBeenCalled();
  });
});

describe("refusals, before anything moves", () => {
  it("a plan that changed since the preview", async () => {
    const error = await refusal(apply({ planHash: "d".repeat(64) }));
    expect(error).toMatchObject({ status: 409, key: "plan_changed" });
    expect(fakes.data.modsStage).not.toHaveBeenCalled();
    expect(listAudit()[0]).toMatchObject({ kind: "mods", status: "denied", detail: "plan_changed" });
  });

  it("conflicts", async () => {
    fakes.data.modsPlan.mockImplementation(async () =>
      plan({ conflicts: [{ mod: "flib", code: "no_release", detail: "no release for Factorio 2.0" }] }),
    );
    expect(await refusal(apply())).toMatchObject({ status: 409, key: "mods_conflict" });
  });

  it("a basket that changes nothing", async () => {
    fakes.data.modsPlan.mockImplementation(async () => plan({ steps: [] }));
    expect(await refusal(apply())).toMatchObject({ status: 409, key: "mods_nothing_to_do" });
  });

  it("players online, unless forced", async () => {
    fakes.rcon.players = 2;
    expect(await refusal(apply())).toMatchObject({ status: 409, code: "players_online" });
    const op = await apply({ force: true });
    expect(await finish(op)).toMatchObject({ status: "success", forced: true });
  });

  it("an unknown game version", async () => {
    fakes.rcon.players = new Error("rcon down");
    expect(lastFactorioVersion()).toBeNull();
    expect(await refusal(apply())).toMatchObject({ status: 409, code: "factorio_version_unknown" });
  });

  it("no control agent to stop the server with", async () => {
    withEnv({ CONTROL_ENABLED: "false" });
    expect(await refusal(apply())).toMatchObject({ key: "control_disabled" });
    withEnv({ CONTROL_ENABLED: undefined });
  });

  it("another operation in progress", async () => {
    let release!: () => void;
    fakes.agent.stop.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ changed: true, container: container("exited") }))),
    );
    await requestOperation({ ...actor, type: "stop", force: false });
    expect(await refusal(apply())).toMatchObject({ status: 409, code: "operation_in_progress" });
    await vi.waitFor(() => expect(fakes.agent.stop).toHaveBeenCalled());
    release();
  });
});

describe("listing", () => {
  it("passes the version seen through RCON, and remembers it", async () => {
    const result = await listMods();
    expect(result).toMatchObject({ factorioVersion: "2.0.72", credentials: true, operation: null });
    expect(lastFactorioVersion()).toBe("2.0.72");

    // Server down: the remembered version still matches mods to the game.
    fakes.rcon.players = new Error("rcon down");
    resetFactorioVersionMemory();
    expect((await listMods()).factorioVersion).toBe("2.0.72");
  });
});
