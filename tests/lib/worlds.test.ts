import { describe, expect, it } from "vitest";
import { compact, prettyName, randomSeed, rawValue, requestSettings, RULE_FIELDS, shownValue } from "@/lib/worlds";
import { agentErrorParams, fromAgentCode } from "@/server/agents/errors";
import en from "../../messages/en.json";

const field = (group: string, key: string) => RULE_FIELDS.find((candidate) => candidate.group === group && candidate.key === key)!;

describe("world settings sent", () => {
  it("drops what the operator emptied, keeps falsy values", () => {
    expect(
      compact({
        mapGen: { autoplace_controls: { coal: {}, "iron-ore": { size: 0 } }, peaceful_mode: false },
        mapSettings: { pollution: {} },
      }),
    ).toEqual({ mapGen: { autoplace_controls: { "iron-ore": { size: 0 } }, peaceful_mode: false } });
    expect(compact({})).toBeUndefined();
  });

  it("sends the exchange string alone when there is one", () => {
    const settings = { mapGen: { width: 100 } };
    expect(requestSettings(settings, "  >>>abc<<<\n")).toEqual({ exchangeString: ">>>abc<<<" });
    expect(requestSettings(settings, " ")).toEqual(settings);
    expect(requestSettings({}, "")).toEqual({});
  });
});

describe("rule fields", () => {
  it("shows values the way the game's dialog does, and stores them raw", () => {
    const time = field("enemy_evolution", "time_factor");
    expect(shownValue(time, 0.000004)).toBe(40);
    expect(rawValue(time, 40)).toBe(0.000004);

    const cooldown = field("enemy_expansion", "min_expansion_cooldown");
    expect(shownValue(cooldown, 14400)).toBe(4);
    expect(rawValue(cooldown, 4)).toBe(14400);

    const diffusion = field("pollution", "diffusion_ratio");
    expect(shownValue(diffusion, 0.02)).toBe(2);
    expect(rawValue(diffusion, 2)).toBe(0.02);
  });

  it("has a label for every field", () => {
    const rules = en.worlds.rules as unknown as Record<string, Record<string, string>>;
    for (const rule of RULE_FIELDS) {
      expect(rules[rule.group]?.[rule.key], `${rule.group}.${rule.key}`).toBeTypeOf("string");
    }
  });
});

describe("names", () => {
  it("makes a mod's prototype names readable", () => {
    expect(prettyName("tungsten_ore")).toBe("Tungsten ore");
    expect(prettyName("my-mod-ore")).toBe("My mod ore");
  });

  it("draws seeds in the game's range", () => {
    for (let i = 0; i < 20; i++) {
      const seed = randomSeed();
      expect(Number.isInteger(seed) && seed >= 0 && seed <= 0xffff_ffff).toBe(true);
    }
  });
});

describe("world agent errors", () => {
  it("maps its codes, and passes the game's refusal on as the reason", () => {
    expect(fromAgentCode("world", "factorio_refused", 422)).toBe("factorio_refused");
    expect(fromAgentCode("world", "busy", 409)).toBe("world_busy");
    expect(fromAgentCode("world", "io_error", 500)).toBe("world_io");
    expect(fromAgentCode("world", "something_new", 400)).toBe("world_protocol");
    expect(fromAgentCode("world", undefined, 503)).toBe("world_io");
    expect(agentErrorParams("factorio_refused", '"nope" is not a valid autoplace control name.')).toEqual({
      reason: '"nope" is not a valid autoplace control name.',
    });
    // Other refusals keep their message in the logs only.
    expect(agentErrorParams("world_io", "/tmp/world-agent: read-only")).toBeUndefined();
  });

  it("maps the data agent's world codes", () => {
    expect(fromAgentCode("data", "world_not_found", 404)).toBe("world_not_found");
    expect(fromAgentCode("data", "worlds_unavailable", 404)).toBe("worlds_unavailable");
  });
});
