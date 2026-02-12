.PHONY: help \
	prod-setup prod-start prod-stop prod-restart prod-migrate \
	dev-setup dev-start dev-stop dev-restart dev-migrate dev-local dev-reset \
	log

DC_DEV  = docker compose --env-file .env.dev -f docker/docker-compose.yml
DC_PROD = docker compose --env-file .env.prod -f docker/docker-compose.yml
ENV ?= dev

help: ## Show available commands
	@echo ""
	@echo "  Production"
	@echo "  ──────────────────────────────────────"
	@grep -E '^prod-[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  Development"
	@echo "  ──────────────────────────────────────"
	@grep -E '^dev-[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  Utilities"
	@echo "  ──────────────────────────────────────"
	@grep -E '^log:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-18s\033[0m %s\n", $$1, $$2}'
	@echo ""

# ─── Production ──────────────────────────────────────────

prod-setup: ## Build images, start DB, run migrations & seed
	@. ./.env.prod 2>/dev/null; \
	if [ "$$POSTGRES_PASSWORD" = "password" ] || [ -z "$$POSTGRES_PASSWORD" ]; then \
		echo "ERROR: Set a strong POSTGRES_PASSWORD in .env.prod"; exit 1; \
	fi
	$(DC_PROD) build app tools
	$(DC_PROD) up db -d
	@echo "Waiting for PostgreSQL to be ready..."
	@until $(DC_PROD) exec -T db pg_isready -U s3admin -d s3_admin -q 2>/dev/null; do sleep 1; done
	$(DC_PROD) run --rm -T tools npx --no-install prisma migrate deploy
	$(DC_PROD) run --rm -T tools npx --no-install prisma db seed
	@echo "\n✓ Production setup complete."

prod-start: ## Start production stack (app + db + proxy)
	@. ./.env.prod 2>/dev/null; \
	if [ "$$POSTGRES_PASSWORD" = "password" ] || [ -z "$$POSTGRES_PASSWORD" ]; then \
		echo "ERROR: Set a strong POSTGRES_PASSWORD in .env.prod"; exit 1; \
	fi
	$(DC_PROD) up -d app db proxy
	@echo "✓ Production is running."

prod-stop: ## Stop production containers
	$(DC_PROD) down
	@echo "✓ Production stopped."

prod-restart: ## Rebuild app image and restart production
	$(DC_PROD) build app
	$(DC_PROD) up -d app
	@echo "✓ Production app restarted."

prod-migrate: ## Run migrations & seed on production DB
	$(DC_PROD) up db -d
	@until $(DC_PROD) exec -T db pg_isready -U s3admin -d s3_admin -q 2>/dev/null; do sleep 1; done
	$(DC_PROD) run --rm -T tools npx --no-install prisma migrate deploy
	$(DC_PROD) run --rm -T tools npx --no-install prisma db seed
	@echo "✓ Production migrations applied & seeded."

# ─── Development ─────────────────────────────────────────

dev-setup: ## Build images, start DB, run migrations & seed for development
	$(DC_DEV) build app tools
	$(DC_DEV) up db -d
	@echo "Waiting for PostgreSQL to be ready..."
	@until $(DC_DEV) exec -T db pg_isready -U s3admin -d s3_admin -q 2>/dev/null; do sleep 1; done
	$(DC_DEV) run --rm -T tools npx --no-install prisma migrate deploy
	$(DC_DEV) run --rm -T tools npx --no-install prisma db seed
	@echo "\n✓ Development setup complete."

dev-start: ## Start development stack (app + db + proxy)
	$(DC_DEV) up -d app db proxy
	@echo "✓ Development stack is running."

dev-restart: ## Rebuild app image and restart development app
	$(DC_DEV) build app
	$(DC_DEV) up -d app
	@echo "✓ Development app restarted."

dev-local: ## Start DB container and run local Next.js dev server using .env.dev
	$(DC_DEV) up db -d
	@echo "Waiting for PostgreSQL to be ready..."
	@until $(DC_DEV) exec -T db pg_isready -U s3admin -d s3_admin -q 2>/dev/null; do sleep 1; done
	@set -a; . ./.env.dev; set +a; npm run dev

dev-stop: ## Stop dev containers
	$(DC_DEV) down
	@echo "✓ Dev stopped."

dev-reset: ## Reset dev: destroy DB volume and restart
	$(DC_DEV) down -v
	$(DC_DEV) up db -d
	@echo "Waiting for PostgreSQL to be ready..."
	@until $(DC_DEV) exec -T db pg_isready -U s3admin -d s3_admin -q 2>/dev/null; do sleep 1; done
	$(DC_DEV) run --rm -T tools npx --no-install prisma migrate deploy
	$(DC_DEV) run --rm -T tools npx --no-install prisma db seed
	@echo "✓ Dev environment reset."

dev-migrate: ## Run migrations & seed on development DB
	$(DC_DEV) up db -d
	@until $(DC_DEV) exec -T db pg_isready -U s3admin -d s3_admin -q 2>/dev/null; do sleep 1; done
	$(DC_DEV) run --rm -T tools npx --no-install prisma migrate deploy
	$(DC_DEV) run --rm -T tools npx --no-install prisma db seed
	@echo "✓ Development migrations applied & seeded."

log: ## Tail app service logs (set ENV=prod for production, default: dev)
	@if [ "$(ENV)" = "prod" ]; then \
		$(DC_PROD) logs -f --tail=200 app; \
	elif [ "$(ENV)" = "dev" ]; then \
		$(DC_DEV) logs -f --tail=200 app; \
	else \
		echo "ERROR: ENV must be either 'dev' or 'prod' (got: $(ENV))"; \
		exit 1; \
	fi
