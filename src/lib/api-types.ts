import type { Permission, Role } from "@/lib/permissions";

/** Contract of the JSON responses, shared by the routes and the components. */

/** Values injected into the translated message (`{seconds}`, `{field}`…). */
export type ErrorParams = Record<string, string | number>;

/**
 * `code` is the translation key (`errors.<code>` in the dictionaries) and is
 * authoritative for the interface; `error` is only an **English** fallback,
 * readable for whoever calls the API with curl.
 */
export type ApiError = {
  ok: false;
  error: string;
  code: string;
  params?: ErrorParams;
};

export type LoginResult = {
  ok: true;
  username: string;
  role: Role;
};

export type RconResult = {
  ok: true;
  command: string;
  output: string;
  durationMs: number;
};

export type StatusResult = {
  ok: true;
  online: string[];
  count: number;
  version: string;
  target: string;
  /** When the reading was taken: the status is cached server-side. */
  cachedAt: number;
};

export type ActionGroup = "info" | "server" | "moderation" | "comms";

export type ActionFieldKindDto =
  | "player"
  | "text"
  | "identifier"
  | "int"
  | "float"
  | "bool"
  | "enum";

export type ActionFieldDto = {
  name: string;
  required: boolean;
  kind: ActionFieldKindDto;
  /** Only filled in by commands from the operator's file. */
  label?: string;
  placeholder?: string;
  help?: string;
  options?: string[];
  min?: number;
  max?: number;
  default?: string;
};

/**
 * The catalogue carries identifiers only: labels, hints and confirmation
 * messages are resolved on the interface side through the
 * `actions.items.<id>.*` keys.
 *
 * The single exception is `text`: commands the operator defines in their JSON
 * file cannot feed the dictionaries. The server therefore resolves the text for
 * the requested locale and attaches it to the DTO.
 */
export type ActionDto = {
  id: string;
  /** A closed union for built-in actions, free-form for those from the file. */
  group: string;
  risk: "none" | "dangerous";
  /** The text lives in the dictionaries; this flag only says whether it exists. */
  confirm: boolean;
  fields: ActionFieldDto[];
  text?: {
    label: string;
    hint?: string;
    confirmation?: string;
    group?: string;
  };
  /** Source template, present when the entry asks for a preview before confirming. */
  template?: string;
};

export type ActionCatalogResult = {
  ok: true;
  actions: ActionDto[];
};

export type AuditEntryDto = {
  id: number;
  ts: number;
  username: string;
  role: string;
  kind: string;
  action: string;
  command: string | null;
  /** Fingerprint of the full raw command, of which `command` is only a prefix. */
  commandHash: string | null;
  status: string;
  detail: string | null;
  durationMs: number | null;
  ip: string | null;
};

export type AuditResult = {
  ok: true;
  entries: AuditEntryDto[];
};

/**
 * Neutral aggregate of one metric over a time slice.
 *
 * `min`/`max` rather than an opinionated "extreme": it is the presentation that
 * knows CPU worries about the maximum and UPS about the minimum, not the model.
 *
 * `samples` is the number of **real** readings (NULLs do not count). Without
 * it, an hour-long bucket built from a single reading draws exactly the same
 * curve as a full one.
 */
export type MetricsAggregateDto = {
  samples: number;
  avg: number | null;
  min: number | null;
  max: number | null;
};

/** The same, plus the last known value in the window. */
export type MetricsCurrentDto = MetricsAggregateDto & { current: number | null };

export type MetricsBucketDto = {
  /** Start of the slice, not the first sample it contains. */
  ts: number;
  bucketMs: number;
  /** Readings expected over the slice: `samples / expectedSamples` = coverage. */
  expectedSamples: number;
  cpu: MetricsAggregateDto;
  memory: MetricsAggregateDto;
  players: MetricsAggregateDto;
  ups: MetricsAggregateDto;
};

export type MetricsSummaryDto = {
  /** Collector rounds, not to be confused with the number of readings. */
  cycles: number;
  expectedSamples: number;
  cpu: MetricsCurrentDto;
  memory: MetricsCurrentDto;
  players: MetricsCurrentDto;
  ups: MetricsCurrentDto;
  /** Last known container limit, `null` when it has none. */
  memLimit: number | null;
};

/** See `HealthState` in `src/server/metrics/collector.ts`. */
export type MetricsHealthState = "disabled" | "unknown" | "healthy" | "degraded" | "failed";

export type MetricsSourceDto = {
  state: MetricsHealthState;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
};

/**
 * Health as reported by the collector itself.
 *
 * Inferring availability from the presence of points conflated "no data yet"
 * with "the source is down" — two situations calling for opposite reactions.
 * Hence a named state rather than a boolean.
 */
export type MetricsHealthDto = {
  running: boolean;
  startedAt: number | null;
  lastRunAt: number | null;
  lastDurationMs: number | null;
  intervalMs: number;
  storageFailures: number;
  docker: MetricsSourceDto;
  rcon: MetricsSourceDto;
};

export type MetricsRange = "1h" | "6h" | "24h" | "7d";

export type MetricsResult = {
  ok: true;
  range: MetricsRange;
  /**
   * The requested window, whose bounds are authoritative for the x axis.
   * Without them the chart would stretch ten minutes of readings across the
   * full width of a seven-day range and suggest a complete history.
   */
  from: number;
  to: number;
  buckets: MetricsBucketDto[];
  summary: MetricsSummaryDto;
  health: MetricsHealthDto;
};

/** Docker's view of the Factorio container, as relayed by the control agent. */
export type ContainerStatusDto = {
  /** created, running, paused, restarting, removing, exited or dead. */
  state: string;
  /** Only when the image defines a healthcheck. */
  health?: string;
  startedAt?: string;
  finishedAt?: string;
  exitCode: number;
  restartCount: number;
  image: string;
};

export type ServerLogLineDto = {
  stream: "stdout" | "stderr";
  text: string;
};

/** The three operations of the Server tab's buttons. */
export type ServerLifecycleType = "start" | "stop" | "restart";
export type ServerOperationType = ServerLifecycleType | "backup" | "restore" | "mods_apply" | "import";
export type ServerOperationStatus = "running" | "success" | "error" | "interrupted";
/** Where a running operation stands, for the progress display. */
export type ServerOperationStep =
  | "saving"
  | "stopping"
  | "starting"
  | "waiting_rcon"
  | "archiving"
  | "verifying"
  | "restoring"
  | "downloading"
  | "installing"
  | "rolling_back";

export type ServerOperationDto = {
  id: number;
  type: ServerOperationType;
  status: ServerOperationStatus;
  step: ServerOperationStep | null;
  username: string;
  startedAt: number;
  finishedAt: number | null;
  /** Translation key under `errors.*` when the operation failed. */
  errorCode: string | null;
  /** Whether the operator bypassed the player / RCON checks. */
  forced: boolean;
};

/**
 * The panel's synthesis of the two sources of truth: Docker for the
 * container, RCON for the game.
 *
 * - `stopped`  : the container is not running, on purpose or not;
 * - `starting` : the container runs but RCON does not answer yet (map loading);
 * - `running`  : container up and RCON answering;
 * - `stopping` : an operation of the panel is bringing it down;
 * - `error`    : the container runs but RCON stays silent, or Docker reports
 *                it dead or paused;
 * - `unknown`  : the control agent itself cannot be reached.
 */
export type ServerState = "stopped" | "starting" | "running" | "stopping" | "error" | "unknown";

export type ServerResult = {
  ok: true;
  state: ServerState;
  container: ContainerStatusDto | null;
  /** Translation key under `errors.*` when the agent could not be read. */
  controlError: string | null;
  rcon: { ok: boolean; count: number | null; version: string | null };
  operation: ServerOperationDto | null;
  recent: ServerOperationDto[];
};

export type ServerOperationResult = {
  ok: true;
  operation: ServerOperationDto;
};

export type ServerLogsResult = {
  ok: true;
  lines: ServerLogLineDto[];
};

/** One mod of the server's set, as the data agent reads it. */
export type ModDto = {
  name: string;
  enabled: boolean;
  /** Empty for mods that ship with the game. */
  version?: string;
  builtin: boolean;
};

/** One file of Factorio's saves folder. */
export type SaveFileDto = {
  name: string;
  size: number;
  modified: string;
  /** The save factoriotools loads at the next start. */
  latest: boolean;
};

/** `upload`: sent from the operator's computer; its version and mod set are unknown. */
export type BackupSource = "manual" | "scheduled" | "pre-restore" | "pre-mods" | "upload";

/** One archive kept by the panel, as described by its sidecar. */
export type BackupDto = {
  id: string;
  source: BackupSource;
  label?: string;
  createdAt: string;
  createdBy?: string;
  size: number;
  sha256: string;
  saveName: string;
  factorioVersion?: string;
  mods: ModDto[];
};

export type BackupSettingsDto = {
  enabled: boolean;
  intervalMinutes: number;
  /** 0: no limit on the number of scheduled archives. */
  keepLast: number;
  /** 0: no age limit. */
  maxAgeDays: number;
  /**
   * Ask Factorio to save before archiving. Off by default: a blocking save
   * freezes the game while it is written; without it the newest autosave is
   * archived instead.
   */
  triggerSave: boolean;
  lastRunAt: number | null;
};

export type SavesResult = {
  ok: true;
  saves: SaveFileDto[];
  backups: BackupDto[];
  /** The server's mod set now, to compare with an archive's. */
  mods: ModDto[];
  settings: BackupSettingsDto;
  /** Any operation in progress — a backup or restore, or a server one. */
  operation: ServerOperationDto | null;
  /** Largest save the data agent accepts from an upload; 0: uploads are off. */
  maxUploadBytes: number;
};

/** Where an upload stands: the next chunk starts at `offset`. */
export type UploadStateDto = {
  id: string;
  offset: number;
  size: number;
};

export type UploadResult = {
  ok: true;
  upload: UploadStateDto;
  /** Size of every chunk but the last. */
  chunkBytes: number;
};

export type BackupSettingsResult = {
  ok: true;
  settings: BackupSettingsDto;
};

export type ModAction = "install" | "update" | "enable" | "disable" | "remove";

/** One line of the Mods tab's basket. */
export type ModChangeDto = {
  action: ModAction;
  name: string;
  /** install/update only: a precise release; absent, the newest that fits. */
  version?: string;
};

/** A mod of the server, with what the portal knows of it. */
export type InstalledModDto = ModDto & {
  /** Installed as a folder by hand: enabled or disabled, never replaced. */
  unpacked: boolean;
  /** An expansion mod the Factorio image toggles from DLC_SPACE_AGE at every start. */
  dlc: boolean;
  /** Newer release for this game version, when there is one. */
  update?: string;
};

export type ModsResult = {
  ok: true;
  mods: InstalledModDto[];
  /** Portal credentials configured: searching and installing are possible. */
  credentials: boolean;
  /** Translation key under `errors.*` when the update check failed. */
  portalError: string | null;
  /** null until the panel has seen the server run once. */
  factorioVersion: string | null;
  operation: ServerOperationDto | null;
};

export type ModPlanStepDto = {
  action: ModAction;
  name: string;
  from?: string;
  to?: string;
  /** Absent when asked for; otherwise the mod that needs it. */
  requiredBy?: string;
  enabled?: boolean;
  download?: { fileName: string; url: string; sha1: string };
  replaces?: string[];
};

export type ModConflictDto = {
  mod: string;
  /** Translated under `mods.conflict.*`. */
  code: string;
  /** English detail from the data agent (versions, constraint). */
  detail: string;
};

export type ModPlanDto = {
  factorioVersion: string;
  steps: ModPlanStepDto[];
  conflicts: ModConflictDto[];
  optional: { mod: string; optional: string }[];
  /** Mods whose info.json could not be read: their needs are not checked. */
  unchecked: string[];
  /** Sent back with the basket to apply exactly this plan. */
  hash: string;
};

export type ModPlanResult = { ok: true; plan: ModPlanDto };

export type ModSearchHitDto = {
  name: string;
  title: string;
  summary: string;
  owner: string;
  category: string;
  downloads_count: number;
  installed: boolean;
};

export type ModSearchResult = { ok: true; hits: ModSearchHitDto[]; page: number; pageCount: number };

export type ModReleaseDto = {
  version: string;
  factorioVersion: string;
  releasedAt: string;
  dependencies: string[];
  /** Runs on this game version. */
  compatible: boolean;
};

export type ModDetailsDto = {
  name: string;
  title: string;
  summary: string;
  owner: string;
  category: string;
  downloadsCount: number;
  releases: ModReleaseDto[];
};

export type ModDetailsResult = { ok: true; mod: ModDetailsDto };

export type SessionInfo = {
  username: string;
  role: Role;
  permissions: Permission[];
};

export type ApiResponse<T> = T | ApiError;

export function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && (value as ApiError).ok === false;
}
