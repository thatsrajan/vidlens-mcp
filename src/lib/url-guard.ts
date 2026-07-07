/**
 * URL guard — SSRF hardening for URLs that get handed to network clients
 * (yt-dlp, raw fetch of channel/watch pages).
 *
 * `assertPublicHttpUrl` rejects non-http(s) schemes and, for URLs whose host is
 * a literal IP address, rejects loopback, link-local (incl. the cloud metadata
 * IP 169.254.169.254), RFC1918 private ranges, 0.0.0.0/8, and the IPv6
 * equivalents (loopback/unspecified/unique-local/link-local).
 *
 * LIMITATION: this guard is intentionally synchronous and does NOT resolve DNS.
 * A hostname that resolves to a private address (DNS rebinding) is not caught
 * here. That trade-off keeps the guard cheap and side-effect-free; the threat
 * model is a prompt-injected LLM handing an obvious internal URL to a tool on a
 * local single-user server, not a determined attacker controlling DNS.
 *
 * Escape hatch: set VIDLENS_ALLOW_PRIVATE_URLS=1 to disable the private-address
 * checks (scheme checking still applies).
 */
import { isIP } from "node:net";

export function assertPublicHttpUrl(input: string | URL): URL {
  let url: URL;
  try {
    url = typeof input === "string" ? new URL(input) : input;
  } catch {
    throw new Error(`Invalid URL: ${String(input)}`);
  }

  const scheme = url.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    throw new Error(`Only http and https URLs are allowed (got ${url.protocol}).`);
  }

  if (process.env.VIDLENS_ALLOW_PRIVATE_URLS === "1") {
    return url;
  }

  const host = stripBrackets(url.hostname.toLowerCase());
  if (isPrivateOrLocalHost(host)) {
    throw new Error(
      `Refusing to fetch a private, loopback, or link-local address: ${url.hostname}. ` +
        `Set VIDLENS_ALLOW_PRIVATE_URLS=1 to override.`,
    );
  }

  return url;
}

function stripBrackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/** True only for literal IP hosts in a private/loopback/link-local range. Non-IP hosts are not checked (no DNS). */
function isPrivateOrLocalHost(host: string): boolean {
  const kind = isIP(host);
  if (kind === 4) return isPrivateIpv4(host);
  if (kind === 6) return isPrivateIpv6(host);
  return false;
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed literal — reject to be safe
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254 metadata IP
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const addr = ip.toLowerCase();
  // IPv4-mapped addresses (e.g. ::ffff:169.254.169.254) — the WHATWG URL parser
  // normalizes these to hex (::ffff:a9fe:a9fe), so decode both forms and reuse
  // the IPv4 rules.
  const mapped = ipv4FromMapped(addr);
  if (mapped && isPrivateIpv4(mapped)) return true;
  if (addr === "::1") return true; // loopback
  if (addr === "::") return true; // unspecified
  const first = addr.split(":")[0];
  if (/^f[cd]/.test(first)) return true; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(first)) return true; // fe80::/10 link-local
  return false;
}

function ipv4FromMapped(addr: string): string | undefined {
  const dotted = addr.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];
  const hex = addr.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }
  return undefined;
}
