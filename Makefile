.PHONY: help dev build start db-up db-down db-reset migrate generate studio lint clean docker-build docker-up docker-down nuke setup seed

DC = docker compose --env-file .env -f docker/docker-compose.yml

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ─── Development ─────────────────────────────────────────

dev: ## Start development server
	npm run dev

build: ## Build for production
	npx prisma generate && npm run build

start: ## Start production server
	npm run start

lint: ## Run linter
	npm run lint

# ─── Database ────────────────────────────────────────────

db-up: ## Start PostgreSQL via Docker Compose
	$(DC) up db -d

db-down: ## Stop PostgreSQL
	$(DC) down

db-reset: ## Reset database (drop all tables and re-migrate)
	npx prisma migrate reset --force

migrate: ## Run database migrations
	npx prisma migrate dev

migrate-deploy: ## Deploy migrations (production)
	npx prisma migrate deploy

generate: ## Generate Prisma client
	npx prisma generate

studio: ## Open Prisma Studio (DB GUI)
	npx prisma studio

seed: ## Seed the database with default plans
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

# ─── Setup & Cleanup ────────────────────────────────────

setup: ## Full project setup: install deps, start db, migrate, seed
	npm install
	$(DC) up db -d
	@echo "Waiting for PostgreSQL to be ready..."
	@until $(DC) exec db pg_isready -U s3admin -d s3_admin -q 2>/dev/null; do sleep 1; done
	npx prisma migrate dev
	npx prisma db seed
	@echo "\n✓ Setup complete. Run 'make dev' to start the dev server."

clean: ## Remove build artifacts
	rm -rf .next node_modules/.cache

nuke: ## Nuclear clean: stop containers, destroy db volume, remove migrations, node_modules, .next
	$(DC) down -v 2>/dev/null || true
	rm -rf .next node_modules prisma/migrations
	@echo "✓ Nuked. Run 'make setup' to rebuild from scratch."
