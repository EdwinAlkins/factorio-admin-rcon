"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { fetchJson } from "@/lib/fetch-json";
import type { LoginResult } from "@/lib/api-types";

export default function LoginForm() {
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

    setError(
      outcome.kind === "unauthorized"
        ? "Mot de passe incorrect."
        : outcome.message,
    );
  }

  return (
    <form
      onSubmit={submit}
      className="w-full max-w-sm space-y-4 rounded-lg border border-line bg-surface p-6"
    >
      <div>
        <h1 className="text-base font-semibold">
          Factorio <span className="text-accent">— panneau d&apos;admin</span>
        </h1>
        <p className="mt-1 text-xs text-muted">Mot de passe requis.</p>
      </div>

      <div>
        <label className="block text-xs text-muted" htmlFor="password">
          Mot de passe
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
        {busy ? "Connexion…" : "Se connecter"}
      </button>
    </form>
  );
}
