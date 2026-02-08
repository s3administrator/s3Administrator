#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "${ROOT_DIR}/.env" ]]; then
  echo "Missing ${ROOT_DIR}/.env"
  exit 1
fi

set -a
source "${ROOT_DIR}/.env"
set +a

export TF_VAR_hcloud_token="${HETZNER_API_TOKEN:-}"
export TF_VAR_cloudflare_api_token="${CLOUDFLARE_API_TOKEN:-}"
export TF_VAR_github_token="${GITHUB_TOKEN:-}"

if [[ -z "${TF_VAR_hcloud_token}" || -z "${TF_VAR_cloudflare_api_token}" ]]; then
  echo "HETZNER_API_TOKEN and CLOUDFLARE_API_TOKEN must be set in infrastructure/.env"
  exit 1
fi

terraform -chdir="${ROOT_DIR}" init
terraform -chdir="${ROOT_DIR}" apply "$@"
