#!/usr/bin/env bash
# Local db-ci of chat-db (Anexo B, "Cómo se verifica"), against the MongoDB instance of an
# environment started by market-agri-infra-mongo (or market-agri-infra). From the root of this repo:
#   bash tests/db-ci.sh ../../market-agri-infra-mongo/env/dev.env
# Steps: build the runner image -> update from empty -> a second update applies nothing -> checks of
# tests/collections.js -> rollback of everything leaves no collection nor role -> update again.
# Destructive for the database chat: only with a dev env file (or a throwaway instance in CI).
set -uo pipefail

ENV_FILE="${1:?usage: bash tests/db-ci.sh <env file of the instance>}"
[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; exit 2; }
setting() { sed -n "s/^$1=//p" "$ENV_FILE" | tr -d '\r'; }
ENV_NAME="$(setting ENV)"
[ "$ENV_NAME" = "dev" ] || [ "${CI:-}" = "true" ] || { echo "refusing to run against $ENV_NAME"; exit 2; }
PROJECT="$(setting COMPOSE_PROJECT_NAME)"
IMAGE=market-agri-chat-db-migrate:ci
failures=0
pass() { echo "ok   - $1"; }
fail() { echo "FAIL - $1"; failures=$((failures + 1)); }

mongo_cid="$(docker ps -q -f "label=com.docker.compose.project=$PROJECT" -f label=com.docker.compose.service=mongo)"
[ -n "$mongo_cid" ] || { echo "no running mongo for project $PROJECT"; exit 2; }

# The URL carries the administrator's password: it goes to the container as an environment variable
# copied from this shell (-e without a value), never as an argument.
export LIQUIBASE_COMMAND_URL="mongodb://$(setting MONGO_ADMIN_USER):$(setting MONGO_ADMIN_PASSWORD)@mongo:27017/chat?authSource=admin&replicaSet=rs0"
workspace="$(pwd -W 2>/dev/null || pwd)"     # Git Bash on Windows needs the D:/… form
liquibase() {
  MSYS_NO_PATHCONV=1 docker run --rm --network "platform-$ENV_NAME" -e LIQUIBASE_COMMAND_URL \
    --mount "type=bind,src=$workspace,dst=/workspace,readonly" "$IMAGE" \
    --search-path=/workspace --changelog-file=changelog/changelog-master.yaml \
    --database-changelog-table-name=databasechangelog_chat \
    --database-changelog-lock-table-name=databasechangeloglock_chat "$@"
}
# as_admin: runs the script read from stdin with mongosh as the administrator, as a file (piped
# straight into mongosh it would run as an interactive shell and print its prompt on every line).
as_admin() {
  docker exec -i "$mongo_cid" sh -c 'cat > /tmp/chat-db-check.js && mongosh --quiet --host mongo \
    -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin chat \
    --file /tmp/chat-db-check.js' 2>/dev/null
}
domain_state() {   # collections other than Liquibase's, and whether chat_writer exists
  echo 'print(db.getCollectionNames().filter(c => !c.startsWith("databasechangelog")).sort().join(",") + "|" + (db.getRole("chat_writer") !== null))' | as_admin | tr -d '\r'
}

docker build -q -f deploy/liquibase.Dockerfile -t "$IMAGE" deploy > /dev/null \
  && pass "runner image with the MongoDB extension builds" || { fail "runner image builds"; exit 1; }

if liquibase update > /tmp/chat-db-update.log 2>&1; then pass "update from the current state"; else fail "update"; cat /tmp/chat-db-update.log; fi
# A second update applies nothing: the control collection keeps the same number of changesets.
applied() { echo 'print(db.databasechangelog_chat.countDocuments())' | as_admin | tr -d '\r'; }
before="$(applied)"
liquibase update > /dev/null 2>&1
after="$(applied)"
[ -n "$before" ] && [ "$before" -gt 0 ] && [ "$before" = "$after" ] && pass "a second run has nothing to apply ($after changesets)" \
  || fail "a second run has nothing to apply (before: $before, after: $after)"
if as_admin < tests/collections.js; then pass "tests/collections.js"; else fail "tests/collections.js"; fi

liquibase rollback-count --count=1000 > /tmp/chat-db-rollback.log 2>&1 && pass "rollback of every changeset" \
  || { fail "rollback of every changeset"; cat /tmp/chat-db-rollback.log; }
[ "$(domain_state)" = "|false" ] && pass "after rollback: no domain collection and no role" \
  || fail "after rollback: no domain collection and no role (got: $(domain_state))"
liquibase update > /dev/null 2>&1 && [ "$(domain_state)" = "conversation,message,outbox_event|true" ] \
  && pass "update again rebuilds everything" || fail "update again rebuilds everything"

echo
if [ "$failures" -eq 0 ]; then echo "db-ci: all checks passed"; else echo "db-ci: $failures FAIL"; exit 1; fi
