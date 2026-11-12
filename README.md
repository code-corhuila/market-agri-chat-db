# market-agri-chat-db

Schema of the database **`chat`** (MongoDB 7) of chat-service, migrated with **Liquibase and its MongoDB
extension** (Anexo B). The instance and the user `chat_app` belong to `market-agri-infra-mongo`; this
repository holds only the migrations and, in `deploy/`, the runner that applies them (Anexo J).

| Collection | Purpose | Key rules |
|---|---|---|
| `conversation` | One thread per (product, buyer), with the snapshots `ConversationView` shows | unique `idx_conversation_productId_buyerId` (AGGR-INV-001); `agreedPurchaseMethod` ∈ `PLATFORM`, `OFF_PLATFORM`, `null` |
| `message` | One message of a conversation (not embedded: unbounded) | `content` 1–2000 (D-C34); unique `idx_message_senderId_requestId` (a resent `message.send` stores nothing) |
| `outbox_event` | `NewChatMessage` events waiting for the relay (ADR-014) | written with the message in one transaction |

Every collection is created **with** its `$jsonSchema` validator (`validationLevel: strict`,
`validationAction: error`, `additionalProperties: false`). Role `chat_writer` (find, insert, update; no
remove) granted to `chat_app`. Seed (context `dev,qa` only): the conversation the checkout E2E flows
buy from.

## Layout (Anexo B)

`changelog/changelog-master.yaml` → `01_ddl/` (`00_collections` with validators, `01_validators` for
later `collMod`, `02_indexes`, `03_views`) → `02_dml/` (seeds and patches) → `03_dcl/00_roles`.
Each changeset declares its rollback inline; there is no `04_alter` (no foreign keys in MongoDB).

## Migrate (from market-agri-infra)

```bash
docker compose --env-file env/dev.env run --rm --build chat-db-migrate
```

Control collections: `databasechangelog_chat` and `databasechangeloglock_chat`.

## Local db-ci (Docker; destructive for the database chat, dev only)

```bash
bash tests/db-ci.sh ../../market-agri-infra-mongo/env/dev.env
```

Builds the runner, updates, checks that a second run applies nothing, runs `tests/collections.js`
(validators, indexes, role, seed), rolls everything back (no collection nor role left) and updates again.

## Branching

`develop`, `qa` and `main` accept no direct commit: child branch + squash PR to `develop`,
`qa-<SUBTASK-ID>` with `cherry-pick -x` and *Rebase and merge* to `qa`, `release.2.Y.Z` to `main`
with the teacher's approval (`git-conventions` in `market-agri-docs`).
