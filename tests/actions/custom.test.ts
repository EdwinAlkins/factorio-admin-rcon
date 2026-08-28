import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { customActions, loadCustomCatalog, resetCustomCatalog } from "@/server/actions/custom";
import { schemaOf } from "@/server/actions/definitions";
import { findAction } from "@/server/actions/registry";
import { catalogFor } from "@/server/actions/service";
import type { Session } from "@/server/auth/session";
import type { Role } from "@/lib/permissions";
import { withEnv } from "../helpers";

let dir: string;
let file: string;

/** Writes the catalogue and clears the cache: the test always re-reads fresh. */
function write(catalog: unknown) {
  const source = typeof catalog === "string" ? catalog : JSON.stringify(catalog);
  writeFileSync(file, source, "utf8");
  resetCustomCatalog();
}

/** Validates the values then builds the command, as `executeAction` does. */
function build(id: string, values: Record<string, string>) {
  const action = findAction(id)!;
  const parsed = schemaOf(action).safeParse(values);
  if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => issue.message).join(" "));
  return action.build(parsed.data as Record<string, string>);
}

function session(role: Role): Session {
  return { id: "test", username: role, role } as Session;
}

const KILL_ENEMIES = {
  id: "kill-enemies",
  permission: "action:moderate",
  label: { en: "Kill all enemies", fr: "Tuer tous les ennemis" },
  params: [{ name: "player", type: "player" }],
  template:
    '/c for _, e in pairs(game.players[{{player}}].surface.find_entities_filtered({force = "enemy"})) do e.destroy() end',
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "factorio-commands-"));
  file = join(dir, "commands.json");
  // `warn` reports rejected entries: no need to see it scroll past here.
  withEnv({ CUSTOM_COMMANDS_FILE: file, LOG_LEVEL: "error" });
  resetCustomCatalog();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  withEnv({ CUSTOM_COMMANDS_FILE: undefined, LOG_LEVEL: undefined });
  resetCustomCatalog();
});

describe("loading the file", () => {
  it("does nothing when the file is absent", () => {
    expect(customActions()).toEqual([]);
    expect(loadCustomCatalog().error).toBeNull();
  });

  it("loads a command and prefixes its id", () => {
    write({ commands: [KILL_ENEMIES] });

    const actions = customActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe("custom:kill-enemies");
    // Deliberately strict default when the group is not declared.
    expect(actions[0].group).toBe("custom");
    expect(actions[0].confirm).toBe(true);
    expect(actions[0].risk).toBe("dangerous");
  });

  it("re-reads the file when it changes, without a restart", () => {
    write({ commands: [KILL_ENEMIES] });
    expect(customActions()).toHaveLength(1);

    const other = {
      ...KILL_ENEMIES,
      id: "kill-biters",
      params: [],
      template: '/c game.forces["enemy"].kill_all_units()',
    };
    write({ commands: [KILL_ENEMIES, other] });
    expect(customActions()).toHaveLength(2);
  });

  it("survives unreadable JSON, keeping the built-in actions", () => {
    write("{ ceci n'est pas du JSON");

    expect(customActions()).toEqual([]);
    expect(loadCustomCatalog().error).not.toBeNull();
    // The built-in actions are still served.
    expect(findAction("players-online")).toBeDefined();
  });

  it("skips a faulty entry without taking the others down", () => {
    write({ commands: [{ id: "cassée" }, KILL_ENEMIES] });

    expect(customActions()).toHaveLength(1);
    expect(loadCustomCatalog().rejected).toBe(1);
  });
});

describe("the shipped example catalogue", () => {
  it("loads with no rejection", () => {
    // `examples/commands.json` is executable documentation: a typo in it would
    // otherwise only show up on deployment day.
    withEnv({ CUSTOM_COMMANDS_FILE: join(process.cwd(), "examples/commands.json") });
    resetCustomCatalog();

    const catalog = loadCustomCatalog();
    expect(catalog.error).toBeNull();
    expect(catalog.rejected).toBe(0);
    expect(catalog.actions.length).toBeGreaterThan(0);
  });
});

describe("entry validation", () => {
  const rejects = (command: Record<string, unknown>) => {
    write({ commands: [{ ...KILL_ENEMIES, ...command }] });
    expect(customActions()).toEqual([]);
    expect(loadCustomCatalog().rejected).toBe(1);
  };

  it("refuses a template referencing an undeclared parameter", () => {
    rejects({ template: "/c game.players[{{ghost}}]" });
  });

  it("refuses a template containing a Lua comment", () => {
    // Line breaks being flattened, "--" would swallow what follows.
    rejects({ template: "/c game.print(1) -- note" });
  });

  it("refuses a template longer than an RCON frame", () => {
    rejects({ template: `/c rcon.print("${"a".repeat(4100)}")`, params: [] });
  });

  it("refuses an enum with no list of values", () => {
    rejects({ params: [{ name: "player", type: "enum" }] });
  });

  it("refuses a non-textual optional field with no default", () => {
    rejects({
      params: [
        { name: "player", type: "player" },
        { name: "radius", type: "int", required: false },
      ],
      template: "/c local r = {{radius}} game.players[{{player}}].print(r)",
    });
  });

  it("refuses a default that would not pass validation", () => {
    rejects({
      params: [
        { name: "player", type: "player" },
        { name: "radius", type: "int", required: false, max: 10, default: "9999" },
      ],
      template: "/c local r = {{radius}} game.players[{{player}}].print(r)",
    });
  });

  it("refuses two commands sharing an id", () => {
    write({ commands: [KILL_ENEMIES, KILL_ENEMIES] });
    expect(customActions()).toHaveLength(1);
    expect(loadCustomCatalog().rejected).toBe(1);
  });
});

describe("building the commands", () => {
  it("inserts a player name as a Lua literal", () => {
    write({ commands: [KILL_ENEMIES] });

    expect(build("custom:kill-enemies", { player: "Edwins" })).toBe(
      '/c for _, e in pairs(game.players["Edwins"].surface.find_entities_filtered({force = "enemy"})) do e.destroy() end',
    );
  });

  it("refuses input trying to break out of the Lua string", () => {
    write({ commands: [KILL_ENEMIES] });

    expect(() => build("custom:kill-enemies", { player: 'x"] rcon.print("pwned") [' })).toThrow(
      /validation_player/,
    );
  });

  it("escapes quotes in a text field instead of refusing them", () => {
    write({
      commands: [
        {
          ...KILL_ENEMIES,
          id: "say",
          params: [{ name: "note", type: "text" }],
          template: "/c rcon.print({{note}})",
        },
      ],
    });

    expect(build("custom:say", { note: 'il a dit "non"' })).toBe(
      '/c rcon.print("il a dit \\"non\\"")',
    );
  });

  it("applies a number's bounds and default", () => {
    write({
      commands: [
        {
          ...KILL_ENEMIES,
          id: "radius",
          params: [
            { name: "player", type: "player" },
            { name: "radius", type: "int", required: false, min: 1, max: 2000, default: "250" },
          ],
          template: "/c local r = {{radius}} game.players[{{player}}].print(r)",
        },
      ],
    });

    expect(build("custom:radius", { player: "Edwins", radius: "" })).toContain("local r = 250");
    expect(build("custom:radius", { player: "Edwins", radius: "10" })).toContain("local r = 10");
    expect(() => build("custom:radius", { player: "Edwins", radius: "9999" })).toThrow(
      /validation_max/,
    );
    expect(() => build("custom:radius", { player: "Edwins", radius: "1.5" })).toThrow(
      /validation_number/,
    );
  });

  it("accepts only the values in an enum's list", () => {
    write({
      commands: [
        {
          ...KILL_ENEMIES,
          id: "quality",
          params: [{ name: "quality", type: "enum", options: ["normal", "legendary"] }],
          template: "/c rcon.print({{quality}})",
        },
      ],
    });

    expect(build("custom:quality", { quality: "legendary" })).toBe('/c rcon.print("legendary")');
    expect(() => build("custom:quality", { quality: "mythic" })).toThrow(/validation_enum/);
  });

  it("refuses a required field left empty", () => {
    write({ commands: [KILL_ENEMIES] });
    expect(() => build("custom:kill-enemies", {})).toThrow(/validation_required/);
  });
});

describe("the catalogue served to the interface", () => {
  it("hides from a moderator what is not explicitly opened", () => {
    write({
      commands: [
        KILL_ENEMIES,
        {
          ...KILL_ENEMIES,
          id: "give-item",
          permission: undefined,
          params: [],
          template: "/c 1",
        },
      ],
    });

    const ids = catalogFor(session("moderator")).map((action) => action.id);
    expect(ids).toContain("custom:kill-enemies");
    expect(ids).not.toContain("custom:give-item");

    expect(catalogFor(session("admin")).map((action) => action.id)).toContain("custom:give-item");
  });

  it("carries its text in the requested locale, falling back to English", () => {
    write({ commands: [KILL_ENEMIES] });

    const fr = catalogFor(session("admin"), "fr").find((a) => a.id === "custom:kill-enemies")!;
    expect(fr.text?.label).toBe("Tuer tous les ennemis");

    const de = catalogFor(session("admin"), "de").find((a) => a.id === "custom:kill-enemies")!;
    expect(de.text?.label).toBe("Kill all enemies");
  });

  it("sends the template for the preview and describes the fields", () => {
    write({ commands: [KILL_ENEMIES] });

    const action = catalogFor(session("admin")).find((a) => a.id === "custom:kill-enemies")!;
    expect(action.template).toBe(KILL_ENEMIES.template);
    expect(action.fields).toEqual([{ name: "player", required: true, kind: "player" }]);
  });

  it("leaves built-in actions without text, resolved on the interface", () => {
    const action = catalogFor(session("admin")).find((a) => a.id === "kick")!;
    expect(action.text).toBeUndefined();
    expect(action.template).toBeUndefined();
  });
});
