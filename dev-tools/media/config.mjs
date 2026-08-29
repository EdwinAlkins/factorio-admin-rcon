import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, resolve } from 'node:path';

// Shared configuration for the capture scripts. Nothing here is tied to a
// particular deployment: point PANEL_URL at whatever panel you want to shoot
// (a local `npm run dev`, a throwaway container, a staging instance).
const HERE = dirname(fileURLToPath(import.meta.url));

function required(name, hint) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name}. ${hint}`);
    process.exit(1);
  }
  return value;
}

export const BASE = (process.env.PANEL_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
export const PW = required('PANEL_PW', 'Pass the admin password through the environment, never a file.');
export const LOCALE = process.env.LOCALE === 'en' ? 'en' : 'fr';
export const MODE = process.env.MODE === 'video' ? 'video' : 'shots';

// Output stays outside the repository index (see .gitignore): the scripts are
// versioned, their output is not.
const defaultOut = MODE === 'video' ? `out/${LOCALE}-video` : `out/${LOCALE}`;
const requested = process.env.OUT ?? defaultOut;
export const OUT = isAbsolute(requested) ? requested : resolve(HERE, requested);

export const BROWSER_LOCALE = LOCALE === 'fr' ? 'fr-FR' : 'en-US';

export const L = {
  fr: {
    login: 'Se connecter', players: 'Joueurs en ligne', version: 'Version',
    evolution: 'Évolution', time: 'Temps de jeu', show: 'Afficher',
    metrics: 'Statistiques', console: 'Console', kick: 'Kick…',
    send: 'Envoyer', cancel: 'Annuler', audit: "Journal d’audit",
    cmdLabel: 'Commande RCON', playerLabel: /^Joueur/,
  },
  en: {
    login: 'Sign in', players: 'Players online', version: 'Version',
    evolution: 'Evolution', time: 'Playtime', show: 'Show',
    metrics: 'Statistics', console: 'Console', kick: 'Kick…',
    send: 'Send', cancel: 'Cancel', audit: 'Audit log',
    cmdLabel: 'RCON command', playerLabel: /^Player/,
  },
}[LOCALE];
