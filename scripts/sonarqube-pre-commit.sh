#!/usr/bin/env bash
set -euo pipefail

required=(SONAR_HOST_URL SONAR_TOKEN SONAR_PROJECT_KEY)
missing=()

for key in "${required[@]}"; do
  if [[ -z "${!key:-}" ]]; then
    missing+=("$key")
  fi
done

if (( ${#missing[@]} > 0 )); then
  echo "[sonarqube] Skipping SonarQube scan (missing env: ${missing[*]})."
  echo "[sonarqube] Set SONAR_HOST_URL, SONAR_TOKEN, and SONAR_PROJECT_KEY to enable this hook."
  exit 0
fi

if ! command -v sonar-scanner >/dev/null 2>&1; then
  echo "[sonarqube] sonar-scanner is required but was not found in PATH."
  echo "[sonarqube] Install sonar-scanner CLI or remove SonarQube env vars."
  exit 1
fi

SONAR_SOURCES=${SONAR_SOURCES:-src,prisma,scripts}
SONAR_EXCLUSIONS=${SONAR_EXCLUSIONS:-node_modules/**,.next/**,coverage/**,dist/**,build/**}

args=(
  "-Dsonar.projectKey=${SONAR_PROJECT_KEY}"
  "-Dsonar.host.url=${SONAR_HOST_URL}"
  "-Dsonar.token=${SONAR_TOKEN}"
  "-Dsonar.sources=${SONAR_SOURCES}"
  "-Dsonar.exclusions=${SONAR_EXCLUSIONS}"
  "-Dsonar.qualitygate.wait=true"
)

if [[ -n "${SONAR_ORGANIZATION:-}" ]]; then
  args+=("-Dsonar.organization=${SONAR_ORGANIZATION}")
fi

if [[ -n "${SONAR_PROJECT_NAME:-}" ]]; then
  args+=("-Dsonar.projectName=${SONAR_PROJECT_NAME}")
fi

echo "[sonarqube] Running SonarQube scan..."
sonar-scanner "${args[@]}"
