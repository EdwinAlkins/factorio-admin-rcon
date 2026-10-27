import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakes = await vi.hoisted(async () => (await import("../control/fakes")).createFakes());

vi.mock("@/server/control/client", () => fakes.clientModule);
vi.mock("@/server/data/client", () => fakes.dataModule);
vi.mock("@/server/rcon", () => fakes.rconModule);
vi.mock("@/server/rcon/status", () => fakes.statusModule);

const { POST: begin } = await import("@/app/api/saves/uploads/route");
const chunkRoute = await import("@/app/api/saves/uploads/[uploadId]/route");
const { POST: complete } = await import("@/app/api/saves/uploads/[uploadId]/complete/route");
const { currentOperation, invalidateContainerCache } = await import("@/server/control/service");
const { getOperation } = await import("@/server/operations/store");
const { listAudit } = await import("@/server/audit/service");
const { resetEnvCache, useMemoryDatabase, withEnv } = await import("../helpers");
const { call, clearCookies, expectError, signIn } = await import("./helpers");

const UPLOAD = "a".repeat(32);
const PATH = `/api/saves/uploads/${UPLOAD}`;
const octets = { "content-type": "application/octet-stream" };

beforeEach(() => {
  withEnv({ LOG_LEVEL: "error", SAVES_ENABLED: undefined });
  useMemoryDatabase();
  clearCookies();
  fakes.reset();
  invalidateContainerCache();
});

afterEach(async () => {
  await currentOperation()?.done;
  withEnv({ LOG_LEVEL: undefined, SAVES_ENABLED: undefined });
  resetEnvCache();
});

describe("uploads are for administrators", () => {
  it("refuses moderators", async () => {
    signIn("moderator");
    const body = { size: 10, name: "map.zip" };
    expectError(await call(begin, { method: "POST", path: "/api/saves/uploads", body }), 403, "forbidden");
    expectError(await call(chunkRoute.PUT, { method: "PUT", path: `${PATH}?offset=0`, raw: "x", headers: octets }), 403, "forbidden");
    expectError(await call(complete, { method: "POST", path: `${PATH}/complete`, body: {} }), 403, "forbidden");
  });
});

describe("POST /api/saves/uploads", () => {
  it("opens an upload and audits it", async () => {
    signIn("admin");
    const result = await call(begin, { method: "POST", path: "/api/saves/uploads", body: { size: 10, name: "map.zip" } });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ ok: true, upload: { id: UPLOAD, offset: 0, size: 10 }, chunkBytes: 8 << 20 });
    expect(listAudit()[0]).toMatchObject({ kind: "saves", action: "upload", status: "success", detail: "map.zip 10 B" });
  });

  it("refuses malformed bodies", async () => {
    signIn("admin");
    for (const body of [{}, { size: 0, name: "x.zip" }, { size: 1.5, name: "x.zip" }, { size: 10, name: "a\nb" }, { size: 10, name: "x", path: "/" }]) {
      expectError(await call(begin, { method: "POST", path: "/api/saves/uploads", body }), 400, "invalid_body");
    }
  });
});

describe("PUT /api/saves/uploads/[uploadId]", () => {
  it("passes the chunk and its offset on", async () => {
    signIn("admin");
    const result = await call(chunkRoute.PUT, { method: "PUT", path: `${PATH}?offset=4`, raw: "abcd", headers: octets });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ upload: { offset: 8 } });
    expect(fakes.calls).toEqual(["data.uploadChunk"]);
  });

  it("validates the id, the offset and the size before reaching the agent", async () => {
    signIn("admin");
    for (const path of ["/api/saves/uploads/../x?offset=0", "/api/saves/uploads/ABC?offset=0"]) {
      expectError(await call(chunkRoute.PUT, { method: "PUT", path, raw: "x", headers: octets }), 404, "upload_not_found");
    }
    for (const query of ["", "?offset=-1", "?offset=1.5", "?offset=x"]) {
      expectError(await call(chunkRoute.PUT, { method: "PUT", path: PATH + query, raw: "x", headers: octets }), 400, "invalid_body");
    }
    expectError(await call(chunkRoute.PUT, { method: "PUT", path: `${PATH}?offset=0`, raw: "", headers: octets }), 400, "invalid_body");
    expectError(
      await call(chunkRoute.PUT, {
        method: "PUT",
        path: `${PATH}?offset=0`,
        raw: "x".repeat((8 << 20) + 1),
        headers: octets,
      }),
      413,
      "body_too_large",
    );
    expect(fakes.calls).toEqual([]);
  });
});

describe("POST /api/saves/uploads/[uploadId]/complete", () => {
  it("publishes the upload as an operation, and audits the archive", async () => {
    signIn("admin");
    const result = await call(complete, { method: "POST", path: `${PATH}/complete`, body: { label: "laptop" } });
    expect(result.status).toBe(202);

    await currentOperation()?.done;
    const operation = getOperation((result.body.operation as { id: number }).id)!;
    expect(operation).toMatchObject({ type: "import", status: "success" });
    expect(fakes.data.uploadComplete).toHaveBeenCalledWith(UPLOAD);
    expect(listAudit()[0]).toMatchObject({ kind: "saves", action: "import", status: "success" });
    expect(listAudit()[0].detail).toContain("20261027-120000-upload");
  });

  it("refuses an upload not fully received, before any operation", async () => {
    signIn("admin");
    fakes.data.uploadOffset.mockImplementation(async (id: string) => ({ upload: { id, offset: 5, size: 10 }, chunkBytes: 8 << 20 }));
    expectError(await call(complete, { method: "POST", path: `${PATH}/complete`, body: {} }), 409, "upload_incomplete");
    expect(fakes.data.uploadComplete).not.toHaveBeenCalled();
    expect(listAudit()[0]).toMatchObject({ action: "import", status: "denied", detail: "upload_incomplete" });
  });
});

describe("DELETE /api/saves/uploads/[uploadId]", () => {
  it("drops the upload and audits it", async () => {
    signIn("admin");
    const result = await call(chunkRoute.DELETE, { method: "DELETE", path: PATH });
    expect(result.status).toBe(200);
    expect(listAudit()[0]).toMatchObject({ action: "upload_abort", status: "success", detail: UPLOAD });
  });
});
