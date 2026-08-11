#!/bin/bash
# Prépare le fichier .env utilisé par le service factorio-admin :
# génère les mots de passe des rôles et la clé de signature des sessions.
#
# Les valeurs déjà présentes sont conservées par défaut ; utiliser --force
# pour les régénérer (ce qui invalide toutes les sessions ouvertes).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

FORCE=false
ASSUME_YES=false
ASK_PASSWORDS=false
WITH_MODERATOR=false
WITH_VIEWER=false

usage() {
    cat <<'EOF'
Usage: ./setup-admin.sh [options]

Crée ou met à jour le fichier .env lu par docker-compose pour le panneau d'admin.

Options:
  -m, --moderator      Créer aussi un mot de passe MODERATOR_PASSWORD
                       (kick, ban, mute, messages ; pas de console RCON brute)
  -v, --viewer         Créer aussi un mot de passe VIEWER_PASSWORD (lecture seule)
  -a, --all            Équivaut à --moderator --viewer
  -f, --force          Régénérer les valeurs déjà présentes
                       (invalide les sessions en cours)
      --ask            Saisir les mots de passe soi-même au lieu de les générer
  -e, --env-file PATH  Utiliser un autre fichier que ./.env
  -y, --yes            Ne poser aucune question (mode non interactif)
  -h, --help           Afficher cette aide

Exemples:
  ./setup-admin.sh                 # ADMIN_PASSWORD + SESSION_SECRET
  ./setup-admin.sh --all           # les trois rôles
  ./setup-admin.sh --force --yes   # rotation complète, sans question
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        -m|--moderator) WITH_MODERATOR=true ;;
        -v|--viewer) WITH_VIEWER=true ;;
        -a|--all) WITH_MODERATOR=true; WITH_VIEWER=true ;;
        -f|--force) FORCE=true ;;
        --ask) ASK_PASSWORDS=true ;;
        -y|--yes) ASSUME_YES=true ;;
        -e|--env-file)
            if [[ $# -lt 2 ]]; then
                echo "erreur: --env-file attend un chemin" >&2
                exit 1
            fi
            ENV_FILE="$2"
            shift
            ;;
        -h|--help) usage; exit 0 ;;
        *)
            echo "erreur: option inconnue '$1'" >&2
            usage >&2
            exit 1
            ;;
    esac
    shift
done

# Génère une valeur aléatoire de N octets, en hexadécimal.
generate_secret() {
    local bytes="$1"

    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$bytes"
    elif [[ -r /dev/urandom ]]; then
        od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
    else
        echo "erreur: ni openssl ni /dev/urandom disponibles pour générer un secret" >&2
        exit 1
    fi
}

get_env_var() {
    local key="$1"

    [[ -f "$ENV_FILE" ]] || return 0
    # Dernière occurrence : c'est celle que docker-compose retient.
    grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

# Remplace la valeur si la clé existe, l'ajoute sinon.
upsert_env_var() {
    local key="$1" value="$2" tmp

    if [[ ! -f "$ENV_FILE" ]]; then
        printf '%s=%s\n' "$key" "$value" >"$ENV_FILE"
        return
    fi

    tmp="$(mktemp)"
    grep -vE "^${key}=" "$ENV_FILE" >"$tmp" || true
    # Garantit un saut de ligne final avant d'ajouter la nouvelle valeur.
    if [[ -s "$tmp" ]] && [[ -n "$(tail -c 1 "$tmp")" ]]; then
        printf '\n' >>"$tmp"
    fi
    printf '%s=%s\n' "$key" "$value" >>"$tmp"
    cat "$tmp" >"$ENV_FILE"
    rm -f "$tmp"
}

confirm() {
    local question="$1"

    if [[ "$ASSUME_YES" == true ]]; then
        return 1
    fi
    if [[ ! -t 0 ]]; then
        return 1
    fi

    local answer
    read -r -p "$question [o/N] " answer
    [[ "$answer" == "o" || "$answer" == "O" || "$answer" == "y" || "$answer" == "Y" ]]
}

read_password() {
    local label="$1" first second

    while true; do
        read -r -s -p "  Mot de passe $label : " first
        echo >&2
        read -r -s -p "  Confirmer            : " second
        echo >&2

        if [[ -z "$first" ]]; then
            echo "  (vide, recommencez)" >&2
            continue
        fi
        if [[ "$first" != "$second" ]]; then
            echo "  (ne correspondent pas, recommencez)" >&2
            continue
        fi
        if [[ "$first" == *$'\n'* ]]; then
            echo "  (retour à la ligne interdit)" >&2
            continue
        fi

        printf '%s' "$first"
        return
    done
}

# Renseigne une variable : conservée si déjà définie, sinon générée ou saisie.
# Alimente GENERATED / KEPT pour le récapitulatif final.
GENERATED=()
KEPT=()

ensure_var() {
    local key="$1" label="$2" bytes="$3" existing value

    existing="$(get_env_var "$key")"

    if [[ -n "$existing" && "$FORCE" != true ]]; then
        KEPT+=("$key")
        return
    fi

    if [[ -n "$existing" && "$FORCE" == true ]]; then
        echo "→ rotation de $key ($label)"
    else
        echo "→ création de $key ($label)"
    fi

    if [[ "$ASK_PASSWORDS" == true && "$key" != "SESSION_SECRET" ]]; then
        if [[ ! -t 0 ]]; then
            echo "erreur: --ask nécessite un terminal interactif" >&2
            exit 1
        fi
        value="$(read_password "$label")"
    else
        value="$(generate_secret "$bytes")"
    fi

    upsert_env_var "$key" "$value"
    GENERATED+=("$key=$value")
}

echo "Fichier : $ENV_FILE"

if [[ ! -f "$ENV_FILE" ]]; then
    touch "$ENV_FILE"
    echo "→ fichier créé"
fi

# Lisible par le seul propriétaire : il contient des secrets.
chmod 600 "$ENV_FILE"

ensure_var ADMIN_PASSWORD "administrateur — accès complet, console RCON incluse" 16

if [[ "$WITH_MODERATOR" == true ]]; then
    ensure_var MODERATOR_PASSWORD "modérateur — kick, ban, mute, messages" 16
fi

if [[ "$WITH_VIEWER" == true ]]; then
    ensure_var VIEWER_PASSWORD "observateur — lecture seule" 16
fi

# Clé indépendante des mots de passe : changer un mot de passe ne casse plus
# la signature des cookies de session.
ensure_var SESSION_SECRET "clé de signature des sessions" 32

echo

if [[ ${#KEPT[@]} -gt 0 ]]; then
    echo "Valeurs existantes conservées : ${KEPT[*]}"
    echo "  (./setup-admin.sh --force pour les régénérer)"
fi

if [[ ${#GENERATED[@]} -gt 0 ]]; then
    echo "Nouvelles valeurs (notez-les, elles ne seront plus affichées) :"
    for entry in "${GENERATED[@]}"; do
        key="${entry%%=*}"
        value="${entry#*=}"
        if [[ "$key" == "SESSION_SECRET" ]]; then
            echo "  $key = (généré, aucun usage manuel)"
        else
            echo "  $key = $value"
        fi
    done
fi

if [[ ${#GENERATED[@]} -gt 0 ]] && grep -qE '^(MODERATOR|VIEWER)_PASSWORD=' "$ENV_FILE"; then
    echo
    echo "Rappel : le rôle est déterminé par le mot de passe utilisé à la connexion."
fi

echo
echo "Étapes suivantes :"
echo "  docker compose up -d --build factorio-admin"
echo "  puis http://127.0.0.1:3010"

if [[ ${#KEPT[@]} -gt 0 || ${#GENERATED[@]} -gt 0 ]] && confirm "Démarrer le panneau maintenant ?"; then
    echo
    (cd "$SCRIPT_DIR" && docker compose up -d --build factorio-admin)
fi
