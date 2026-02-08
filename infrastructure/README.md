# Production Infrastructure (Terraform)

This folder provisions production for `www.s3administrator.com` on Hetzner:

- Hetzner server: `cx33` in `fsn1`
- SSH key registration for root access (reuses existing Hetzner key if already present)
- Firewall for `22`, `80`, `443`
- Cloudflare DNS `A` record for `www`
- Bootstrap installs Docker + Caddy
- App is cloned from `tahayusufkomur/s3Administrator`
- Root app `.env` is generated from local `../.env` with production overrides
- Docker Compose builds and runs app + Postgres
- Caddy reverse proxies with automatic SSL

## 1) Prepare secrets

Create `infrastructure/.env` from `infrastructure/.env.example` and fill tokens.

## 2) Deploy

```bash
chmod +x infrastructure/deploy.sh
./infrastructure/deploy.sh
```

You can pass extra terraform args, for example:

```bash
./infrastructure/deploy.sh -auto-approve
```

## 3) Outputs

After apply, Terraform prints:

- `server_ipv4`
- `app_url`
- `ssh_command`
- `dns_record`
