# Intégration continue et publication

La CI fait deux choses : elle **vérifie** chaque pull request, et sur `main` elle **décide de la
version**, crée la release GitHub, puis publie l'image sur Docker Hub.

Image publiée : [`williamnauroy/factorio-admin-rcon`](https://hub.docker.com/r/williamnauroy/factorio-admin-rcon)

> Le namespace Docker Hub (`williamnauroy`) n'est pas le compte GitHub (`EdwinAlkins`). C'est
> volontaire, mais c'est la source d'erreur la plus probable si un push est refusé.

## Le flux en un coup d'œil

```
Pull request ─────────► ci.yml
                        ├─ quality : npm ci · lint · typecheck · test
                        └─ image   : docker build (amd64, sans push)

Push sur main ────────► release.yml
                        │
                        ├─ 1. ci ......... appelle ci.yml (mêmes contrôles)
                        │                   ↓ échec = rien n'est publié
                        ├─ 2. release .... semantic-release lit les commits
                        │                   → version, CHANGELOG.md, tag Git,
                        │                     release GitHub
                        │                   ↓ aucun commit pertinent = on s'arrête
                        └─ 3. publish .... docker build amd64+arm64 → Docker Hub

Run workflow ─────────► release.yml (rattrapage : 1 et 2 sautés)
  (version saisie)      └─ 3. publish .... rebuild du tag vN.N.N → Docker Hub
```

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `.github/workflows/ci.yml` | Contrôles qualité + build de validation. Déclenché sur PR, et appelé par `release.yml`. |
| `.github/workflows/release.yml` | Versionnement, release GitHub, push Docker Hub. Déclenché sur `main` (et `beta`). |
| `.releaserc.json` | Configuration semantic-release : branches et plugins. |

## Comment la version est calculée

Le numéro de version n'est **jamais saisi à la main** : il est déduit des messages de commit depuis
le dernier tag, au format [Conventional Commits](https://www.conventionalcommits.org/fr/).

| Message de commit | Effet sur `1.4.2` |
| --- | --- |
| `fix: corrige le parsing du statut` | → `1.4.3` (patch) |
| `feat: ajoute l'export du journal d'audit` | → `1.5.0` (mineur) |
| `feat!: supprime VIEWER_PASSWORD`<br>ou un bloc `BREAKING CHANGE:` en pied de message | → `2.0.0` (majeur) |
| `chore:`, `docs:`, `refactor:`, `test:`, `ci:`, `style:` | aucune release |

Un push sur `main` qui ne contient que des `chore:`/`docs:` ne publie donc rien du tout — le job
`publish` est simplement sauté. C'est le comportement attendu, pas une panne.

La **première release** sera `1.0.0`, quel que soit le `0.1.0` actuel de `package.json` (que
semantic-release met ensuite à jour tout seul).

## Ce que produit une release

Pour une version `1.4.2`, la CI crée :

- un tag Git `v1.4.2` et une release GitHub avec les notes générées depuis les commits ;
- un commit `chore(release): 1.4.2 [skip ci]` sur `main` mettant à jour `CHANGELOG.md`,
  `package.json` et `package-lock.json` ;
- ces tags Docker Hub :

| Tag | Bouge à chaque… | Pour qui |
| --- | --- | --- |
| `1.4.2` | jamais (immuable) | production — reproductible |
| `1.4` | correctif de la 1.4 | on accepte les patchs |
| `1` | version mineure de la 1.x | on accepte les nouveautés compatibles |
| `latest` | release stable | tests, démos |

Les préversions (branche `beta` → `1.5.0-beta.1`) ne prennent **que** leur tag exact : ni `1.5`,
ni `1`, ni `latest`.

L'image est construite pour `linux/amd64` et `linux/arm64`, avec les labels OCI standard, un
attestat de provenance et un SBOM.

> Provenance et SBOM sont stockés comme des manifestes supplémentaires en `unknown/unknown` dans
> l'index OCI. L'interface de Docker Hub les masque — vous ne verrez que `linux/amd64` et
> `linux/arm64` — mais ils sont bien présents :
>
> ```bash
> docker buildx imagetools inspect williamnauroy/factorio-admin-rcon:1.0.0
> ```
>
> Pour s'en passer : `provenance: false` et `sbom: false` dans `release.yml`.

## Actions manuelles à faire

### 1. Créer le dépôt Git et le pousser sur GitHub

Le dossier **n'est pas encore un dépôt Git** — rien ne se déclenchera tant que ce n'est pas fait.

```bash
git init -b main
git add .
git commit -m "feat: panneau d'admin RCON pour Factorio"
gh repo create factorio-admin-rcon --public --source=. --push
```

Le premier commit doit être un `feat:` (ou contenir un `BREAKING CHANGE:`) pour déclencher la
release initiale.

### 2. Créer le jeton Docker Hub

1. [hub.docker.com](https://hub.docker.com) → **Account settings** → **Personal access tokens**
2. **Generate new token** — description : `github-actions-factorio-admin-rcon`
3. Permissions : **Read & Write** (suffisant ; `Read, Write, Delete` est inutile ici)
4. Copier le jeton — il n'est affiché qu'une fois

Un jeton, et non le mot de passe du compte : il est révocable seul et ne donne pas accès aux
paramètres du compte.

### 3. Déclarer les secrets GitHub

Dépôt → **Settings** → **Secrets and variables** → **Actions** → **New repository secret** :

| Nom | Valeur |
| --- | --- |
| `DOCKERHUB_USERNAME` | `williamnauroy` (compte Docker Hub, **pas** le compte GitHub) |
| `DOCKERHUB_TOKEN` | le jeton de l'étape 2 |

Ou en ligne de commande :

```bash
gh secret set DOCKERHUB_USERNAME --body williamnauroy
gh secret set DOCKERHUB_TOKEN   # demande la valeur sans l'afficher
```

### 4. Vérifier les droits d'écriture des workflows

Dépôt → **Settings** → **Actions** → **General** → **Workflow permissions** →
**Read and write permissions**.

Sans cela, le job `release` peut échouer en `403` au moment de pousser le tag ou le commit de
changelog.

### 5. Créer le dépôt Docker Hub (optionnel)

Le premier push le crée automatiquement, mais **en privé** si votre compte est configuré ainsi.
Pour une image publique, créez-le d'avance sur Docker Hub en le marquant *Public*.

Si le push échoue sur :

```
push access denied, repository does not exist or may require authorization:
insufficient_scope: authorization failed
```

… l'authentification a réussi mais le compte n'a pas le droit d'écrire dans ce namespace. Vérifiez
dans l'ordre : le préfixe de `IMAGE_NAME` dans `release.yml` correspond bien au compte Docker Hub,
`DOCKERHUB_USERNAME` désigne ce même compte, et le jeton est en *Read & Write*.

### 6. Adopter les Conventional Commits

C'est la seule contrainte quotidienne : sans préfixe `feat:`/`fix:`, aucune version ne sort.

## Points d'attention

**`npm run typecheck` lance `next typegen` avant `tsc`.** Ce n'est pas décoratif. Next 16 génère
des types globaux (`LayoutProps`, `PageProps`, `RouteContext`) et le fichier `next-env.d.ts` —
tous absents d'un dépôt fraîchement cloné, puisque `next-env.d.ts` est dans `.gitignore` comme Next
le recommande. En local ils traînent dans votre `.next/` et tout passe ; sur un runner vierge,
`tsc --noEmit` seul échoue en `TS2304: Cannot find name 'LayoutProps'`. `next typegen` les régénère
sans faire un build complet. Ne retirez pas cette partie du script.

**Une branche `main` protégée bloque semantic-release.** Le `GITHUB_TOKEN` par défaut ne peut pas
pousser sur une branche protégée. Si vous activez la protection, il faut soit ajouter une exception
(*ruleset* avec bypass pour GitHub Actions), soit remplacer `GITHUB_TOKEN` par un PAT dans le job
`release`.

**Les tags poussés par la CI ne déclenchent pas d'autre workflow.** GitHub ignore volontairement les
événements créés avec le `GITHUB_TOKEN`, pour éviter les boucles. C'est précisément pourquoi le push
Docker vit dans le **même** workflow que semantic-release, et lit la version via une sortie de job
plutôt que d'écouter `on: push: tags`. Un workflow séparé déclenché sur tag ne partirait jamais.

**Release créée mais image absente.** Si le build ou le push échoue *après* que semantic-release a
publié, la release GitHub et le tag Git existent sans image sur Docker Hub.

Le rattrapage se fait par **Actions → Release → Run workflow**, en saisissant la version à publier
(`1.0.0`, sans le `v`). Le workflow saute alors `ci` et `release`, et rejoue uniquement le build et
le push depuis le tag `v1.0.0`.

N'utilisez pas *Re-run failed jobs* pour ça : une réexécution rejoue le fichier de workflow **tel
qu'il était** dans le run d'origine. Si la panne vient du workflow lui-même — un mauvais nom
d'image, par exemple — elle se reproduira à l'identique.

> Republier une version ancienne déplace `latest` vers elle. Si vous rattrapez une `1.0.0` alors
> que la `1.0.1` est déjà sortie, republiez la `1.0.1` juste après pour remettre `latest` en place.

**Durée.** Comptez 4 à 7 minutes pour une release complète, l'essentiel étant l'émulation QEMU du
build `arm64`. Le cache GitHub Actions (`type=gha`) est partagé entre le build de validation et le
build de publication.

## Faire évoluer la CI

**Monter les versions de semantic-release.** Elles sont épinglées dans `release.yml` (bloc
`npx --package …`) et volontairement absentes de `package.json` : les y mettre les ferait installer
à chaque `npm ci` du build Docker, pour rien. Pour les mettre à jour :

```bash
npm view semantic-release version
npm view @semantic-release/github version
```

puis modifier les numéros dans `release.yml`.

**Publier des préversions.** Créez une branche `beta`, poussez-y vos commits : la CI publiera
`1.5.0-beta.1`, `1.5.0-beta.2`… Le merge dans `main` sortira la `1.5.0` stable.

**Tester le calcul de version sans rien publier.** En local, sur le dépôt Git à jour :

```bash
npx --yes --package semantic-release@25.0.9 \
  --package conventional-changelog-conventionalcommits@10.3.0 \
  -- semantic-release --dry-run --no-ci
```

**Synchroniser le README vers Docker Hub.** Non configuré par défaut. L'action
[`peter-evans/dockerhub-description`](https://github.com/peter-evans/dockerhub-description) le fait,
au prix d'un jeton supplémentaire.

**Supprimer les secrets à long terme.** Docker Hub sait désormais authentifier GitHub Actions par
OIDC — des identifiants éphémères, plus de jeton stocké. Réservé aux organisations Docker Team,
Business, DHI ou au programme *Docker Sponsored Open Source* ; hors de portée d'un compte personnel
gratuit, mais c'est la cible si le projet passe en organisation.
