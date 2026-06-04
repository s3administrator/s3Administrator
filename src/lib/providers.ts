/**
 * S3 Provider Configuration
 *
 * Defines supported S3 providers with their regions, endpoints, and defaults.
 * Supports AWS S3, Hetzner Object Storage, Cloudflare R2, Storadera, MinIO, and generic S3-compatible services.
 */

export type Provider = 'AWS' | 'HETZNER' | 'CLOUDFLARE_R2' | 'STORADERA' | 'MINIO' | 'GENERIC'

export interface ProviderConfig {
  name: string
  regions: string[]
  endpoint: string
  defaultRegion: string
  helpText: string
}

export const PROVIDERS: Record<Provider, ProviderConfig> = {
  AWS: {
    name: 'Amazon S3',
    regions: [
      'us-east-1',
      'us-east-2',
      'us-west-1',
      'us-west-2',
      'eu-west-1',
      'eu-west-2',
      'eu-central-1',
      'ap-southeast-1',
      'ap-southeast-2',
      'ap-northeast-1',
      'ap-south-1',
      'ca-central-1',
      'sa-east-1',
    ],
    endpoint: 'https://s3.{region}.amazonaws.com',
    defaultRegion: 'us-east-1',
    helpText: 'Enter your AWS Access Key ID and Secret Access Key from IAM console.',
  },
  HETZNER: {
    name: 'Hetzner Object Storage',
    regions: ['fsn1', 'nbg1', 'hel1'],
    endpoint: 'https://{region}.your-objectstorage.com',
    defaultRegion: 'fsn1',
    helpText:
      'Replace {region} with your Hetzner region. Get credentials from Hetzner Console.',
  },
  CLOUDFLARE_R2: {
    name: 'Cloudflare R2',
    regions: ['auto', 'nam', 'eur', 'apac'],
    endpoint: 'https://{accountId}.r2.cloudflarestorage.com',
    defaultRegion: 'auto',
    helpText:
      'Replace {accountId} with your Cloudflare Account ID. Use Auto region for global distribution.',
  },
  STORADERA: {
    name: 'Storadera',
    regions: ['finland', 'eu-central-1', 'eu-east-1'],
    endpoint: 'https://s3.{region}.storadera.com',
    defaultRegion: 'finland',
    helpText:
      'Choose a Storadera region. Endpoint host differs by region and is auto-filled when selected.',
  },
  MINIO: {
    name: 'MinIO',
    regions: [],
    endpoint: 'http://localhost:9000',
    defaultRegion: 'us-east-1',
    helpText:
      'Enter your MinIO endpoint and credentials. If app runs in Docker, use host.docker.internal or a container service name instead of localhost.',
  },
  GENERIC: {
    name: 'Generic S3-Compatible',
    regions: [],
    endpoint: '',
    defaultRegion: 'us-east-1',
    helpText:
      'Enter any S3-compatible endpoint (e.g., MinIO, DigitalOcean Spaces). Region is often required.',
  },
}

/**
 * Get provider configuration by name
 */
export function getProviderConfig(provider: Provider): ProviderConfig {
  return PROVIDERS[provider]
}

/**
 * Format endpoint template with region/accountId
 */
export function formatEndpoint(provider: Provider, region: string, accountId?: string): string {
  const config = getProviderConfig(provider)
  let endpoint = config.endpoint

  endpoint = endpoint.replace('{region}', region)
  if (accountId) {
    endpoint = endpoint.replace('{accountId}', accountId)
  }

  return endpoint
}

/**
 * Check if provider requires account ID (like Cloudflare R2)
 */
export function requiresAccountId(provider: Provider): boolean {
  return provider === 'CLOUDFLARE_R2'
}
