# Static marketing/download site for S3 Administrator, served by Caddy behind the
# home-server Cloudflare Tunnel. Caddy is both the app and the edge proxy here:
# the site is fully static, so there's nothing else to run.
FROM caddy:2-alpine
COPY Caddyfile.prod /etc/caddy/Caddyfile
COPY website /srv
