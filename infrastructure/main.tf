terraform {
  required_version = ">= 1.5.0"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"
    }
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "~> 1.50"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "hcloud" {
  token = var.hcloud_token
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

resource "random_password" "postgres" {
  length  = 24
  special = false
}

locals {
  postgres_password = var.postgres_password != "" ? var.postgres_password : random_password.postgres.result

  app_env_source = file("${path.module}/${var.local_app_env_path}")
  ssh_public_key = trimspace(file(pathexpand(var.ssh_public_key_path)))

  ssh_public_key_material = join(" ", slice(split(" ", local.ssh_public_key), 0, 2))
  existing_ssh_key_ids = [
    for key in data.hcloud_ssh_keys.all.ssh_keys : key.id
    if length(split(" ", trimspace(key.public_key))) >= 2
    && join(" ", slice(split(" ", trimspace(key.public_key)), 0, 2)) == local.ssh_public_key_material
  ]
  selected_ssh_key_id = length(local.existing_ssh_key_ids) > 0 ? local.existing_ssh_key_ids[0] : hcloud_ssh_key.default[0].id

  github_client_id_prod_from_typo = try(regex("(?m)^GITHUB_CLIENT_ID_PROD\"\\s*=\\s*\"([^\"]+)\"\\s*$", local.app_env_source)[0], "")
  stripe_api_key_fallback         = try(regex("(?m)^STRIPE_API_KEY\\s*=\\s*\"([^\"]+)\"\\s*$", local.app_env_source)[0], "")

  app_env_prod = trimspace(join("\n", [
    local.app_env_source,
    "",
    "# --- Managed production overrides ---",
    "ENVIRONMENT=\"PROD\"",
    "AUTH_URL=\"https://${var.domain}\"",
    "DOMAIN=\"${var.domain}\"",
    "CADDYFILE=\"Caddyfile.prod\"",
    "DATABASE_URL=\"postgresql://${var.postgres_user}:${local.postgres_password}@localhost:${var.postgres_host_port}/${var.postgres_db}\"",
    "POSTGRES_PORT=\"${var.postgres_host_port}\"",
    "POSTGRES_PASSWORD=\"${local.postgres_password}\"",
    local.github_client_id_prod_from_typo != "" ? "GITHUB_CLIENT_ID_PROD=\"${local.github_client_id_prod_from_typo}\"" : "",
    local.stripe_api_key_fallback != "" ? "STRIPE_SECRET_KEY=\"${local.stripe_api_key_fallback}\"" : "",
  ]))
}

data "hcloud_ssh_keys" "all" {}

resource "hcloud_ssh_key" "default" {
  count      = length(local.existing_ssh_key_ids) == 0 ? 1 : 0
  name       = "${var.server_name}-ssh"
  public_key = local.ssh_public_key
}

resource "hcloud_firewall" "web" {
  name = "${var.server_name}-fw"

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "22"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "80"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction  = "in"
    protocol   = "tcp"
    port       = "443"
    source_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "tcp"
    port            = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "udp"
    port            = "1-65535"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }

  rule {
    direction       = "out"
    protocol        = "icmp"
    destination_ips = ["0.0.0.0/0", "::/0"]
  }
}

resource "hcloud_server" "prod" {
  name        = var.server_name
  location    = var.location
  server_type = var.server_type
  image       = var.server_image
  ssh_keys    = [local.selected_ssh_key_id]

  user_data = templatefile("${path.module}/templates/cloud-init.yaml.tftpl", {
    app_branch         = var.app_branch
    app_directory      = var.app_directory
    app_env_content    = local.app_env_prod
    app_repo           = var.app_repo
    domain             = var.domain
    github_token       = var.github_token
    node_major_version = var.node_major_version
  })
}

resource "hcloud_firewall_attachment" "prod" {
  firewall_id = hcloud_firewall.web.id
  server_ids  = [hcloud_server.prod.id]
}

data "cloudflare_zone" "zone" {
  count = var.create_cloudflare_record ? 1 : 0
  name  = var.cloudflare_zone_name
}

resource "cloudflare_record" "www" {
  count = var.create_cloudflare_record ? 1 : 0

  zone_id = data.cloudflare_zone.zone[0].id
  name    = var.cloudflare_record_name
  content = hcloud_server.prod.ipv4_address
  type    = "A"
  ttl     = 1
  proxied = var.cloudflare_proxied
}
