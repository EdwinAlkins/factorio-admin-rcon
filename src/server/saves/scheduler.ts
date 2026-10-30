import { env } from "@/server/config/env";
import { errorFields, logger, newRequestId } from "@/server/log";
import { dataPrune } from "@/server/data/client";
import { currentOperation } from "@/server/operations/engine";
import { backupSettings, markScheduledRun, requestBackup } from "@/server/saves/service";

/**
 * Scheduled backups, in the panel's process — the same pattern as the
 * metrics collector: a minute timer on `globalThis`, no external scheduler.
 *
 * Each tick reads the settings, so a change from the interface applies at the
 * next minute without a restart. A due run that finds another operation in
 * progress is not skipped: it is simply tried again at the next tick.
 */

const TICK_MS = 60 * 1000;

/** Safety copies (before a restore or a mod change) are kept a month, ten at most. */
const SAFETY_POLICY = { sources: ["pre-restore", "pre-mods"] as const, keepLast: 10, maxAgeDays: 30 };

const SCHEDULER_ACTOR = { username: "scheduler", role: "system", ip: null };

type State = { timer: NodeJS.Timeout; running: boolean };
const globalRef = globalThis as typeof globalThis & { __factorioBackupScheduler?: State };

/** Whether a run is due, given the settings and the clock. Pure, for the tests. */
export function isDue(settings: { enabled: boolean; intervalMinutes: number; lastRunAt: number | null }, now: number) {
  if (!settings.enabled) return false;
  return settings.lastRunAt === null || now - settings.lastRunAt >= settings.intervalMinutes * 60 * 1000;
}

export async function schedulerTick(now = Date.now()) {
  const settings = backupSettings();
  if (!isDue(settings, now) || currentOperation()) return;

  // Recorded at launch, not completion: a run that fails is not retried
  // every minute until the next interval.
  markScheduledRun(now);
  try {
    await requestBackup({
      ...SCHEDULER_ACTOR,
      requestId: newRequestId(),
      source: "scheduled",
      triggerSave: settings.triggerSave,
    });
    await currentOperation()?.done;

    if (settings.keepLast > 0 || settings.maxAgeDays > 0) {
      await dataPrune({ sources: ["scheduled"], keepLast: settings.keepLast, maxAgeDays: settings.maxAgeDays });
    }
    await dataPrune({ ...SAFETY_POLICY, sources: [...SAFETY_POLICY.sources] });
  } catch (error) {
    logger.warn("scheduled backup failed", errorFields(error));
  }
}

export function startBackupScheduler() {
  if (globalRef.__factorioBackupScheduler || !env().SAVES_ENABLED) return;

  const state: State = {
    running: false,
    timer: setInterval(() => {
      // A slow archive must not let two ticks overlap.
      if (state.running) return;
      state.running = true;
      void schedulerTick().finally(() => {
        state.running = false;
      });
    }, TICK_MS),
  };
  // `unref`: the timer must not keep the process alive at shutdown.
  state.timer.unref();
  globalRef.__factorioBackupScheduler = state;
  logger.info("backup scheduler started");
}

export function stopBackupScheduler() {
  const state = globalRef.__factorioBackupScheduler;
  if (!state) return;
  clearInterval(state.timer);
  globalRef.__factorioBackupScheduler = undefined;
}
