-- Central Hub — allow a question to be recorded as an AI run.
-- Date: 2026-10-22
--
-- The chat asks a question about the caller's own records. The run is still
-- one row in ai_runs, so the question, the model and the answer stay
-- traceable. The original check only allowed the three one-shot analyses.
--
-- ADDITIVE: no rows are changed. A question cannot be stored until this
-- constraint includes 'ask'.

alter table public.ai_runs drop constraint if exists ai_runs_kind_valid;
alter table public.ai_runs
  add constraint ai_runs_kind_valid
  check (kind in ('day_summary','classify_activity','priorities','ask'));
