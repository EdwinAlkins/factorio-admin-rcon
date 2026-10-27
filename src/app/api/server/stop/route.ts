import { operationRoute } from "@/server/control/routes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = operationRoute("stop", "server:stop");
