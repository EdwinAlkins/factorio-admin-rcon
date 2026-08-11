import { redirect } from "next/navigation";
import AdminPanel from "@/components/AdminPanel";
import { readSession } from "@/server/http/context";
import { catalogFor } from "@/server/actions/service";
import { permissionsOf } from "@/lib/permissions";
import type { SessionInfo } from "@/lib/api-types";

export const dynamic = "force-dynamic";

export default async function Home() {
  const session = await readSession();
  if (!session) redirect("/login");

  const info: SessionInfo = {
    username: session.username,
    role: session.role,
    permissions: permissionsOf(session.role),
  };

  // Le catalogue est filtré côté serveur : l'interface ne connaît que les
  // actions que ce rôle a effectivement le droit d'exécuter.
  return <AdminPanel session={info} actions={catalogFor(session)} />;
}
