export function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  return host === "washoecounty.gov" || host.endsWith(".washoecounty.gov");
}
