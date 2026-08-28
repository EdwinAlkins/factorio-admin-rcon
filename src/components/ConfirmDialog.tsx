"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

type Props = {
  title: string;
  message: string;
  /** Commande exacte qui sera envoyée : dernière chance de voir une erreur. */
  details?: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Remplace `window.confirm` : non bloquant pour le thread, stylé comme le reste
 * du panneau et accessible (rôle dialog, focus initial, Échap pour annuler).
 */
export default function ConfirmDialog({
  title,
  message,
  details,
  confirmLabel,
  onConfirm,
  onCancel,
}: Props) {
  const t = useTranslations("confirm");
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") onCancel();
    }

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        className="w-full max-w-md rounded-lg border border-line bg-surface p-5 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="confirm-title" className="text-sm font-semibold">
          {title}
        </h2>
        <p className="mt-2 text-sm text-muted">{message}</p>
        {details && (
          <pre className="mt-3 max-h-48 overflow-auto rounded border border-line bg-raised p-2 font-mono text-xs break-words whitespace-pre-wrap">
            {details}
          </pre>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onCancel}>
            {t("cancel")}
          </button>
          <button ref={confirmRef} type="button" className="btn-primary" onClick={onConfirm}>
            {confirmLabel ?? t("confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}
