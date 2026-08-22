# Panneau d'admin RCON

Application Next.js (App Router) qui pilote le serveur Factorio : console RCON libre, actions
métier (joueurs, sauvegarde, modération, chat), rôles, journal d'audit.

Elle parle le protocole RCON en TCP — le client C du dépôt (`docker/rcon/main.c`) hardcode
`127.0.0.1` et n'est utilisable que depuis le conteneur du serveur.

## Développement

```bash
cp .env.example .env.local   # renseigner au minimum ADMIN_PASSWORD
npm install
npm run dev                  # http://localhost:3000
```

Le serveur Factorio doit tourner avec le port RCON publié (`docker compose up -d factorio`,
`27015:27015/tcp` est déjà mappé). Le mot de passe RCON est lu dans `../data/config/rconpw`,
généré au premier démarrage du serveur par `docker/files/docker-entrypoint.sh`.

```bash
npm run lint        # eslint
npm run typecheck   # next typegen && tsc --noEmit
npm test            # vitest
npm run build
```

## Production

Service `factorio-admin` du `docker-compose.yml` à la racine :

```bash
cd .. && ./setup-admin.sh            # génère ../.env (mots de passe + clé de session)
docker compose up -d --build factorio-admin   # http://127.0.0.1:3010
```

`setup-admin.sh --all` crée aussi les mots de passe modérateur et observateur, `--ask` les fait
saisir au lieu de les générer, `--force` fait tourner tous les secrets (et coupe les sessions
ouvertes). Les valeurs déjà présentes dans `.env` sont conservées par défaut.

Une image est publiée à chaque release sur `williamnauroy/factorio-admin-rcon` (`linux/amd64` et
`linux/arm64`). Épinglez une version exacte en production :

```bash
docker pull williamnauroy/factorio-admin-rcon:1.0.0
```

Le versionnement et la publication sont automatiques — voir [CI.md](CI.md).

## Rôles

Un mot de passe par rôle ; le rôle est déterminé par le mot de passe utilisé à la connexion.

| Rôle | Variable | Peut faire |
| --- | --- | --- |
| `viewer` | `VIEWER_PASSWORD` | Statut, joueurs, version, seed, évolution, admins, bannis |
| `moderator` | `MODERATOR_PASSWORD` | + kick, ban/unban, mute/unmute, message serveur, message privé |
| `admin` | `ADMIN_PASSWORD` | + sauvegarde, promote/demote, **console RCON brute**, journal d'audit |

Les permissions sont appliquées **côté serveur** : le catalogue d'actions est filtré par rôle et
`/api/actions` revérifie la permission avant d'exécuter quoi que ce soit.

## Langues

Le panneau est disponible en anglais (par défaut) et en français. La langue est déduite de
l'en-tête `Accept-Language` à la première visite, modifiable par le sélecteur de la barre de
statut, et mémorisée dans un cookie. Elle apparaît dans l'URL : `/` pour l'anglais, `/fr` pour le
français.

Pour ajouter une langue :

1. copier `messages/en.json` en `messages/<code>.json` et traduire les valeurs ;
2. ajouter le code à `locales` dans `src/i18n/routing.ts` ;
3. ajouter son nom dans `localeSwitcher` de chaque dictionnaire ;
4. `npm test` — la suite vérifie que les deux fichiers exposent exactement les mêmes clés et
   qu'aucune action du catalogue n'a de libellé manquant.

Aucun texte d'interface ne vit dans `src/server/` : l'API ne renvoie que des identifiants
(`ban`, `moderation`) et des codes d'erreur (`rate_limited_session`, `validation_player`), que
l'interface traduit. Le champ `error` des réponses JSON reste un repli **en anglais**, destiné aux
appels hors navigateur. Le journal d'audit stocke lui aussi des identifiants : l'historique reste
donc lisible dans n'importe quelle langue, y compris pour des entrées antérieures.

Ne sont volontairement pas traduits : la sortie brute de Factorio, les commandes RCON et les logs
serveur (en anglais, destinés à l'exploitant).

## Architecture

```
src/
├── app/            pages + routes API (pages sous `[locale]/`)
├── components/     interface (console, actions, audit, modale)
├── hooks/          statut serveur (polling), exécution de commandes, traductions
├── i18n/           routing, chargement des dictionnaires, navigation locale-aware
├── lib/            code partagé client/serveur (types, permissions, fetch typé)
└── server/         code serveur uniquement
    ├── actions/    définitions métier + exécution
    ├── audit/      journal SQLite
    ├── auth/       comptes, sessions, limiteurs
    ├── config/     variables d'environnement validées (zod)
    ├── http/       enveloppe de route (session, permission, origine, logs)
    └── rcon/       service, file d'attente, parsing, cache de statut

messages/           dictionnaires (en.json fait référence)
```

Deux chemins d'exécution distincts :

- `POST /api/actions` — `{ action, values }`. Le serveur valide les arguments, applique la
  permission et **construit lui-même** la commande. Chemin utilisé par tous les rôles.
- `POST /api/rcon` — commande brute. Réservé à la permission `rcon:raw` (rôle `admin`).

## Endpoints

| Route | Auth | Rôle |
| --- | --- | --- |
| `POST /api/login` / `POST /api/logout` | — | Ouvre / révoque une session |
| `GET /api/status` | session | Statut serveur (mis en cache) |
| `GET /api/actions` | session | Catalogue filtré par rôle |
| `POST /api/actions` | session | Exécute une action métier |
| `POST /api/rcon` | `rcon:raw` | Console brute |
| `GET /api/audit` | `audit:read` | 50 dernières entrées d'audit |
| `GET /api/health` | public | Liveness (sonde Docker) |
| `GET /api/ready` | public | Readiness : config + base + RCON |

## Modèle de sécurité

Ce panneau suppose :

- **une seule instance** (1 conteneur = 1 processus Node = 1 connexion RCON). Les limiteurs de
  débit et le cache de statut vivent en mémoire du processus : derrière un load balancer, ils
  seraient contournables ;
- **un accès réseau restreint** — le panneau est publié sur `127.0.0.1` par défaut ; en HTTPS
  derrière un reverse proxy, mettre `TRUST_PROXY=true` (sinon `X-Forwarded-For` est ignoré, ce qui
  est volontaire : un en-tête forgeable ne doit pas piloter la limitation) ;
- **le port RCON du serveur Factorio n'est joignable que par le panneau** en production.

Ce qui est en place :

- sessions persistées en SQLite : la déconnexion **révoque** réellement le cookie ;
- comparaison des mots de passe en temps constant, limitation des tentatives (par IP quand elle est
  fiable, plus un plafond global toujours actif) ;
- limitation du débit de commandes par session et **file RCON bornée** (503 au-delà) ;
- vérification de l'origine sur toutes les requêtes mutantes, cookie `httpOnly`/`SameSite=Lax`,
  `secure` automatique en HTTPS ;
- en-têtes CSP, `nosniff`, `Referrer-Policy`, `Permissions-Policy`, HSTS ;
- journal d'audit de toutes les actions, y compris les refus.

Ce qui reste hors périmètre : la confirmation des commandes Lua est une aide à l'interface, pas une
protection — un compte `admin` a par définition un accès RCON complet.
