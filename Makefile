.PHONY: help dev build start db-up db-down db-reset migrate generate studio lint clean docker-build docker-up docker-down

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
	docker compose -f docker/docker-compose.yml up db -d

db-down: ## Stop PostgreSQL
	docker compose -f docker/docker-compose.yml down

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

# ─── Docker Production ───────────────────────────────────

docker-build: ## Build Docker image
	docker compose -f docker/docker-compose.yml build

docker-up: ## Start all services (app + db)
	docker compose -f docker/docker-compose.yml up -d

docker-down: ## Stop all services
	docker compose -f docker/docker-compose.yml down

docker-logs: ## View app logs
	docker compose -f docker/docker-compose.yml logs -f app

# ─── Setup & Cleanup ────────────────────────────────────

setup: ## Initial project setup (install deps, generate client, start db, migrate)
	npm install
	npx prisma generate
	@echo "Run 'make db-up' to start PostgreSQL, then 'make migrate' to run migrations"

clean: ## Remove build artifacts
	rm -rf .next node_modules/.cache

nuke: ## Full clean (node_modules, .next, generated)
	rm -rf .next node_modules
