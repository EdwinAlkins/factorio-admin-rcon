#!/bin/bash
# Prepares the .env file used by the factorio-admin service:
# generates the role passwords and the session signing key.
#
# Values already present are kept by default; use --force to regenerate them
# (which invalidates every open session).

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

Creates or updates the .env file read by docker-compose for the admin panel.

Options:
  -m, --moderator      Also create a MODERATOR_PASSWORD
                       (kick, ban, mute, messages; no raw RCON console)
  -v, --viewer         Also create a VIEWER_PASSWORD (read only)
  -a, --all            Same as --moderator --viewer
  -f, --force          Regenerate values that are already set
                       (invalidates open sessions)
      --ask            Type the passwords yourself instead of generating them
  -e, --env-file PATH  Use a file other than ./.env
  -y, --yes            Ask no questions (non-interactive mode)
  -h, --help           Show this help

Examples:
  ./setup-admin.sh                 # ADMIN_PASSWORD + SESSION_SECRET
  ./setup-admin.sh --all           # all three roles
  ./setup-admin.sh --force --yes   # full rotation, no questions asked
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
                echo "error: --env-file expects a path" >&2
                exit 1
            fi
            ENV_FILE="$2"
            shift
            ;;
        -h|--help) usage; exit 0 ;;
        *)
            echo "error: unknown option '$1'" >&2
            usage >&2
            exit 1
            ;;
    esac
    shift
done

# Generates a random value of N bytes, hex encoded.
generate_secret() {
    local bytes="$1"

    if command -v openssl >/dev/null 2>&1; then
        openssl rand -hex "$bytes"
    elif [[ -r /dev/urandom ]]; then
        od -An -tx1 -N "$bytes" /dev/urandom | tr -d ' \n'
    else
        echo "error: neither openssl nor /dev/urandom available to generate a secret" >&2
        exit 1
    fi
}

get_env_var() {
    local key="$1"

    [[ -f "$ENV_FILE" ]] || return 0
    # Last occurrence: that is the one docker-compose keeps.
    grep -E "^${key}=" "$ENV_FILE" | tail -n 1 | cut -d= -f2- || true
}

# Replaces the value if the key exists, appends it otherwise.
upsert_env_var() {
    local key="$1" value="$2" tmp

    if [[ ! -f "$ENV_FILE" ]]; then
        printf '%s=%s\n' "$key" "$value" >"$ENV_FILE"
        return
    fi

    tmp="$(mktemp)"
    grep -vE "^${key}=" "$ENV_FILE" >"$tmp" || true
    # Guarantees a trailing newline before appending the new value.
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
    read -r -p "$question [y/N] " answer
    [[ "$answer" == "y" || "$answer" == "Y" ]]
}

read_password() {
    local label="$1" first second

    while true; do
        read -r -s -p "  Password for $label: " first
        echo >&2
        read -r -s -p "  Confirm            : " second
        echo >&2

        if [[ -z "$first" ]]; then
            echo "  (empty, try again)" >&2
            continue
        fi
        if [[ "$first" != "$second" ]]; then
            echo "  (they do not match, try again)" >&2
            continue
        fi
        if [[ "$first" == *$'\n'* ]]; then
            echo "  (line breaks are not allowed)" >&2
            continue
        fi

        printf '%s' "$first"
        return
    done
}

# Fills in a variable: kept if already set, otherwise generated or typed in.
# Feeds GENERATED / KEPT for the final summary.
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
        echo "→ rotating $key ($label)"
    else
        echo "→ creating $key ($label)"
    fi

    if [[ "$ASK_PASSWORDS" == true && "$key" != "SESSION_SECRET" ]]; then
        if [[ ! -t 0 ]]; then
            echo "error: --ask requires an interactive terminal" >&2
            exit 1
        fi
        value="$(read_password "$label")"
    else
        value="$(generate_secret "$bytes")"
    fi

    upsert_env_var "$key" "$value"
    GENERATED+=("$key=$value")
}

echo "File: $ENV_FILE"

if [[ ! -f "$ENV_FILE" ]]; then
    touch "$ENV_FILE"
    echo "→ file created"
fi

# Readable by its owner only: it holds secrets.
chmod 600 "$ENV_FILE"

ensure_var ADMIN_PASSWORD "administrator — full access, raw RCON console included" 16

if [[ "$WITH_MODERATOR" == true ]]; then
    ensure_var MODERATOR_PASSWORD "moderator — kick, ban, mute, messages" 16
fi

if [[ "$WITH_VIEWER" == true ]]; then
    ensure_var VIEWER_PASSWORD "viewer — read only" 16
fi

# Key independent from the passwords: changing a password no longer breaks the
# session cookie signature.
ensure_var SESSION_SECRET "session signing key" 32

echo

if [[ ${#KEPT[@]} -gt 0 ]]; then
    echo "Existing values kept: ${KEPT[*]}"
    echo "  (./setup-admin.sh --force to regenerate them)"
fi

if [[ ${#GENERATED[@]} -gt 0 ]]; then
    echo "New values (write them down, they will not be shown again):"
    for entry in "${GENERATED[@]}"; do
        key="${entry%%=*}"
        value="${entry#*=}"
        if [[ "$key" == "SESSION_SECRET" ]]; then
            echo "  $key = (generated, never used by hand)"
        else
            echo "  $key = $value"
        fi
    done
fi

if [[ ${#GENERATED[@]} -gt 0 ]] && grep -qE '^(MODERATOR|VIEWER)_PASSWORD=' "$ENV_FILE"; then
    echo
    echo "Reminder: the role is determined by the password used to sign in."
fi

echo
echo "Next steps:"
echo "  docker compose up -d --build factorio-admin"
echo "  then http://127.0.0.1:3010"

if [[ ${#KEPT[@]} -gt 0 || ${#GENERATED[@]} -gt 0 ]] && confirm "Start the panel now?"; then
    echo
    (cd "$SCRIPT_DIR" && docker compose up -d --build factorio-admin)
fi
