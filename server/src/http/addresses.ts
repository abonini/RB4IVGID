import net from "net";
export { isAllowedHost } from "../../../shared/hosts";

export function isBlockedAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isBlockedAddress(normalized.slice("::ffff:".length));
  }
  const family = net.isIP(normalized);
  if (family === 6) return isBlockedIpv6(normalized);
  if (family !== 4) return true;
  return isBlockedIpv4(normalized);
}

function isBlockedIpv6(address: string): boolean {
  if (address === "::1" || address === "::") return true;
  if (address.startsWith("fe80:")) return true;
  return address.startsWith("fc") || address.startsWith("fd");
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [first, second] = parts;
  if (first === 0 || first === 10 || first === 127) return true;
  if (first === 169 && second === 254) return true;
  if (first === 172 && second >= 16 && second <= 31) return true;
  if (first === 192 && second === 168) return true;
  if (first === 100 && second >= 64 && second <= 127) return true;
  return false;
}
