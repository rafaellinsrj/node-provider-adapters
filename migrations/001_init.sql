-- Schema for the PostgreSQL store (src/store/postgres.ts). Amounts are integer minor units; no floats for money.

CREATE TABLE creators (
  id             text PRIMARY KEY,
  tier           text NOT NULL,
  payout_account text NOT NULL
);

CREATE TABLE orders (
  id             text PRIMARY KEY,
  creator_id     text NOT NULL REFERENCES creators(id),
  amount_cents   bigint NOT NULL CHECK (amount_cents > 0),
  currency       text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  payment_method text NOT NULL,
  status         text NOT NULL CHECK (status IN ('pending','paid','failed','partially_refunded','refunded')),
  split          jsonb NOT NULL,
  payment_id     text UNIQUE,
  refunded_cents bigint NOT NULL DEFAULT 0 CHECK (refunded_cents >= 0 AND refunded_cents <= amount_cents),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Outbox of provider calls. One row per (subject, kind, part): retries reuse the row and therefore the key.
CREATE TABLE provider_operations (
  id               text PRIMARY KEY,
  kind             text NOT NULL,
  subject_id       text NOT NULL,
  part             integer NOT NULL DEFAULT 0,
  status           text NOT NULL CHECK (status IN ('prepared','running','succeeded','failed','unknown','blocked')),
  request          jsonb NOT NULL,
  result           jsonb,
  config_digest    text NOT NULL,
  attempts         integer NOT NULL DEFAULT 0,
  first_attempt_at timestamptz,
  available_at     timestamptz NOT NULL DEFAULT now(),
  lease_token      text,
  lease_until      timestamptz,
  error_code       text,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (subject_id, kind, part)
);
CREATE INDEX provider_operations_due ON provider_operations (kind, status, available_at);

-- Webhook deliveries already applied. The primary key is the deduplication.
CREATE TABLE provider_events (
  provider       text NOT NULL,
  event_id       text NOT NULL,
  payload_digest text NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- Append-only money movements derived from confirmed provider objects.
CREATE TABLE ledger_entries (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  order_id     text NOT NULL REFERENCES orders(id),
  account      text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('sale','commission','processing','refund')),
  amount_cents bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_order ON ledger_entries (order_id);
