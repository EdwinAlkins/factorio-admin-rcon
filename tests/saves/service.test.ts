import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = await vi.hoisted(async () => (await import("../control/fakes")).createFakes());

vi.mock("@/server/control/client", () => fakes.clientModule);
vi.mock("@/server/data/client", () => fakes.dataModule);
vi.mock("@/server/rcon", () => fakes.rconModule);
vi.mock("@/server/rcon/status", () => fakes.statusModule);

const { backup, container, MODS } = await import("../control/fakes");
const { compatibilityGaps, requestBackup, requestRestore, backupSettings, updateBackupSettings } = await import(
  "@/server/saves/service"
);
const { isDue, schedulerTick } = await import("@/server/saves/scheduler");
const { currentOperation, requestOperation, timing, invalidateContainerCache } = await import("@/server/control/service");
const { getOperation } = await import("@/server/operations/store");
const { AgentError } = await import("@/server/agents/errors");
const { listAudit } = await import("@/server/audit/service");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");

const actor = { username: "admin", role: "admin", ip: null, requestId: "req" };
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
  return error as { status: number; code?: string; key?: string; params?: Record<string, unknown> };
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
  resetEnvCache();
});

describe("backup", () => {
  it("saves first on a running server, and records its version", async () => {
    const op = await requestBackup({ ...actor, source: "manual", label: "x", triggerSave: true });
    expect((await finish(op)).status).toBe("success");

    expect(fakes.calls).toEqual(["agent.status", "rcon:/server-save", "agent.logs", "data.create"]);
    expect(fakes.data.create).toHaveBeenCalledWith(
      expect.objectContaining({ source: "manual", label: "x", createdBy: "admin", factorioVersion: "2.0.72" }),
    );
    expect(listAudit()[0]).toMatchObject({ kind: "saves", action: "backup", status: "success" });
  });

  it("archives the newest file as is when the server is stopped", async () => {
    fakes.agent.status.mockImplementation(async () => container("exited"));
    const op = await requestBackup({ ...actor, source: "manual", triggerSave: true });
    expect((await finish(op)).status).toBe("success");
    expect(fakes.rcon.execute).not.toHaveBeenCalled();
  });

  it("does not freeze the game for a scheduled run unless asked", async () => {
    const op = await requestBackup({ ...actor, source: "scheduled", triggerSave: false });
    await finish(op);
    expect(fakes.rcon.execute).not.toHaveBeenCalled();
    expect(fakes.data.create).toHaveBeenCalledOnce();
  });

  it("shares the lock with server operations", async () => {
    let release!: () => void;
    fakes.agent.stop.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ changed: true, container: container("exited") }))),
    );
    await requestOperation({ ...actor, type: "stop", force: false });

    const error = await refusal(requestBackup({ ...actor, source: "manual", triggerSave: true }));
    expect(error).toMatchObject({ status: 409, code: "operation_in_progress" });

    await vi.waitFor(() => expect(fakes.agent.stop).toHaveBeenCalled());
    release();
  });
});

describe("restore", () => {
  const ID = "20261027-100000-manual";

  it("saves, stops, takes a safety copy, restores, then restarts", async () => {
    const op = await requestRestore({ ...actor, id: ID, force: false });
    const done = await finish(op);

    expect(done.status).toBe("success");
    expect(fakes.calls).toEqual([
      "data.backups",
      "data.verify",
      "agent.status",
      "data.saves",
      "rcon:/server-save",
      "agent.logs",
      "agent.stop",
      "rcon.disconnect",
      "data.create",
      "data.restore",
      "agent.start",
    ]);
    expect(fakes.data.create).toHaveBeenCalledWith(expect.objectContaining({ source: "pre-restore" }));
    expect(fakes.data.restore).toHaveBeenCalledWith(ID);
  });

  it("leaves a stopped server stopped", async () => {
    fakes.agent.status.mockImplementation(async () => container("exited"));
    await finish(await requestRestore({ ...actor, id: ID, force: false }));
    expect(fakes.agent.stop).not.toHaveBeenCalled();
    expect(fakes.agent.start).not.toHaveBeenCalled();
    expect(fakes.data.restore).toHaveBeenCalledWith(ID);
  });

  it("refuses an archive from another game, unless forced", async () => {
    fakes.data.backups = [backup(ID, { factorioVersion: "1.1.110" })];

    const error = await refusal(requestRestore({ ...actor, id: ID, force: false }));
    expect(error).toMatchObject({ status: 409, code: "restore_incompatible" });
    expect(String(error.params?.gaps)).toContain("1.1.110 → 2.0.72");
    expect(fakes.agent.stop).not.toHaveBeenCalled();

    expect((await finish(await requestRestore({ ...actor, id: ID, force: true }))).status).toBe("success");
  });

  it("refuses while players are online, unless forced", async () => {
    fakes.rcon.players = 1;
    const error = await refusal(requestRestore({ ...actor, id: ID, force: false }));
    expect(error).toMatchObject({ status: 409, code: "players_online" });
  });

  it("refuses an unknown archive", async () => {
    const error = await refusal(requestRestore({ ...actor, id: "20261027-100000-scheduled", force: false }));
    expect(error).toMatchObject({ status: 404, key: "backup_not_found" });
  });

  it("rolls back to the safety copy when the server does not come back", async () => {
    let probes = 0;
    // RCON answers for the pre-checks, never after the restore, then again
    // once the safety copy is back.
    fakes.rcon.healthCheck.mockImplementation(async () => ({ ok: ++probes > 1000 }));
    fakes.data.restore.mockImplementation(async (id: string) => {
      if (id.endsWith("pre-restore")) probes = 2000;
      return { saveName: "_autosave1.zip", replaced: [] };
    });

    const done = await finish(await requestRestore({ ...actor, id: ID, force: false }));
    expect(done).toMatchObject({ status: "error", errorCode: "restore_rolled_back" });
    expect(fakes.data.restore.mock.calls.map(([id]) => id)).toEqual([ID, "20261027-120000-pre-restore"]);
  });

  it("says so when the rollback itself fails", async () => {
    fakes.rcon.healthCheck.mockImplementation(async () => ({ ok: false }));
    const done = await finish(await requestRestore({ ...actor, id: ID, force: false }));
    expect(done).toMatchObject({ status: "error", errorCode: "restore_rollback_failed" });
  });

  it("refuses a damaged archive before touching the server", async () => {
    fakes.data.verify.mockImplementation(async () => {
      throw new AgentError("checksum_mismatch");
    });
    const error = await refusal(requestRestore({ ...actor, id: ID, force: true }));
    expect(error).toMatchObject({ status: 422, key: "checksum_mismatch" });
    expect(fakes.agent.stop).not.toHaveBeenCalled();
    expect(fakes.rcon.execute).not.toHaveBeenCalled();
  });

  it("does not roll back when the agent refused the archive before touching files", async () => {
    fakes.data.restore.mockImplementation(async () => {
      throw new AgentError("checksum_mismatch");
    });
    const done = await finish(await requestRestore({ ...actor, id: ID, force: false }));
    expect(done).toMatchObject({ status: "error", errorCode: "checksum_mismatch" });
    expect(fakes.data.restore).toHaveBeenCalledOnce();
    expect(fakes.agent.start).toHaveBeenCalledOnce();
  });

  it("goes on without a safety copy when there was no save", async () => {
    fakes.data.create.mockImplementation(async () => {
      throw new AgentError("no_save");
    });
    expect((await finish(await requestRestore({ ...actor, id: ID, force: false }))).status).toBe("success");
  });
});

describe("compatibilityGaps", () => {
  it("lists version and mod differences", () => {
    const archive = backup("x", {
      factorioVersion: "2.0.70",
      mods: [...MODS, { name: "old-mod", enabled: true, version: "1.0.0", builtin: false }],
    });
    const now = [
      { name: "base", enabled: true, builtin: true },
      { name: "even-distribution", enabled: true, version: "2.0.4", builtin: false },
      { name: "new-mod", enabled: true, version: "0.1.0", builtin: false },
    ];
    expect(compatibilityGaps(archive, "2.0.72", now)).toEqual([
      "Factorio 2.0.70 → 2.0.72",
      "even-distribution 2.0.3 → 2.0.4",
      "−old-mod",
      "+new-mod",
    ]);
    expect(compatibilityGaps(backup("y"), "2.0.72", MODS)).toEqual([]);
    expect(compatibilityGaps(backup("z", { mods: [] }), undefined, MODS)).toEqual([]);
  });
});

describe("scheduler", () => {
  it.each([
    [{ enabled: false, intervalMinutes: 60, lastRunAt: null }, false],
    [{ enabled: true, intervalMinutes: 60, lastRunAt: null }, true],
    [{ enabled: true, intervalMinutes: 60, lastRunAt: 1_000_000 - 59 * 60_000 }, false],
    [{ enabled: true, intervalMinutes: 60, lastRunAt: 1_000_000 - 60 * 60_000 }, true],
  ])("isDue(%o) = %s", (settings, expected) => {
    expect(isDue(settings, 1_000_000)).toBe(expected);
  });

  it("archives, then prunes, when due", async () => {
    updateBackupSettings({ enabled: true, intervalMinutes: 60, keepLast: 5, maxAgeDays: 0, triggerSave: false }, "admin");

    await schedulerTick(1_000_000);

    expect(fakes.data.create).toHaveBeenCalledWith(expect.objectContaining({ source: "scheduled", createdBy: "scheduler" }));
    expect(fakes.data.prune).toHaveBeenCalledTimes(2);
    expect(backupSettings().lastRunAt).toBe(1_000_000);

    // Not due again a minute later.
    await schedulerTick(1_060_000);
    expect(fakes.data.create).toHaveBeenCalledOnce();
  });

  it("waits for a running operation instead of skipping the run", async () => {
    updateBackupSettings({ enabled: true, intervalMinutes: 60, keepLast: 0, maxAgeDays: 0, triggerSave: false }, "admin");
    let release!: () => void;
    fakes.agent.stop.mockImplementation(
      () => new Promise((resolve) => (release = () => resolve({ changed: true, container: container("exited") }))),
    );
    await requestOperation({ ...actor, type: "stop", force: false });

    await schedulerTick(1_000_000);
    expect(fakes.data.create).not.toHaveBeenCalled();
    expect(backupSettings().lastRunAt).toBeNull();

    await vi.waitFor(() => expect(fakes.agent.stop).toHaveBeenCalled());
    release();
    await currentOperation()?.done;
    await schedulerTick(1_000_000);
    expect(fakes.data.create).toHaveBeenCalledOnce();
  });
});
