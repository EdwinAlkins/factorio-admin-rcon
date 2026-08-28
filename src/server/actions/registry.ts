import { ACTIONS, type ActionDefinition } from "@/server/actions/definitions";
import { customActions } from "@/server/actions/custom";

/**
 * The effective catalogue: built-in actions **then** commands from the
 * operator's file. The latter's ids are prefixed `custom:`, so none of them can
 * shadow a built-in action.
 */
export function allActions(): ActionDefinition[] {
  return [...ACTIONS, ...customActions()];
}

export function findAction(id: string): ActionDefinition | undefined {
  return allActions().find((action) => action.id === id);
}
