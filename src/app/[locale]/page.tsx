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

  // The catalogue is filtered server-side: the interface only knows the actions
  // this role is actually allowed to run. It carries identifiers only — labels
  // are resolved on the client, except for commands from the operator's file,
  // which carry their own text (hence `locale`).
  //
  // `metricsEnabled` is read here rather than through a client request: the tab
  // must not appear for a fraction of a second before vanishing.
  return (
    <AdminPanel
      session={info}
      actions={catalogFor(session!, locale)}
      metricsEnabled={env().METRICS_ENABLED}
    />
  );
}
