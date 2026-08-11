import type { Permission, Role } from "@/lib/permissions";

/** Contrat des réponses JSON, partagé par les routes et les composants. */

export type ApiError = {
  ok: false;
  error: string;
  code?: string;
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

export type ActionFieldDto = {
  name: string;
  label: string;
  placeholder?: string;
  required: boolean;
};

export type ActionDto = {
  id: string;
  label: string;
  hint: string;
  group: string;
  risk: "none" | "dangerous";
  confirmation?: string;
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
