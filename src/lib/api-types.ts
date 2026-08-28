import type { Permission, Role } from "@/lib/permissions";

/** Contrat des réponses JSON, partagé par les routes et les composants. */

/** Valeurs injectées dans le message traduit (`{seconds}`, `{field}`…). */
export type ErrorParams = Record<string, string | number>;

/**
 * `code` est la clé de traduction (`errors.<code>` dans les dictionnaires) et
 * fait foi pour l'interface ; `error` n'est qu'un repli **en anglais**, lisible
 * pour qui appelle l'API au curl.
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
  /** Horodatage de la mesure : le statut est mis en cache côté serveur. */
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
  /** Renseignés seulement par les commandes du fichier de l'opérateur. */
  label?: string;
  placeholder?: string;
  help?: string;
  options?: string[];
  min?: number;
  max?: number;
  default?: string;
};

/**
 * Le catalogue ne transporte que des identifiants : libellés, indices et
 * messages de confirmation sont résolus côté interface via les clés
 * `actions.items.<id>.*`.
 *
 * Unique exception, `text` : les commandes définies par l'opérateur dans son
 * fichier JSON ne peuvent pas alimenter les dictionnaires. Le serveur résout
 * alors le texte pour la locale demandée et le joint au DTO.
 */
export type ActionDto = {
  id: string;
  /** Union fermée pour les actions intégrées, libre pour celles du fichier. */
  group: string;
  risk: "none" | "dangerous";
  /** Le texte vit dans les dictionnaires ; ce drapeau dit seulement s'il existe. */
  confirm: boolean;
  fields: ActionFieldDto[];
  text?: {
    label: string;
    hint?: string;
    confirmation?: string;
    group?: string;
  };
  /** Gabarit source, présent si l'entrée demande un aperçu avant confirmation. */
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
 * Agrégat neutre d'une métrique sur une tranche de temps.
 *
 * `min`/`max` plutôt qu'un « extrême » orienté : c'est la présentation qui sait
 * que le CPU s'inquiète du maximum et l'UPS du minimum, pas le modèle.
 *
 * `samples` est le nombre de mesures **réelles** (les NULL ne comptent pas).
 * Sans lui, un bucket d'une heure bâti sur un seul relevé produit exactement la
 * même courbe qu'un bucket complet.
 */
export type MetricsAggregateDto = {
  samples: number;
  avg: number | null;
  min: number | null;
  max: number | null;
};

/** Idem, plus la dernière valeur connue de la fenêtre. */
export type MetricsCurrentDto = MetricsAggregateDto & { current: number | null };

export type MetricsBucketDto = {
  /** Début de la tranche, pas le premier échantillon qu'elle contient. */
  ts: number;
  bucketMs: number;
  /** Mesures attendues sur la tranche : `samples / expectedSamples` = couverture. */
  expectedSamples: number;
  cpu: MetricsAggregateDto;
  memory: MetricsAggregateDto;
  players: MetricsAggregateDto;
  ups: MetricsAggregateDto;
};

export type MetricsSummaryDto = {
  /** Tours du collecteur, à ne pas confondre avec le nombre de mesures. */
  cycles: number;
  expectedSamples: number;
  cpu: MetricsCurrentDto;
  memory: MetricsCurrentDto;
  players: MetricsCurrentDto;
  ups: MetricsCurrentDto;
  /** Dernière limite connue du conteneur, `null` s'il n'en a pas. */
  memLimit: number | null;
};

export type MetricsSourceDto = {
  enabled: boolean;
  healthy: boolean;
  lastSuccessAt: number | null;
  consecutiveFailures: number;
};

/**
 * Santé rapportée par le collecteur lui-même.
 *
 * Déduire la disponibilité de la présence de points confondait « aucune donnée
 * pour l'instant » et « la source est tombée » — deux situations qui appellent
 * des réactions opposées.
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
   * Fenêtre demandée, bornes faisant foi pour l'axe des abscisses. Sans elles,
   * le graphe étirerait dix minutes de relevés sur toute la largeur d'une plage
   * de sept jours et laisserait croire à un historique complet.
   */
  from: number;
  to: number;
  buckets: MetricsBucketDto[];
  summary: MetricsSummaryDto;
  health: MetricsHealthDto;
};

export type SessionInfo = {
  username: string;
  role: Role;
  permissions: Permission[];
};

export type ApiResponse<T> = T | ApiError;

export function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && (value as ApiError).ok === false;
}
