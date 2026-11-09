#!/bin/sh
set -eu
: "${APP_DATABASE_PASSWORD:?Missing application database password}"

# The application can read/write its records but cannot change roles or schema.
# Migrations use the separate postgres administrator connection.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set=app_password="$APP_DATABASE_PASSWORD" --set=target_database="$POSTGRES_DB" <<'SQL'
SELECT format('CREATE ROLE skillbetting_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname='skillbetting_app') \gexec
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE :"target_database" TO skillbetting_app;
GRANT USAGE ON SCHEMA public TO skillbetting_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO skillbetting_app;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO skillbetting_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO skillbetting_app;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO skillbetting_app;
SQL
