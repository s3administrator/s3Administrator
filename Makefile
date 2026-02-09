.PHONY: help check-node dev build start db-up db-down db-reset migrate generate studio lint clean docker-build docker-up docker-down nuke setup seed wait-db prod prod-check prod-migrate prod-seed

DC = docker compose --env-file .env -f docker/docker-compose.yml
PRISMA_CLI_VERSION = 6.19.2

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

check-node: ## Ensure local Node.js version meets Next.js requirements (>=20.9.0)
	@command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js >=20.9.0 is required but 'node' is not installed."; exit 1; }
	@node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 20 || (major === 20 && minor < 9)) { console.error("ERROR: Node.js " + process.version + " detected. Required >=20.9.0."); process.exit(1); }'

# ─── Development ─────────────────────────────────────────

dev: check-node ## Start development server
	npm run dev

build: check-node ## Build for production
	npx prisma generate && npm run build

start: check-node ## Start production server
	npm run start

lint: check-node ## Run linter
	npm run lint

# ─── Database ────────────────────────────────────────────

db-up: ## Start PostgreSQL via Docker Compose
	$(DC) up db -d

db-down: ## Stop PostgreSQL
	$(DC) down

db-reset: check-node ## Reset database (drop all tables and re-migrate)
	npx prisma migrate reset --force

migrate: check-node ## Run database migrations
	npx prisma migrate dev

migrate-deploy: check-node ## Deploy migrations (production)
	npx prisma migrate deploy

generate: check-node ## Generate Prisma client
	npx prisma generate

studio: check-node ## Open Prisma Studio (DB GUI)
	npx prisma studio

seed: check-node ## Seed the database with default plans
	npx prisma db seed

# ─── Docker Production ───────────────────────────────────

docker-build: ## Build Docker image
	$(DC) build

docker-up: ## Start all services (app + db) — blocks if PROD uses default password
	@. ./.env 2>/dev/null; \
	if [ "$$ENVIRONMENT" = "PROD" ] && [ "$$POSTGRES_PASSWORD" = "password" ]; then \
		echo "ERROR: Cannot start PROD with default POSTGRES_PASSWORD. Set a strong password in .env"; exit 1; \
	fi
	$(DC) up -d

docker-down: ## Stop all services
	$(DC) down

docker-logs: ## View app logs
	$(DC) logs -f app

wait-db: ## Wait until PostgreSQL is ready
	@echo "Waiting for PostgreSQL to be ready..."
	@until $(DC) exec -T db pg_isready -U s3admin -d s3_admin -q 2>/dev/null; do sleep 1; done

prod-check: ## Validate production safety checks
	@. ./.env 2>/dev/null; \
	if [ "$$ENVIRONMENT" = "PROD" ] && [ "$$POSTGRES_PASSWORD" = "password" ]; then \
		echo "ERROR: Cannot start PROD with default POSTGRES_PASSWORD. Set a strong password in .env"; exit 1; \
	fi

prod: prod-check docker-build ## Build image, start db, apply migrations+seed, then start app
	$(DC) up -d db
	$(MAKE) wait-db
	$(MAKE) prod-migrate
	$(MAKE) prod-seed
	$(DC) up -d app proxy
	@echo "\n✓ Production stack is up and seeded."

prod-migrate: ## Run Prisma migrate deploy inside app container
	$(DC) run --rm -T app npx --yes prisma@$(PRISMA_CLI_VERSION) migrate deploy

prod-seed: ## Seed default plans inside app container
	$(DC) run --rm -T app npx --yes prisma@$(PRISMA_CLI_VERSION) db seed

# ─── Setup & Cleanup ────────────────────────────────────

setup: check-node ## Full project setup: install deps, start db, migrate, seed
	npm install
	$(DC) up db -d
	@echo "Waiting for PostgreSQL to be ready..."
	@until $(DC) exec -T db pg_isready -U s3admin -d s3_admin -q 2>/dev/null; do sleep 1; done
	npx prisma migrate dev
	npx prisma db seed
	@echo "\n✓ Setup complete. Run 'make dev' to start the dev server."

clean: ## Remove build artifacts
	rm -rf .next node_modules/.cache

nuke: ## Nuclear clean: stop containers, destroy db volume, remove migrations, node_modules, .next
	$(DC) down -v 2>/dev/null || true
	rm -rf .next node_modules prisma/migrations
	@echo "✓ Nuked. Run 'make setup' to rebuild from scratch."
