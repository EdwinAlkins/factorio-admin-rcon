import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import AdminPanel from "@/components/AdminPanel";
import { redirect } from "@/i18n/navigation";
import { routing } from "@/i18n/routing";
import { readSession } from "@/server/http/context";
import { env } from "@/server/config/env";
import { catalogFor } from "@/server/actions/service";
import { permissionsOf } from "@/lib/permissions";
import type { SessionInfo } from "@/lib/api-types";

export const dynamic = "force-dynamic";

export default async function Home({ params }: PageProps<"/[locale]">) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();

  const session = await readSession();
  if (!session) redirect({ href: "/login", locale });

  const info: SessionInfo = {
    username: session!.username,
    role: session!.role,
    permissions: permissionsOf(session!.role),
  };

  // Le catalogue est filtré côté serveur : l'interface ne connaît que les
  // actions que ce rôle a effectivement le droit d'exécuter. Il ne transporte
  // que des identifiants — les libellés sont résolus côté client, sauf pour les
  // commandes du fichier de l'opérateur, qui portent leur texte (d'où `locale`).
  //
  // `metricsEnabled` est lu ici plutôt que via une requête du client : l'onglet
  // ne doit pas apparaître une fraction de seconde avant de disparaître.
  return (
    <AdminPanel
      session={info}
      actions={catalogFor(session!, locale)}
      metricsEnabled={env().METRICS_ENABLED}
    />
  );
}
