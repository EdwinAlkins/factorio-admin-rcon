import { describe, expect, it, vi } from "vitest";

/**
 * `next dev` routinely instantiates the same module twice: the metrics
 * collector and the API routes do not share a module graph, yet they share the
 * RCON service through `globalThis`. An error thrown on one side was then
 * unrecognisable on the other — `instanceof` compares class references — and
 * the panel answered "internal" (500) instead of the real code.
 *
 * `vi.resetModules()` reproduces the situation faithfully: the second `import`
 * builds a fresh copy of the module.
 */
async function twoInstances<T>(load: () => Promise<T>): Promise<[T, T]> {
  vi.resetModules();
  const first = await load();
  vi.resetModules();
  const second = await load();
  return [first, second];
}

describe("errors recognised across two copies of a module", () => {
  it("RconError: instanceof fails, the guard holds", async () => {
    const [a, b] = await twoInstances(() => import("@/server/rcon/errors"));

    expect(a.RconError).not.toBe(b.RconError);

    const error = new a.RconError("timeout", { detail: "trop lent" });
    // The original trap, reproduced as-is:
    expect(error instanceof b.RconError).toBe(false);
    // What the code now relies on:
    expect(b.isRconError(error)).toBe(true);
    expect(a.isRconError(error)).toBe(true);
  });

  it("ApiFailure and ConfigError too", async () => {
    const [ha, hb] = await twoInstances(() => import("@/server/http/errors"));
    expect(hb.isApiFailure(ha.ApiFailure.badRequest("invalid_arguments"))).toBe(true);

    const [ea, eb] = await twoInstances(() => import("@/server/config/env"));
    expect(eb.isConfigError(new ea.ConfigError("configuration invalide"))).toBe(true);
  });

  it("LuaTemplateError, shared between client and server", async () => {
    const [a, b] = await twoInstances(() => import("@/lib/lua-template"));
    expect(b.isLuaTemplateError(new a.LuaTemplateError("validation_number", "nan"))).toBe(true);
  });

  it("does not mistake just any error for an RCON error", async () => {
    const { isRconError } = await import("@/server/rcon/errors");

    expect(isRconError(new Error("banale"))).toBe(false);
    // An object that merely looks the part is not enough: the mark is a symbol
    // from the global registry, impossible to produce by accident.
    expect(isRconError({ name: "RconError", key: "timeout", code: "timeout" })).toBe(false);
    expect(isRconError(null)).toBe(false);
    expect(isRconError("timeout")).toBe(false);
  });
});
