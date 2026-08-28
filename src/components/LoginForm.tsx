"use client";

import { useState, type FormEvent } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/navigation";
import { fetchJson } from "@/lib/fetch-json";
import { useErrorMessage } from "@/hooks/useErrorMessage";
import type { LoginResult } from "@/lib/api-types";

export default function LoginForm() {
  const t = useTranslations();
  const errorMessage = useErrorMessage();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const outcome = await fetchJson<LoginResult>("/api/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });

    setBusy(false);

    if (outcome.kind === "ok") {
      setPassword("");
      router.replace("/");
      router.refresh();
      return;
    }

    // On this page a 401 can only mean one thing.
    setError(
      outcome.kind === "unauthorized" ? t("errors.bad_credentials") : errorMessage(outcome),
    );
  }

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-surface p-6"
    >
      <div>
        <h1 className="text-base font-semibold">
          {t("app.brand")} <span className="text-accent">{t("app.brandSuffix")}</span>
        </h1>
        <p className="mt-1 text-xs text-muted">{t("login.subtitle")}</p>
      </div>

      <div>
        <label className="block text-xs text-muted" htmlFor="password">
          {t("login.password")}
        </label>
        <input
          id="password"
          autoFocus
          type="password"
          autoComplete="current-password"
          className="field mt-1"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          required
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}

      <button type="submit" className="btn-primary w-full" disabled={busy}>
        {busy ? t("login.submitting") : t("login.submit")}
      </button>
    </form>
  );
}
