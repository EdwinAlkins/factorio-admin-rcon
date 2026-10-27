"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson, type FetchFailure } from "@/lib/fetch-json";
import { usePolling } from "@/hooks/usePolling";
import type {
  BackupSettingsDto,
  BackupSettingsResult,
  SavesResult,
  ServerOperationResult,
  UploadResult,
} from "@/lib/api-types";

/** Refusals the operator can override by confirming a second time. */
const FORCEABLE = new Set(["players_online", "rcon_unavailable_force_required", "restore_incompatible"]);

export type SavesOutcome =
  | { kind: "done" }
  | { kind: "needs_force"; failure: FetchFailure }
  | { kind: "failed"; failure: FetchFailure };

export type UploadProgress = { sent: number; resuming: boolean };

/** Failures a chunk is retried after: the connection, or the server catching up. */
const RETRIABLE = new Set(["network", "upload_offset", "data_timeout", "data_unreachable", "data_busy", "rate_limited_session"]);
const MAX_RETRIES = 6;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Saves tab data (`GET /api/saves`) and its actions. Polled only while the tab
 * is shown — slowly at rest, fast while an operation runs. Callbacks are read
 * through refs so `load` stays stable (see useServerControl).
 */
export function useSaves(options: { enabled: boolean; onUnauthorized: () => void }) {
  const { enabled, onUnauthorized } = options;
  const [data, setData] = useState<SavesResult | null>(null);
  const [failure, setFailure] = useState<FetchFailure | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const unauthorized = useRef(onUnauthorized);
  useEffect(() => {
    unauthorized.current = onUnauthorized;
  });

  const load = useCallback(async () => {
    const outcome = await fetchJson<SavesResult>("/api/saves");
    if (!alive.current) return;
    if (outcome.kind === "unauthorized") {
      unauthorized.current();
    } else if (outcome.kind === "error") {
      setFailure(outcome);
    } else {
      setFailure(null);
      setData(outcome.data);
    }
  }, []);

  const tick = useCallback(() => void load(), [load]);
  usePolling(tick, { enabled, intervalMs: data?.operation ? 2000 : 15_000 });

  /** Sends a mutation, then refreshes the list. */
  const send = useCallback(
    async (input: string, init: RequestInit, forceable = false): Promise<SavesOutcome> => {
      setSubmitting(true);
      try {
        const outcome = await fetchJson<ServerOperationResult | { ok: true }>(input, init);
        if (outcome.kind === "unauthorized") {
          unauthorized.current();
          return { kind: "done" };
        }
        if (outcome.kind === "error") {
          return forceable && FORCEABLE.has(outcome.code)
            ? { kind: "needs_force", failure: outcome }
            : { kind: "failed", failure: outcome };
        }
        await load();
        return { kind: "done" };
      } finally {
        if (alive.current) setSubmitting(false);
      }
    },
    [load],
  );

  const backup = useCallback(
    (label: string) => send("/api/saves", { method: "POST", body: JSON.stringify(label ? { label } : {}) }),
    [send],
  );

  const restore = useCallback(
    (id: string, force = false) =>
      send(
        `/api/saves/${encodeURIComponent(id)}/restore`,
        { method: "POST", body: JSON.stringify(force ? { force: true } : {}) },
        !force,
      ),
    [send],
  );

  const remove = useCallback(
    (id: string) => send(`/api/saves/${encodeURIComponent(id)}`, { method: "DELETE" }),
    [send],
  );

  /**
   * Sends a save in chunks, then asks for it to be published as an archive.
   * A failed chunk is retried from where the server stands, a few times with
   * a growing pause: a laptop changing networks does not restart a 500 MB
   * upload from zero. Aborting `signal` drops the upload on the server.
   */
  const upload = useCallback(
    async (
      file: File,
      label: string,
      onProgress: (progress: UploadProgress) => void,
      signal: AbortSignal,
    ): Promise<SavesOutcome> => {
      const begun = await fetchJson<UploadResult>("/api/saves/uploads", {
        method: "POST",
        body: JSON.stringify({ size: file.size, name: file.name }),
      });
      if (begun.kind === "unauthorized") {
        unauthorized.current();
        return { kind: "done" };
      }
      if (begun.kind === "error") return { kind: "failed", failure: begun };

      const path = `/api/saves/uploads/${encodeURIComponent(begun.data.upload.id)}`;
      const { chunkBytes } = begun.data;
      const abandon = () => void fetchJson(path, { method: "DELETE" });
      let offset = 0;
      let retries = 0;

      while (offset < file.size) {
        if (signal.aborted) {
          abandon();
          return { kind: "done" };
        }
        const sent = await fetchJson<UploadResult>(`${path}?offset=${offset}`, {
          method: "PUT",
          body: file.slice(offset, offset + chunkBytes),
          headers: { "content-type": "application/octet-stream" },
          signal,
        });
        if (sent.kind === "ok") {
          offset = sent.data.upload.offset;
          retries = 0;
          onProgress({ sent: offset, resuming: false });
          continue;
        }
        if (sent.kind === "unauthorized") {
          unauthorized.current();
          return { kind: "done" };
        }
        if (signal.aborted) continue;
        if (!(RETRIABLE.has(sent.code) || sent.status >= 500) || ++retries > MAX_RETRIES) {
          abandon();
          return { kind: "failed", failure: sent };
        }
        onProgress({ sent: offset, resuming: true });
        await pause(1000 * 2 ** (retries - 1));
        const where = await fetchJson<UploadResult>(path);
        if (where.kind === "ok") offset = where.data.upload.offset;
      }

      return send(`${path}/complete`, { method: "POST", body: JSON.stringify(label ? { label } : {}) });
    },
    [send],
  );

  const saveSettings = useCallback(
    async (settings: Omit<BackupSettingsDto, "lastRunAt">): Promise<SavesOutcome> => {
      const outcome = await fetchJson<BackupSettingsResult>("/api/saves/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      });
      if (outcome.kind === "error") return { kind: "failed", failure: outcome };
      if (outcome.kind === "unauthorized") unauthorized.current();
      await load();
      return { kind: "done" };
    },
    [load],
  );

  return { data, failure, submitting, refresh: load, backup, restore, remove, upload, saveSettings };
}
