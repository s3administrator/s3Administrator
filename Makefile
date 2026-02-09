.PHONY: setup prod-run dev-run stop reset-dev

DC = docker compose --env-file .env -f docker/docker-compose.yml

# ─── Setup (builds everything) ──────────────────────────

setup: ## Build Docker images, start DB, run migrations & seed
	$(DC) build app tools
	$(DC) up db -d
	@echo "Waiting for PostgreSQL to be ready..."
	@until $(DC) exec -T db pg_isready -U s3admin -d s3_admin -q 2>/dev/null; do sleep 1; done
	$(DC) run --rm -T tools npx --no-install prisma migrate deploy
	$(DC) run --rm -T tools npx --no-install prisma db seed
	@echo "\n✓ Setup complete."

# ─── Run ─────────────────────────────────────────────────

prod-run: ## Start production stack (app + db + proxy)
	@. ./.env 2>/dev/null; \
	if [ "$$ENVIRONMENT" = "PROD" ] && [ "$$POSTGRES_PASSWORD" = "password" ]; then \
		echo "ERROR: Cannot start PROD with default POSTGRES_PASSWORD."; exit 1; \
	fi
	$(DC) up -d app db proxy
	@echo "✓ Production is running."

dev-run: ## Start DB + local dev server
	$(DC) up db -d
	@until $(DC) exec -T db pg_isready -U s3admin -d s3_admin -q 2>/dev/null; do sleep 1; done
	npm run dev

# ─── Stop & Reset ────────────────────────────────────────

stop: ## Stop all containers
	$(DC) down
	@echo "✓ Stopped."

reset-dev: ## Reset dev: stop containers, destroy DB volume, rebuild
	$(DC) down -v
	$(MAKE) setup
	@echo "✓ Dev environment reset."
