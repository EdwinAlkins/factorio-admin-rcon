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

/** Écrit le catalogue et vide le cache : le test relit toujours du neuf. */
function write(catalog: unknown) {
  const source = typeof catalog === "string" ? catalog : JSON.stringify(catalog);
  writeFileSync(file, source, "utf8");
  resetCustomCatalog();
}

/** Valide les valeurs puis construit la commande, comme le fait `executeAction`. */
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
  // `warn` sert à signaler les entrées rejetées : inutile de le voir passer ici.
  withEnv({ CUSTOM_COMMANDS_FILE: file, LOG_LEVEL: "error" });
  resetCustomCatalog();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  withEnv({ CUSTOM_COMMANDS_FILE: undefined, LOG_LEVEL: undefined });
  resetCustomCatalog();
});

describe("chargement du fichier", () => {
  it("ne fait rien quand le fichier est absent", () => {
    expect(customActions()).toEqual([]);
    expect(loadCustomCatalog().error).toBeNull();
  });

  it("charge une commande et préfixe son identifiant", () => {
    write({ commands: [KILL_ENEMIES] });

    const actions = customActions();
    expect(actions).toHaveLength(1);
    expect(actions[0].id).toBe("custom:kill-enemies");
    // Défaut volontairement strict quand le groupe n'est pas déclaré.
    expect(actions[0].group).toBe("custom");
    expect(actions[0].confirm).toBe(true);
    expect(actions[0].risk).toBe("dangerous");
  });

  it("relit le fichier quand il change, sans redémarrage", () => {
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

  it("survit à un JSON illisible en gardant les actions intégrées", () => {
    write("{ ceci n'est pas du JSON");

    expect(customActions()).toEqual([]);
    expect(loadCustomCatalog().error).not.toBeNull();
    // Les actions intégrées restent servies.
    expect(findAction("players-online")).toBeDefined();
  });

  it("ignore une entrée fautive sans emporter les autres", () => {
    write({ commands: [{ id: "cassée" }, KILL_ENEMIES] });

    expect(customActions()).toHaveLength(1);
    expect(loadCustomCatalog().rejected).toBe(1);
  });
});

describe("catalogue d'exemple livré", () => {
  it("charge sans rejet", () => {
    // `examples/commands.json` est de la documentation exécutable : une faute de
    // frappe s'y verrait autrement le jour du déploiement.
    withEnv({ CUSTOM_COMMANDS_FILE: join(process.cwd(), "examples/commands.json") });
    resetCustomCatalog();

    const catalog = loadCustomCatalog();
    expect(catalog.error).toBeNull();
    expect(catalog.rejected).toBe(0);
    expect(catalog.actions.length).toBeGreaterThan(0);
  });
});

describe("validation des entrées", () => {
  const rejects = (command: Record<string, unknown>) => {
    write({ commands: [{ ...KILL_ENEMIES, ...command }] });
    expect(customActions()).toEqual([]);
    expect(loadCustomCatalog().rejected).toBe(1);
  };

  it("refuse un gabarit qui référence un paramètre non déclaré", () => {
    rejects({ template: "/c game.players[{{ghost}}]" });
  });

  it("refuse un gabarit contenant un commentaire Lua", () => {
    // Les retours à la ligne étant aplatis, « -- » avalerait la suite.
    rejects({ template: "/c game.print(1) -- note" });
  });

  it("refuse un gabarit plus long que la trame RCON", () => {
    rejects({ template: `/c rcon.print("${"a".repeat(4100)}")`, params: [] });
  });

  it("refuse un enum sans liste de valeurs", () => {
    rejects({ params: [{ name: "player", type: "enum" }] });
  });

  it("refuse un champ facultatif non textuel sans valeur par défaut", () => {
    rejects({
      params: [
        { name: "player", type: "player" },
        { name: "radius", type: "int", required: false },
      ],
      template: "/c local r = {{radius}} game.players[{{player}}].print(r)",
    });
  });

  it("refuse une valeur par défaut qui ne passerait pas la validation", () => {
    rejects({
      params: [
        { name: "player", type: "player" },
        { name: "radius", type: "int", required: false, max: 10, default: "9999" },
      ],
      template: "/c local r = {{radius}} game.players[{{player}}].print(r)",
    });
  });

  it("refuse deux commandes portant le même identifiant", () => {
    write({ commands: [KILL_ENEMIES, KILL_ENEMIES] });
    expect(customActions()).toHaveLength(1);
    expect(loadCustomCatalog().rejected).toBe(1);
  });
});

describe("construction des commandes", () => {
  it("insère un nom de joueur sous forme de littéral Lua", () => {
    write({ commands: [KILL_ENEMIES] });

    expect(build("custom:kill-enemies", { player: "Edwins" })).toBe(
      '/c for _, e in pairs(game.players["Edwins"].surface.find_entities_filtered({force = "enemy"})) do e.destroy() end',
    );
  });

  it("refuse une saisie qui tenterait de sortir de la chaîne Lua", () => {
    write({ commands: [KILL_ENEMIES] });

    expect(() => build("custom:kill-enemies", { player: 'x"] rcon.print("pwned") [' })).toThrow(
      /validation_player/,
    );
  });

  it("échappe les guillemets d'un champ texte au lieu de les refuser", () => {
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

  it("applique les bornes et la valeur par défaut d'un nombre", () => {
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

  it("n'accepte d'un enum que les valeurs de sa liste", () => {
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

  it("refuse un champ obligatoire laissé vide", () => {
    write({ commands: [KILL_ENEMIES] });
    expect(() => build("custom:kill-enemies", {})).toThrow(/validation_required/);
  });
});

describe("catalogue servi à l'interface", () => {
  it("masque au modérateur ce qui n'est pas explicitement ouvert", () => {
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

  it("porte son texte dans la locale demandée, avec repli anglais", () => {
    write({ commands: [KILL_ENEMIES] });

    const fr = catalogFor(session("admin"), "fr").find((a) => a.id === "custom:kill-enemies")!;
    expect(fr.text?.label).toBe("Tuer tous les ennemis");

    const de = catalogFor(session("admin"), "de").find((a) => a.id === "custom:kill-enemies")!;
    expect(de.text?.label).toBe("Kill all enemies");
  });

  it("transmet le gabarit pour l'aperçu et décrit les champs", () => {
    write({ commands: [KILL_ENEMIES] });

    const action = catalogFor(session("admin")).find((a) => a.id === "custom:kill-enemies")!;
    expect(action.template).toBe(KILL_ENEMIES.template);
    expect(action.fields).toEqual([{ name: "player", required: true, kind: "player" }]);
  });

  it("laisse les actions intégrées sans texte, résolu côté interface", () => {
    const action = catalogFor(session("admin")).find((a) => a.id === "kick")!;
    expect(action.text).toBeUndefined();
    expect(action.template).toBeUndefined();
  });
});
