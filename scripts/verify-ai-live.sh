#!/usr/bin/env bash
# Starts a real PostgREST + Postgres, applies the real migrations, and runs
# scripts/verify-ai-live.mjs against them with a real signed JWT.
#
# This is the harness that caught the bug where a row was passed where an id
# belonged, which the database answered with:
#   invalid input syntax for type uuid: "[object Object]"
#
# Run: bash scripts/verify-ai-live.sh
# It needs Docker, and it creates and destroys its own containers.
set -uo pipefail

REPO=/home/weirdtdd/projects/swe-projects/central-hub
NET=ch-ai-live
PG=ch-ai-pg
PGRST=ch-ai-pgrst
PGSQLPORT=55440
PGRSTPORT=55441
JWT_SECRET=super-secret-jwt-key-for-the-ai-harness

docker rm -f "$PG" "$PGRST" >/dev/null 2>&1
docker network rm "$NET" >/dev/null 2>&1
docker network create "$NET" >/dev/null 2>&1

docker run -d --name "$PG" --network "$NET" --network-alias postgres \
  -e POSTGRES_PASSWORD=postgres postgres:18-alpine >/dev/null || { echo "FAILED to start postgres"; exit 1; }

for i in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 0.5; done

psql() { docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 "$@"; }

echo "== emulating the Supabase roles =="
psql -q <<'SQL' >/dev/null 2>&1
create role anon nologin;
create role authenticated login;
create role service_role login bypassrls;
create schema if not exists auth;
create table auth.users (id uuid primary key, email text);
-- The real Supabase implementation: PostgREST sets request.jwt.claims (the
-- whole claims JSON) on the transaction, and auth.uid() reads the sub claim
-- out of it. Reading only request.jwt.claim.sub would silently return NULL.
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid;
$$;
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant select on auth.users to anon, authenticated, service_role;
create publication supabase_realtime;
SQL

echo "== applying supabase/apply-all.sql =="
docker exec -i "$PG" psql -U postgres -v ON_ERROR_STOP=1 -q < "$REPO/supabase/apply-all.sql" 2>&1 | sed 's/^/   /'
echo "   exit: ${PIPESTATUS[0]}"

USER_ID=$(docker exec "$PG" psql -U postgres -t -A -c \
  "insert into auth.users (id, email) values (gen_random_uuid(), 'ai-test@example.test') returning id;" 2>&1 \
  | grep -oE '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
echo "== test user: $USER_ID =="

JWT=$(node -e "
const { createHmac } = require('node:crypto');
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const now = Math.floor(Date.now() / 1000);
const head = b64({ alg: 'HS256', typ: 'JWT' });
const body = b64({ role: 'authenticated', sub: '$USER_ID', aud: 'authenticated', iat: now, exp: now + 3600 });
const sig = createHmac('sha256', '$JWT_SECRET').update(head + '.' + body).digest('base64url');
console.log(head + '.' + body + '.' + sig);
")

echo "== starting PostgREST =="
docker run -d --name "$PGRST" --network "$NET" -p ${PGRSTPORT}:3000 \
  -e PGRST_DB_URI="postgres://postgres:postgres@postgres:5432/postgres" \
  -e PGRST_JWT_SECRET="$JWT_SECRET" \
  -e PGRST_DB_ANON_ROLE=authenticated \
  -e PGRST_DB_SCHEMAS=public,auth \
  -e PGRST_SERVER_PORT=3000 \
  postgrest/postgrest:v12.2.3 >/dev/null || { echo "FAILED to start postgrest"; exit 1; }

# PostgREST answers 503 (PGRST002) until its schema cache is loaded, so the
# readiness probe waits for a 200 rather than for any response at all.
echo "== waiting for PostgREST's schema cache =="
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${PGRSTPORT}/ai_runs?select=id" -H "Authorization: Bearer $JWT" || echo 000)
  [ "$code" = "200" ] && { echo "   ready after $i tries"; break; }
  sleep 0.5
done

echo "== running scripts/verify-ai-live.mjs =="
POSTGREST_ORIGIN="http://127.0.0.1:${PGRSTPORT}" \
VITE_SUPABASE_ANON_KEY="$JWT" \
TEST_USER_ID="$USER_ID" \
  node --experimental-websocket "$REPO/scripts/verify-ai-live.mjs" 2>&1 | grep -v "Node.js 20 and below"
STATUS=${PIPESTATUS[0]}

docker rm -f "$PG" "$PGRST" >/dev/null 2>&1
docker network rm "$NET" >/dev/null 2>&1
exit $STATUS
