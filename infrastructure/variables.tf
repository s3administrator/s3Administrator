variable "hcloud_token" {
  description = "Hetzner Cloud API token"
  type        = string
  sensitive   = true
}

variable "cloudflare_api_token" {
  description = "Cloudflare API token"
  type        = string
  sensitive   = true
}

variable "github_token" {
  description = "GitHub token used for cloning private repos (optional for public repos)"
  type        = string
  sensitive   = true
  default     = ""
}

variable "server_name" {
  description = "Name of the Hetzner server"
  type        = string
  default     = "s3administrator-prod"
}

variable "server_type" {
  description = "Hetzner server type"
  type        = string
  default     = "cx33"
}

variable "location" {
  description = "Hetzner location"
  type        = string
  default     = "fsn1"
}

variable "server_image" {
  description = "Server image"
  type        = string
  default     = "ubuntu-24.04"
}

variable "ssh_public_key_path" {
  description = "Path to the SSH public key to register in Hetzner"
  type        = string
  default     = "~/.ssh/id_ed25519.pub"
}

variable "app_repo" {
  description = "GitHub repo in owner/name format"
  type        = string
  default     = "tahayusufkomur/s3Administrator"
}

variable "app_branch" {
  description = "Git branch to deploy"
  type        = string
  default     = "main"
}

variable "app_directory" {
  description = "Path on the server where the app is cloned"
  type        = string
  default     = "/opt/s3administrator"
}

variable "local_app_env_path" {
  description = "Path (relative to infrastructure/) to local app .env file used as base for server .env"
  type        = string
  default     = "../.env"
}

variable "domain" {
  description = "Public domain that Caddy serves"
  type        = string
  default     = "www.s3administrator.com"
}

variable "cloudflare_zone_name" {
  description = "Cloudflare zone name"
  type        = string
  default     = "s3administrator.com"
}

variable "cloudflare_record_name" {
  description = "DNS record name for the app"
  type        = string
  default     = "www"
}

variable "cloudflare_proxied" {
  description = "Whether Cloudflare proxy is enabled"
  type        = bool
  default     = false
}

variable "create_cloudflare_record" {
  description = "Create the DNS record in Cloudflare"
  type        = bool
  default     = true
}

variable "postgres_user" {
  description = "Postgres username"
  type        = string
  default     = "s3admin"
}

variable "postgres_db" {
  description = "Postgres database"
  type        = string
  default     = "s3_admin"
}

variable "postgres_password" {
  description = "Postgres password (leave empty to auto-generate)"
  type        = string
  default     = ""
  sensitive   = true
}
