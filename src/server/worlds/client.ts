import { env } from "@/server/config/env";
import { agentTransport } from "@/server/agents/transport";
import type { WorldCatalogDto, WorldDto, WorldPreviewDto, WorldSettings } from "@/lib/api-types";

/**
 * Client of the world agent (services/agents, cmd/world-agent): it runs the
 * game's binary to preview terrain and generate maps, and keeps the library
 * of worlds. It never touches the server's saves; putting a world in play
 * goes through the data agent.
 */

/**
 * Deadline of a call that runs the game: a preview, the catalogue (a data
 * dump), a new map (a preview, then the map). The agent bounds each run of
 * the game itself (RUN_TIMEOUT_SECONDS, 180 s by default).
 */
const GAME_TIMEOUT_MS = 7 * 60 * 1000;

const transport = agentTransport("world", () => {
  const config = env();
  return {
    url: config.WORLD_AGENT_URL,
    token: config.WORLD_AGENT_TOKEN,
    tokenFile: config.WORLD_AGENT_TOKEN_FILE,
    timeoutMs: config.WORLD_AGENT_TIMEOUT_MS,
  };
});

export async function worldCatalog(): Promise<WorldCatalogDto> {
  const result = await transport.call<{ catalog: WorldCatalogDto }>({
    method: "GET",
    path: "/v1/catalog",
    timeoutMs: GAME_TIMEOUT_MS,
  });
  return result.catalog;
}

export type PreviewRequest = {
  settings: WorldSettings;
  seed?: number;
  size: number;
  planet: string;
  offset: { x: number; y: number };
  report: string[];
};

export async function worldPreview(request: PreviewRequest): Promise<WorldPreviewDto> {
  const result = await transport.call<{ preview: WorldPreviewDto }>({
    method: "POST",
    path: "/v1/previews",
    body: request,
    timeoutMs: GAME_TIMEOUT_MS,
  });
  return result.preview;
}

/** A preview's image; streamed to the browser. */
export function worldPreviewImage(id: string): Promise<Response> {
  return transport.send({ method: "GET", path: `/v1/previews/${encodeURIComponent(id)}` });
}

export async function worldList(): Promise<{ worlds: WorldDto[]; factorioVersion: string }> {
  return transport.call({ method: "GET", path: "/v1/worlds" });
}

export async function worldCreate(request: {
  name: string;
  settings: WorldSettings;
  seed?: number;
  createdBy: string;
}): Promise<WorldDto> {
  const result = await transport.call<{ world: WorldDto }>({
    method: "POST",
    path: "/v1/worlds",
    body: request,
    timeoutMs: GAME_TIMEOUT_MS,
  });
  return result.world;
}

/** A world's own preview, kept in the library. */
export function worldImage(id: string): Promise<Response> {
  return transport.send({ method: "GET", path: `/v1/worlds/${encodeURIComponent(id)}/preview` });
}

/** A world's save, streamed to the browser. */
export function worldDownload(id: string): Promise<Response> {
  return transport.send({ method: "GET", path: `/v1/worlds/${encodeURIComponent(id)}/download`, timeoutMs: GAME_TIMEOUT_MS });
}

export async function worldDelete(id: string): Promise<void> {
  await transport.call({ method: "DELETE", path: `/v1/worlds/${encodeURIComponent(id)}` });
}

export const worldHealthy = transport.healthy;
