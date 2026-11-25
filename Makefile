.PHONY: install start stop logs reset nuke db-clear check lint format test

-include .env
export

COMPOSE := docker compose -f infra/docker-compose.yml --env-file .env
REPO_DIR := $(shell pwd)
LAB_PORT ?= 8080

start: install
	@if [ "$(INNGEST_DEV)" = "0" ] || [ "$(INNGEST_DEV)" = "false" ] || [ "$(INNGEST_DEV)" = "False" ]; then \
		echo "Starting in Inngest Cloud mode (INNGEST_DEV=$(INNGEST_DEV)), skipping local inngest-dev container..."; \
		$(COMPOSE) rm -sf inngest-dev >/dev/null 2>&1 || true; \
		$(COMPOSE) up -d postgres adminer memgraph memgraph-lab; \
	else \
		echo "Starting in Local Inngest Dev Server mode (http://localhost:8288)..."; \
		$(COMPOSE) up -d; \
	fi
	@echo "Waiting for postgres to report healthy..."
	@until [ "$$($(COMPOSE) ps -q postgres | xargs docker inspect -f '{{.State.Health.Status}}')" = "healthy" ]; do \
		sleep 1; \
	done
	@echo "Waiting for memgraph to report healthy..."
	@until [ "$$($(COMPOSE) ps -q memgraph | xargs docker inspect -f '{{.State.Health.Status}}')" = "healthy" ]; do \
		sleep 1; \
	done
	bun run migrate
	bun --watch kb/main.ts

stop:
	$(COMPOSE) down

logs:
	$(COMPOSE) logs -f

# Destructive: drops the named volumes.
reset:
	$(COMPOSE) down -v

# More destructive than `reset`: also kills any stray app process left
# holding $(LAB_PORT). It matches on the repo's own path in the process
# command line (bun runs kb/main.ts from this checkout) instead of a process
# name, and only ever targets processes rooted under this checkout. Use this when start/reset leave things in a weird state, not
# for routine teardown (use `reset`).
nuke:
	$(COMPOSE) down -v --remove-orphans
	@for pid in $$(lsof -ti:$(LAB_PORT) 2>/dev/null); do \
		if ps -p "$$pid" -o command= 2>/dev/null | grep -qF "$(REPO_DIR)"; then \
			echo "Killing stray process on :$(LAB_PORT) rooted in this repo: $$pid"; \
			kill -9 "$$pid"; \
		fi; \
	done

# Destructive: deletes every row from every app table (not the schema;
# migrations stay applied) and empties Memgraph, without tearing down the
# containers. Faster than `reset` when you just want a clean corpus mid-session.
db-clear:
	$(COMPOSE) exec -T postgres psql -U "$${POSTGRES_USER:-second_brain}" -d "$${POSTGRES_DB:-second_brain}" -c \
		"DO \$$\$$ DECLARE r RECORD; BEGIN FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'alembic_version' AND tablename <> 'schema_migrations') LOOP EXECUTE 'TRUNCATE TABLE ' || quote_ident(r.tablename) || ' RESTART IDENTITY CASCADE'; END LOOP; END \$$\$$;"
	$(COMPOSE) exec -T memgraph sh -c "echo 'MATCH (n) DETACH DELETE n;' | mgconsole" || true

install:
	bun install --frozen-lockfile

lint: install
	bun run lint

format:
	bun run format

test: install
	bun test

check: lint test
