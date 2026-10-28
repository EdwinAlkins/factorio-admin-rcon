import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WorldCatalogDto, WorldDto } from "@/lib/api-types";

const fakes = await vi.hoisted(async () => (await import("../control/fakes")).createFakes());

/** The world agent, as the panel's client sees it. */
const world = await vi.hoisted(async () => {
  const { vi } = await import("vitest");
  const state = {
    worlds: [] as WorldDto[],
    agentVersion: "2.0.72",
    preview: vi.fn(async (request: { seed?: number; size: number; planet: string; report: string[] }) => ({
      id: "f".repeat(32),
      seed: request.seed ?? 7,
      size: request.size,
      planet: request.planet,
      quantities: [],
    })),
    create: vi.fn(async (request: { name: string; seed?: number; createdBy: string }) => ({
      id: "20261028-090000",
      name: request.name,
      seed: request.seed ?? 7,
      createdAt: "2026-10-28T09:00:00Z",
      createdBy: request.createdBy,
      size: 1000,
      sha256: "a".repeat(64),
      settings: {},
      factorioVersion: "2.0.72",
      mods: [],
      preview: true,
    })),
    remove: vi.fn(async (id: string): Promise<void> => void id),
  };
  return state;
});

const CATALOG: WorldCatalogDto = {
  factorioVersion: "2.0.72",
  planets: [
    { name: "nauvis", controls: ["iron-ore"], resources: ["iron-ore", "coal"], climateControls: true },
    { name: "vulcanus", controls: ["tungsten_ore"], resources: ["tungsten-ore"], climateControls: false },
  ],
  controls: [],
  presets: [],
  mapSettings: {},
};

vi.mock("@/server/control/client", () => fakes.clientModule);
vi.mock("@/server/data/client", () => fakes.dataModule);
vi.mock("@/server/rcon", () => fakes.rconModule);
vi.mock("@/server/rcon/status", () => fakes.statusModule);
vi.mock("@/server/worlds/client", () => ({
  worldCatalog: async () => CATALOG,
  worldPreview: (request: Parameters<typeof world.preview>[0]) => world.preview(request),
  worldPreviewImage: async () => new Response("PNG", { headers: { "content-type": "image/png" } }),
  worldList: async () => ({ worlds: world.worlds, factorioVersion: world.agentVersion }),
  worldCreate: (request: Parameters<typeof world.create>[0]) => world.create(request),
  worldImage: async () => new Response("PNG", { headers: { "content-type": "image/png" } }),
  worldDownload: async () => new Response("ZIP", { headers: { "content-type": "application/zip", "content-length": "3" } }),
  worldDelete: (id: string) => world.remove(id),
  worldHealthy: async () => true,
}));

const worldsRoute = await import("@/app/api/worlds/route");
const { GET: catalogRoute } = await import("@/app/api/worlds/catalog/route");
const { POST: previewRoute } = await import("@/app/api/worlds/previews/route");
const { GET: previewImage } = await import("@/app/api/worlds/previews/[previewId]/route");
const { DELETE: remove } = await import("@/app/api/worlds/[id]/route");
const { GET: download } = await import("@/app/api/worlds/[id]/download/route");
const { POST: activate } = await import("@/app/api/worlds/[id]/activate/route");
const { currentOperation, timing, invalidateContainerCache } = await import("@/server/control/service");
const { getOperation } = await import("@/server/operations/store");
const { listAudit } = await import("@/server/audit/service");
const { resetLimiters } = await import("@/server/auth/limiters");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");
const { call, clearCookies, expectError, signIn } = await import("./helpers");

const ID = "20261028-090000";

/** The operation a 202 answer describes. */
const operationOf = (result: { body: Record<string, unknown> }) => getOperation((result.body.operation as { id: number }).id);

function worldDto(extra: Partial<WorldDto> = {}): WorldDto {
  return {
    id: ID,
    name: "Riche en fer",
    seed: 42,
    createdAt: "2026-10-28T09:00:00Z",
    size: 1000,
    sha256: "a".repeat(64),
    settings: {},
    factorioVersion: "2.0.72",
    mods: [{ name: "base" }, { name: "even-distribution", version: "2.0.3" }],
    preview: true,
    ...extra,
  };
}

beforeEach(() => {
  withEnv({ LOG_LEVEL: "error", WORLDS_ENABLED: undefined, SAVES_ENABLED: undefined });
  useMemoryDatabase();
  clearCookies();
  resetLimiters();
  fakes.reset();
  invalidateContainerCache();
  Object.assign(timing, { savePollMs: 1, rconPollMs: 1, rconWaitMs: 50 });
  world.worlds = [worldDto()];
  world.agentVersion = "2.0.72";
  world.preview.mockClear();
  world.create.mockClear();
  world.remove.mockClear();
});

afterEach(async () => {
  await currentOperation()?.done;
  withEnv({ LOG_LEVEL: undefined, WORLDS_ENABLED: undefined, SAVES_ENABLED: undefined });
  resetEnvCache();
});

describe("GET /api/worlds", () => {
  it("shows the library to moderators, not to viewers", async () => {
    signIn("viewer");
    expectError(await call(worldsRoute.GET, { path: "/api/worlds" }), 403, "forbidden");

    clearCookies();
    signIn("moderator");
    const result = await call(worldsRoute.GET, { path: "/api/worlds" });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      worlds: [{ id: ID }],
      agentVersion: "2.0.72",
      serverVersion: "2.0.72",
      operation: null,
    });
  });

  it("disappears with WORLDS_ENABLED=false", async () => {
    withEnv({ WORLDS_ENABLED: "false" });
    signIn("admin");
    expectError(await call(worldsRoute.GET, { path: "/api/worlds" }), 404, "world_disabled");
  });
});

describe("acting is for administrators", () => {
  it("refuses moderators everything but the library", async () => {
    signIn("moderator");
    expectError(await call(catalogRoute, { path: "/api/worlds/catalog" }), 403, "forbidden");
    expectError(await call(previewRoute, { method: "POST", path: "/api/worlds/previews", body: { settings: {} } }), 403, "forbidden");
    expectError(
      await call(worldsRoute.POST, { method: "POST", path: "/api/worlds", body: { name: "x", settings: {} } }),
      403,
      "forbidden",
    );
    expectError(await call(activate, { method: "POST", path: `/api/worlds/${ID}/activate`, body: {} }), 403, "forbidden");
    expectError(await call(remove, { method: "DELETE", path: `/api/worlds/${ID}` }), 403, "forbidden");
    expectError(await call(download, { path: `/api/worlds/${ID}/download` }), 403, "forbidden");
    expect(world.create).not.toHaveBeenCalled();
    expect(fakes.calls).toEqual([]);
  });
});

describe("POST /api/worlds/previews", () => {
  it("counts the planet's own resources", async () => {
    signIn("admin");
    const result = await call(previewRoute, {
      method: "POST",
      path: "/api/worlds/previews",
      body: { settings: { mapGen: { autoplace_controls: { tungsten_ore: { richness: 2 } } } }, planet: "vulcanus", size: 512 },
    });
    expect(result.status).toBe(200);
    expect(world.preview).toHaveBeenCalledWith(
      expect.objectContaining({ planet: "vulcanus", size: 512, report: ["tungsten-ore"], offset: { x: 0, y: 0 } }),
    );
  });

  it("refuses what the agent would refuse, without calling it", async () => {
    signIn("admin");
    for (const body of [
      { settings: { mapGen: { autoplace_controls: { coal: { size: 9 } } } } },
      { settings: { mapGen: { seed: 1 } } },
      { settings: { exchangeString: ">>>eNpjZGBk4GRgZWBlYGBm<<<", mapGen: {} } },
      { settings: {}, size: 300 },
      { settings: {}, planet: "../nauvis" },
      { settings: {}, seed: -1 },
    ]) {
      expectError(await call(previewRoute, { method: "POST", path: "/api/worlds/previews", body }), 400, "invalid_world_settings");
    }
    // A planet the game does not have.
    expectError(
      await call(previewRoute, { method: "POST", path: "/api/worlds/previews", body: { settings: {}, planet: "mars" } }),
      400,
      "invalid_body",
    );
    expect(world.preview).not.toHaveBeenCalled();
  });

  it("is bounded per session", async () => {
    signIn("admin");
    const send = () => call(previewRoute, { method: "POST", path: "/api/worlds/previews", body: { settings: {} } });
    for (let i = 0; i < 20; i++) expect((await send()).status).toBe(200);
    expectError(await send(), 429, "rate_limited_session");
  });

  it("serves the image and checks its id", async () => {
    signIn("admin");
    const image = await call(previewImage, { path: `/api/worlds/previews/${"f".repeat(32)}` });
    expect(image.status).toBe(200);
    expect(image.response.headers.get("content-type")).toBe("image/png");
    expectError(await call(previewImage, { path: "/api/worlds/previews/..%2f" }), 404, "preview_not_found");
  });
});

describe("POST /api/worlds", () => {
  it("creates a world and audits it", async () => {
    signIn("admin");
    const result = await call(worldsRoute.POST, {
      method: "POST",
      path: "/api/worlds",
      body: { name: "Rail", seed: 123, settings: { mapSettings: { enemy_expansion: { enabled: false } } } },
    });
    expect(result.status).toBe(201);
    expect(world.create).toHaveBeenCalledWith({
      name: "Rail",
      seed: 123,
      settings: { mapSettings: { enemy_expansion: { enabled: false } } },
      createdBy: "admin",
    });
    expect(listAudit()[0]).toMatchObject({ kind: "worlds", action: "create", status: "success" });
  });

  it("refuses a bad name or settings", async () => {
    signIn("admin");
    for (const body of [
      { name: "", settings: {} },
      { name: " padded", settings: {} },
      { name: "x".repeat(61), settings: {} },
      { name: "x", settings: { mapSettings: { enemy_expansion: { max_expansion_distance: 99 } } } },
      { name: "x", settings: {}, extra: true },
    ]) {
      expectError(await call(worldsRoute.POST, { method: "POST", path: "/api/worlds", body }), 400, "invalid_world_settings");
    }
    expect(world.create).not.toHaveBeenCalled();
  });
});

describe("POST /api/worlds/[id]/activate", () => {
  it("archives the world, then restores it like any archive", async () => {
    signIn("admin");
    const result = await call(activate, { method: "POST", path: `/api/worlds/${ID}/activate`, body: {} });
    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({ operation: { type: "world_activate", status: "running" } });
    await currentOperation()?.done;

    // The world is archived before the server is touched.
    const archived = fakes.calls.indexOf("data.archiveWorld");
    expect(archived).toBeGreaterThan(-1);
    expect(fakes.calls.slice(archived)).toEqual(
      expect.arrayContaining(["rcon:/server-save", "agent.stop", "data.create", "data.restore", "agent.start"]),
    );
    expect(fakes.calls.indexOf("agent.stop")).toBeGreaterThan(archived);
    expect(fakes.data.archiveWorld).toHaveBeenCalledWith(ID);
    expect(fakes.data.restore).toHaveBeenCalledWith("20261027-120000-world");
    expect(fakes.data.create).toHaveBeenCalledWith(expect.objectContaining({ source: "pre-restore" }));
    expect(operationOf(result)).toMatchObject({ status: "success" });
  });

  it("refuses a world made by another game version, unless forced", async () => {
    signIn("admin");
    world.worlds = [worldDto({ factorioVersion: "2.1.23" })];
    const refused = await call(activate, { method: "POST", path: `/api/worlds/${ID}/activate`, body: {} });
    expectError(refused, 409, "restore_incompatible");
    expect(fakes.data.archiveWorld).not.toHaveBeenCalled();

    const forced = await call(activate, { method: "POST", path: `/api/worlds/${ID}/activate`, body: { force: true } });
    expect(forced.status).toBe(202);
    await currentOperation()?.done;
    expect(fakes.data.restore).toHaveBeenCalled();
  });

  it("refuses with players online, unless forced", async () => {
    signIn("admin");
    fakes.rcon.players = 3;
    expectError(await call(activate, { method: "POST", path: `/api/worlds/${ID}/activate`, body: {} }), 409, "players_online");
    expect(fakes.agent.stop).not.toHaveBeenCalled();
  });

  it("disconnects no one when the world cannot be archived", async () => {
    signIn("admin");
    const { AgentError } = await import("@/server/agents/errors");
    fakes.data.archiveWorld.mockImplementation(async () => {
      throw new AgentError("checksum_mismatch");
    });
    const result = await call(activate, { method: "POST", path: `/api/worlds/${ID}/activate`, body: {} });
    expect(result.status).toBe(202);
    await currentOperation()?.done;
    expect(operationOf(result)).toMatchObject({ status: "error", errorCode: "checksum_mismatch" });
    expect(fakes.agent.stop).not.toHaveBeenCalled();
    expect(fakes.data.restore).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown or malformed world", async () => {
    signIn("admin");
    expectError(
      await call(activate, { method: "POST", path: "/api/worlds/20991231-235959/activate", body: {} }),
      404,
      "world_not_found",
    );
    expectError(await call(activate, { method: "POST", path: "/api/worlds/..%2fx/activate", body: {} }), 404, "world_not_found");
  });

  it("needs the data agent", async () => {
    withEnv({ SAVES_ENABLED: "false" });
    signIn("admin");
    expectError(await call(activate, { method: "POST", path: `/api/worlds/${ID}/activate`, body: {} }), 404, "data_disabled");
  });
});

describe("DELETE /api/worlds/[id]", () => {
  it("removes the world and audits it", async () => {
    signIn("admin");
    expect((await call(remove, { method: "DELETE", path: `/api/worlds/${ID}` })).status).toBe(200);
    expect(world.remove).toHaveBeenCalledWith(ID);
    expect(listAudit()[0]).toMatchObject({ kind: "worlds", action: "delete", status: "success", detail: ID });
  });
});

describe("GET /api/worlds/[id]/download", () => {
  it("streams the save as an attachment", async () => {
    signIn("admin");
    const result = await call(download, { path: `/api/worlds/${ID}/download` });
    expect(result.status).toBe(200);
    expect(result.response.headers.get("content-disposition")).toBe(`attachment; filename="factorio-world-${ID}.zip"`);
  });
});
