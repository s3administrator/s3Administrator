output "server_ipv4" {
  description = "Public IPv4 address of the server"
  value       = hcloud_server.prod.ipv4_address
}

output "app_url" {
  description = "Production URL"
  value       = "https://${var.domain}"
}

output "ssh_command" {
  description = "SSH command"
  value       = "ssh root@${hcloud_server.prod.ipv4_address}"
}

output "dns_record" {
  description = "Cloudflare DNS record for www"
  value       = var.create_cloudflare_record ? "${var.cloudflare_record_name}.${var.cloudflare_zone_name}" : "not-managed"
}

output "dns_apex_record" {
  description = "Cloudflare DNS apex/root record"
  value       = var.create_cloudflare_record ? var.root_domain : "not-managed"
}
