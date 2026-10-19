-- Predefined plans have owner_account_id = NULL; custom plans belong to one account.
CREATE TABLE plans (
    id                     uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    owner_account_id       uuid        NULL,
    scope                  text        NOT NULL CHECK (scope IN ('account', 'user')),
    name                   text        NOT NULL CHECK (length(trim(name)) > 0),
    monthly_allowance      bigint      NOT NULL CHECK (monthly_allowance >= 0),
    max_units_per_request  bigint      NOT NULL CHECK (max_units_per_request >= 1),
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    -- lets accounts/users reference (id, scope) so the DB rejects a plan of the wrong scope
    CONSTRAINT plans_id_scope_unique UNIQUE (id, scope)
);

-- NULL owners would never collide in a plain unique index, hence the COALESCE.
CREATE UNIQUE INDEX plans_owner_scope_name_unique
    ON plans (COALESCE(owner_account_id, '00000000-0000-0000-0000-000000000000'::uuid), scope, lower(name));

CREATE TABLE accounts (
    id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text        NOT NULL CHECK (length(trim(name)) > 0),
    -- sha256 of the key; the raw key is only returned once at creation
    api_key_hash     text        NOT NULL UNIQUE,
    api_key_prefix   text        NOT NULL,
    plan_id          uuid        NOT NULL,
    plan_scope       text        NOT NULL DEFAULT 'account' CHECK (plan_scope = 'account'),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT accounts_plan_fk FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);

ALTER TABLE plans
    ADD CONSTRAINT plans_owner_fk FOREIGN KEY (owner_account_id) REFERENCES accounts (id) ON DELETE CASCADE;

CREATE TABLE users (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    account_id   uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    external_id  text        NOT NULL CHECK (length(external_id) BETWEEN 1 AND 128),
    plan_id      uuid        NOT NULL,
    plan_scope   text        NOT NULL DEFAULT 'user' CHECK (plan_scope = 'user'),
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT users_account_external_unique UNIQUE (account_id, external_id),
    CONSTRAINT users_plan_fk FOREIGN KEY (plan_id, plan_scope) REFERENCES plans (id, scope)
);

CREATE TABLE plan_assignments (
    id           bigserial   PRIMARY KEY,
    account_id   uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    user_id      uuid        NULL REFERENCES users (id) ON DELETE CASCADE,
    plan_id      uuid        NOT NULL REFERENCES plans (id),
    assigned_at  timestamptz NOT NULL DEFAULT now()
);

-- Monthly counters. period is always the first day of a UTC month.
CREATE TABLE account_usage (
    account_id  uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    period      date        NOT NULL CHECK (extract(day FROM period) = 1),
    used        bigint      NOT NULL DEFAULT 0 CHECK (used >= 0),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (account_id, period)
);

CREATE TABLE user_usage (
    user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    account_id  uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    period      date        NOT NULL CHECK (extract(day FROM period) = 1),
    used        bigint      NOT NULL DEFAULT 0 CHECK (used >= 0),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, period)
);

CREATE INDEX user_usage_account_period_idx ON user_usage (account_id, period);

-- Every decision (accepted or rejected). Also the idempotency store, and it keeps
-- a copy of the limits that were applied so history survives plan edits.
CREATE TABLE usage_requests (
    id                     bigserial   PRIMARY KEY,
    account_id             uuid        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
    user_id                uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    request_id             text        NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),
    units                  bigint      NOT NULL CHECK (units >= 1),
    accepted               boolean     NOT NULL,
    period                 date        NOT NULL,
    rejection_scope        text        NULL CHECK (rejection_scope IN ('account', 'user')),
    rejection_rule         text        NULL,
    violations             jsonb       NOT NULL DEFAULT '[]'::jsonb,
    account_plan_id        uuid        NOT NULL REFERENCES plans (id),
    account_monthly_limit  bigint      NOT NULL,
    account_request_limit  bigint      NOT NULL,
    account_used_after     bigint      NOT NULL,
    user_plan_id           uuid        NOT NULL REFERENCES plans (id),
    user_monthly_limit     bigint      NOT NULL,
    user_request_limit     bigint      NOT NULL,
    user_used_after        bigint      NOT NULL,
    decided_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT usage_requests_idempotency UNIQUE (account_id, request_id),
    CONSTRAINT usage_requests_reason_consistent CHECK (
        (accepted AND rejection_scope IS NULL AND rejection_rule IS NULL)
        OR (NOT accepted AND rejection_scope IS NOT NULL AND rejection_rule IS NOT NULL)
    )
);

CREATE INDEX usage_requests_account_id_idx ON usage_requests (account_id, id DESC);
CREATE INDEX usage_requests_user_id_idx ON usage_requests (user_id, id DESC);
CREATE INDEX usage_requests_account_period_idx ON usage_requests (account_id, period, id DESC);
