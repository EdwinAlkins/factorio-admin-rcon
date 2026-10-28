/**
 * The keys of server-settings.json the panel edits, shared by the API's
 * validation and the form. The data agent holds the same table
 * (services/agents/internal/serversettings) and checks again: this one is
 * for refusing early and for drawing the form.
 */

export type ServerSettingKind = "text" | "longText" | "tags" | "int" | "bool" | "visibility" | "allowCommands";

export type ServerSettingGroup = "listing" | "access" | "saving" | "pause" | "network";

export type ServerSettingField = {
  key: string;
  kind: ServerSettingKind;
  group: ServerSettingGroup;
  min?: number;
  max?: number;
};

export const SERVER_SETTING_FIELDS = [
  { key: "name", kind: "text", group: "listing", max: 100 },
  { key: "description", kind: "longText", group: "listing", max: 5000 },
  { key: "tags", kind: "tags", group: "listing" },
  { key: "visibility", kind: "visibility", group: "listing" },
  { key: "username", kind: "text", group: "listing", max: 100 },
  { key: "max_players", kind: "int", group: "access", min: 0, max: 65535 },
  { key: "ignore_player_limit_for_returning_players", kind: "bool", group: "access" },
  { key: "require_user_verification", kind: "bool", group: "access" },
  { key: "allow_commands", kind: "allowCommands", group: "access" },
  { key: "afk_autokick_interval", kind: "int", group: "access", min: 0, max: 1440 },
  { key: "autosave_interval", kind: "int", group: "saving", min: 1, max: 1440 },
  { key: "autosave_slots", kind: "int", group: "saving", min: 1, max: 1000 },
  { key: "autosave_only_on_server", kind: "bool", group: "saving" },
  { key: "non_blocking_saving", kind: "bool", group: "saving" },
  { key: "auto_pause", kind: "bool", group: "pause" },
  { key: "auto_pause_when_players_connect", kind: "bool", group: "pause" },
  { key: "only_admins_can_pause_the_game", kind: "bool", group: "pause" },
  { key: "max_upload_in_kilobytes_per_second", kind: "int", group: "network", min: 0, max: 10_000_000 },
  { key: "max_upload_slots", kind: "int", group: "network", min: 0, max: 1000 },
  { key: "minimum_latency_in_ticks", kind: "int", group: "network", min: 0, max: 1000 },
  { key: "max_heartbeats_per_second", kind: "int", group: "network", min: 6, max: 240 },
  { key: "minimum_segment_size", kind: "int", group: "network", min: 1, max: 10_000 },
  { key: "minimum_segment_size_peer_count", kind: "int", group: "network", min: 1, max: 10_000 },
  { key: "maximum_segment_size", kind: "int", group: "network", min: 1, max: 10_000 },
  { key: "maximum_segment_size_peer_count", kind: "int", group: "network", min: 1, max: 10_000 },
] as const satisfies readonly ServerSettingField[];

export type ServerSettingKey = (typeof SERVER_SETTING_FIELDS)[number]["key"];

export const SERVER_SETTING_GROUPS: readonly ServerSettingGroup[] = ["listing", "access", "saving", "pause", "network"];

/** Written, never read back: the API only says whether each one is set. */
export const SERVER_SECRETS = ["game_password", "token", "password"] as const;
export type ServerSecretKey = (typeof SERVER_SECRETS)[number];

export const ALLOW_COMMANDS = ["true", "false", "admins-only"] as const;

export const SECRET_MAX = 200;
