/**
 * Nom du cookie de session, isolé dans son propre module : le middleware tourne
 * potentiellement sur le runtime Edge et ne doit pas importer `lib/auth`
 * (qui dépend de `node:crypto`).
 */
export const SESSION_COOKIE = "fa_session";
