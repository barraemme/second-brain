-- The Python models filled these defaults in application code (SQLAlchemy
-- `default=`). The database now owns them, so every writer gets the same values.
-- gen_random_uuid() is built into Postgres 13+.

ALTER TABLE publications ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE publications ALTER COLUMN active SET DEFAULT true;

ALTER TABLE articles ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE articles ALTER COLUMN status SET DEFAULT 'ingested';

ALTER TABLE passages ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE cursors ALTER COLUMN poll_count SET DEFAULT 0;
ALTER TABLE cursors ALTER COLUMN not_modified_count SET DEFAULT 0;

ALTER TABLE jobs ALTER COLUMN status SET DEFAULT 'pending';
ALTER TABLE jobs ALTER COLUMN total SET DEFAULT 0;
ALTER TABLE jobs ALTER COLUMN done SET DEFAULT 0;

ALTER TABLE costs ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE costs ALTER COLUMN input_tokens SET DEFAULT 0;
ALTER TABLE costs ALTER COLUMN output_tokens SET DEFAULT 0;
ALTER TABLE costs ALTER COLUMN est_usd SET DEFAULT 0;

ALTER TABLE snapshots ALTER COLUMN citations SET DEFAULT '[]'::jsonb;
ALTER TABLE snapshots ALTER COLUMN retrieved SET DEFAULT '[]'::jsonb;

ALTER TABLE failures ALTER COLUMN id SET DEFAULT gen_random_uuid();

ALTER TABLE claims ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE claims ALTER COLUMN entities SET DEFAULT '[]'::jsonb;

ALTER TABLE eval_results ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE eval_results ALTER COLUMN checks SET DEFAULT '{}'::jsonb;
ALTER TABLE eval_results ALTER COLUMN failure_codes SET DEFAULT '[]'::jsonb;
ALTER TABLE eval_results ALTER COLUMN composite_score SET DEFAULT 0;

ALTER TABLE eval_runs ALTER COLUMN variants_summary SET DEFAULT '{}'::jsonb;
ALTER TABLE eval_runs ALTER COLUMN case_results SET DEFAULT '[]'::jsonb;

ALTER TABLE research_runs ALTER COLUMN status SET DEFAULT 'running';
ALTER TABLE research_runs ALTER COLUMN plan SET DEFAULT '[]'::jsonb;
ALTER TABLE research_runs ALTER COLUMN hops SET DEFAULT '[]'::jsonb;
ALTER TABLE research_runs ALTER COLUMN citations SET DEFAULT '[]'::jsonb;
ALTER TABLE research_runs ALTER COLUMN retrieved SET DEFAULT '[]'::jsonb;
ALTER TABLE research_runs ALTER COLUMN eval_summary SET DEFAULT '{}'::jsonb;
ALTER TABLE research_runs ALTER COLUMN iterations_used SET DEFAULT 0;
ALTER TABLE research_runs ALTER COLUMN total_cost_usd SET DEFAULT 0;
ALTER TABLE research_runs ALTER COLUMN latency_ms SET DEFAULT 0;

ALTER TABLE digests ALTER COLUMN digest_id SET DEFAULT gen_random_uuid();
ALTER TABLE digests ALTER COLUMN citations SET DEFAULT '[]'::jsonb;
ALTER TABLE digests ALTER COLUMN stats SET DEFAULT '{}'::jsonb;
