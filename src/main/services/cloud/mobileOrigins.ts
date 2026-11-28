/**
 * Exact HTTPS origins for the experimental hub. This only validates configured
 * public identities: it does not start, verify or secure any proxy/tunnel.
 * The caller must terminate TLS correctly and preserve the original Host.
 */
export function normalizeMobileOrigins(origin: unknown, origins: unknown): string[] {
  if ((origin !== undefined) === (origins !== undefined)) throw new Error('Specify exactly one origin configuration')
  const values = origin !== undefined ? [origin] : origins
  if (!Array.isArray(values) || values.length < 1 || values.length > 4) throw new Error('Invalid HTTPS origin configuration')
  const hosts=new Set<string>()
  return Array.from(values, value => {
    if (typeof value !== 'string' || value.length > 2048) throw new Error('Invalid HTTPS origin')
    let parsed: URL
    try { parsed=new URL(value) } catch { throw new Error('Invalid HTTPS origin') }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash ||
        !parsed.hostname || hosts.has(parsed.host)) throw new Error('Invalid HTTPS origin')
    hosts.add(parsed.host)
    return parsed.origin
  })
}
