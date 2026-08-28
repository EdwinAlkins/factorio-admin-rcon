import { ACTIONS, type ActionDefinition } from "@/server/actions/definitions";
import { customActions } from "@/server/actions/custom";

/**
 * Catalogue effectif : actions intégrées **puis** commandes du fichier de
 * l'opérateur. Les identifiants de ces dernières sont préfixés `custom:`, donc
 * aucune ne peut masquer une action intégrée.
 */
export function allActions(): ActionDefinition[] {
  return [...ACTIONS, ...customActions()];
}

export function findAction(id: string): ActionDefinition | undefined {
  return allActions().find((action) => action.id === id);
}
