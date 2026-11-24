/** Derive the MCP address from this workbench, including a local custom port. */
export function mcpConnection(locationLike) {
  let url;
  try {
    url = new URL(typeof locationLike === 'string' ? locationLike : locationLike?.href || locationLike?.origin);
  } catch {
    return { available: false, local: false, origin: null, endpoint: null };
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    return { available: false, local: false, origin: null, endpoint: null };
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return {
    available: true,
    local: ['localhost', '127.0.0.1', '::1'].includes(host),
    origin: url.origin,
    endpoint: new URL('/mcp', url.origin).href,
  };
}
