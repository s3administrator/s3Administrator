# Contributing to S3 Administrator

Thank you for considering contributing to S3 Administrator! This document provides guidelines for contributing to the project.

## Getting Started

1. Fork the repository
2. Clone your fork
3. Create a new branch for your feature or fix
4. Make your changes
5. Submit a pull request

## Development Setup

```bash
# Install dependencies
npm install

# Copy the community environment template
cp .env.community .env

# Start PostgreSQL (via Docker)
docker compose --env-file .env -f docker/docker-compose.yml up db -d

# Run database migrations
npx prisma migrate deploy

# Seed the database
npx prisma db seed

# Start the application
npm run dev
```

The app will be available at `http://localhost:3000`.

## Project Structure

- `src/app/` - Next.js App Router pages and API routes
- `src/lib/` - Shared utilities and configuration
- `src/components/` - React components
- `prisma/` - Database schema and migrations

## Pull Request Guidelines

- Keep PRs focused on a single change
- Add tests for new functionality where applicable
- Ensure the build passes (`npm run build`)
- Follow the existing code style

## Reporting Issues

Please use GitHub Issues to report bugs or request features. Include:

- Steps to reproduce (for bugs)
- Expected vs actual behavior
- Environment details (OS, Node.js version, browser)

## License

By contributing, you agree that your contributions will be licensed under the AGPL-3.0 License.
