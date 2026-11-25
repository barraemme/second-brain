-- Baseline: the schema at Alembic revision b8d2e4f6a1c3 (the last Python migration).
-- A database that Alembic already migrated gets this file marked as applied
-- without running it (see kb/db/migrate.ts).

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE publications (
    id UUID NOT NULL PRIMARY KEY,
    slug VARCHAR NOT NULL UNIQUE,
    name VARCHAR NOT NULL,
    feed_url VARCHAR NOT NULL,
    homepage VARCHAR NOT NULL,
    active BOOLEAN NOT NULL
);

CREATE TABLE jobs (
    event_id VARCHAR NOT NULL PRIMARY KEY,
    kind VARCHAR NOT NULL,
    status VARCHAR NOT NULL,
    total INTEGER NOT NULL,
    done INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    publication_id UUID,
    CONSTRAINT fk_jobs_publication_id FOREIGN KEY (publication_id) REFERENCES publications (id)
);

CREATE TABLE articles (
    id UUID NOT NULL PRIMARY KEY,
    canonical_id VARCHAR NOT NULL UNIQUE,
    publication_id UUID NOT NULL REFERENCES publications (id),
    url VARCHAR NOT NULL,
    title VARCHAR NOT NULL,
    author VARCHAR,
    published_at TIMESTAMPTZ NOT NULL,
    content_hash VARCHAR NOT NULL,
    text TEXT NOT NULL,
    status VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cursors (
    publication_id UUID NOT NULL PRIMARY KEY REFERENCES publications (id),
    etag VARCHAR,
    last_modified VARCHAR,
    last_checked_at TIMESTAMPTZ,
    poll_count INTEGER NOT NULL,
    not_modified_count INTEGER NOT NULL
);

CREATE TABLE costs (
    id UUID NOT NULL PRIMARY KEY,
    article_id UUID REFERENCES articles (id),
    model VARCHAR NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    est_usd NUMERIC(10, 6) NOT NULL,
    at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE passages (
    id UUID NOT NULL PRIMARY KEY,
    article_id UUID NOT NULL REFERENCES articles (id),
    chunk_index INTEGER NOT NULL,
    text TEXT NOT NULL,
    embedding vector(1024),
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to TIMESTAMPTZ,
    -- Explicit 'english' config rather than the DB default.
    tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', text)) STORED
);
CREATE INDEX ix_passages_tsv ON passages USING gin (tsv);
-- One current passage per (article, chunk); superseded rows keep their history.
CREATE UNIQUE INDEX uq_passages_article_chunk ON passages (article_id, chunk_index)
    WHERE valid_to IS NULL;
-- ANN index for dense retrieval. HNSW needs no pre-existing data, unlike IVFFlat.
CREATE INDEX ix_passages_embedding_hnsw ON passages USING hnsw (embedding vector_cosine_ops);

CREATE TABLE snapshots (
    snapshot_id VARCHAR NOT NULL PRIMARY KEY,
    question TEXT NOT NULL,
    answer_text TEXT NOT NULL,
    citations JSONB NOT NULL,
    retrieved JSONB NOT NULL,
    retriever_variant VARCHAR NOT NULL,
    as_of TIMESTAMPTZ,
    confidence NUMERIC(5, 4),
    latency_ms INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ix_snapshots_created_at ON snapshots (created_at);

CREATE TABLE failures (
    id UUID NOT NULL PRIMARY KEY,
    function_id VARCHAR NOT NULL,
    run_id VARCHAR NOT NULL,
    error TEXT NOT NULL,
    event_data JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE claims (
    id UUID NOT NULL PRIMARY KEY,
    article_id UUID NOT NULL REFERENCES articles (id),
    text TEXT NOT NULL,
    quote_span TEXT NOT NULL,
    claim_type VARCHAR NOT NULL,
    entities JSONB NOT NULL,
    confidence NUMERIC(4, 3) NOT NULL DEFAULT 1.0,
    valid_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    valid_to TIMESTAMPTZ,
    supersedes_id UUID REFERENCES claims (id)
);
CREATE INDEX ix_claims_article_active ON claims (article_id) WHERE valid_to IS NULL;

CREATE TABLE eval_results (
    id UUID NOT NULL PRIMARY KEY,
    snapshot_id VARCHAR NOT NULL REFERENCES snapshots (snapshot_id),
    deterministic_passed BOOLEAN NOT NULL,
    checks JSONB NOT NULL,
    faithfulness_verdict VARCHAR NOT NULL,
    faithfulness_critique TEXT NOT NULL,
    disagreement_verdict VARCHAR NOT NULL,
    disagreement_critique TEXT NOT NULL,
    failure_codes JSONB NOT NULL,
    composite_score NUMERIC(5, 4) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_eval_results_snapshot_id UNIQUE (snapshot_id)
);

CREATE TABLE eval_runs (
    run_id VARCHAR NOT NULL PRIMARY KEY,
    suite_name VARCHAR NOT NULL,
    variants_summary JSONB NOT NULL,
    case_results JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE research_runs (
    research_id VARCHAR NOT NULL PRIMARY KEY,
    event_id VARCHAR,
    question TEXT NOT NULL,
    status VARCHAR NOT NULL,
    plan JSONB NOT NULL,
    hops JSONB NOT NULL,
    report_text TEXT,
    citations JSONB NOT NULL,
    retrieved JSONB NOT NULL,
    eval_summary JSONB NOT NULL,
    confidence NUMERIC(5, 4),
    iterations_used INTEGER NOT NULL,
    total_cost_usd NUMERIC(10, 6) NOT NULL,
    latency_ms INTEGER NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE TABLE digests (
    digest_id UUID NOT NULL PRIMARY KEY,
    window_start TIMESTAMPTZ NOT NULL,
    window_end TIMESTAMPTZ NOT NULL,
    title VARCHAR NOT NULL,
    summary_markdown TEXT NOT NULL,
    citations JSONB NOT NULL,
    stats JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
