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

export type ActionFieldDto = {
  name: string;
  required: boolean;
};

/**
 * Le catalogue ne transporte que des identifiants : libellés, indices et
 * messages de confirmation sont résolus côté interface via les clés
 * `actions.items.<id>.*`. Aucun texte d'UI ne subsiste dans la couche métier.
 */
export type ActionDto = {
  id: string;
  group: ActionGroup;
  risk: "none" | "dangerous";
  /** Le texte vit dans les dictionnaires ; ce drapeau dit seulement s'il existe. */
  confirm: boolean;
  fields: ActionFieldDto[];
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

export type SessionInfo = {
  username: string;
  role: Role;
  permissions: Permission[];
};

export type ApiResponse<T> = T | ApiError;

export function isApiError(value: unknown): value is ApiError {
  return typeof value === "object" && value !== null && (value as ApiError).ok === false;
}
