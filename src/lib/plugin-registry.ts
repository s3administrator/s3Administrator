type PluginStatus = {
  auth: boolean
  billing: boolean
  admin: boolean
  audit: boolean
  marketing: boolean
}

let cached: PluginStatus | null = null

function probeModule(name: string): boolean {
  try {
    require.resolve(name)
    return true
  } catch {
    return false
  }
}

export function getInstalledPlugins(): PluginStatus {
  if (cached) return cached

  cached = {
    auth: probeModule("@s3administrator/auth"),
    billing: probeModule("@s3administrator/billing"),
    admin: probeModule("@s3administrator/admin"),
    audit: probeModule("@s3administrator/audit"),
    marketing: probeModule("@s3administrator/marketing"),
  }

  return cached
}

export function isPluginInstalled(name: keyof PluginStatus): boolean {
  return getInstalledPlugins()[name]
}
