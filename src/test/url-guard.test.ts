import assert from "node:assert/strict";
import test from "node:test";
import { assertPublicHttpUrl } from "../lib/url-guard.js";

test("assertPublicHttpUrl allows normal public URLs", () => {
  assert.equal(
    assertPublicHttpUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ").hostname,
    "www.youtube.com",
  );
  assert.equal(assertPublicHttpUrl("http://example.com/path").hostname, "example.com");
});

test("assertPublicHttpUrl rejects non-http(s) schemes", () => {
  assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"), /http and https/);
  assert.throws(() => assertPublicHttpUrl("ftp://example.com/x"), /http and https/);
  assert.throws(() => assertPublicHttpUrl("gopher://example.com"), /http and https/);
});

test("assertPublicHttpUrl rejects the cloud metadata IP and link-local range", () => {
  assert.throws(() => assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/"), /private|loopback|link-local/i);
  assert.throws(() => assertPublicHttpUrl("http://169.254.0.1/"), /private|loopback|link-local/i);
});

test("assertPublicHttpUrl rejects loopback and RFC1918 private ranges", () => {
  for (const host of ["127.0.0.1", "10.0.0.5", "172.16.9.9", "172.31.255.1", "192.168.1.1", "0.0.0.0"]) {
    assert.throws(() => assertPublicHttpUrl(`http://${host}/`), /private|loopback|link-local/i, host);
  }
});

test("assertPublicHttpUrl allows public IPs outside private ranges", () => {
  assert.equal(assertPublicHttpUrl("http://8.8.8.8/").hostname, "8.8.8.8");
  assert.equal(assertPublicHttpUrl("http://172.32.0.1/").hostname, "172.32.0.1");
});

test("assertPublicHttpUrl rejects IPv6 loopback, unique-local, and link-local", () => {
  for (const host of ["[::1]", "[fc00::1]", "[fd12:3456::1]", "[fe80::1]", "[::ffff:169.254.169.254]"]) {
    assert.throws(() => assertPublicHttpUrl(`http://${host}/`), /private|loopback|link-local/i, host);
  }
});

test("VIDLENS_ALLOW_PRIVATE_URLS=1 bypasses private-address checks but not scheme checks", () => {
  const prev = process.env.VIDLENS_ALLOW_PRIVATE_URLS;
  process.env.VIDLENS_ALLOW_PRIVATE_URLS = "1";
  try {
    assert.equal(assertPublicHttpUrl("http://169.254.169.254/").hostname, "169.254.169.254");
    assert.throws(() => assertPublicHttpUrl("file:///etc/passwd"), /http and https/);
  } finally {
    if (prev === undefined) delete process.env.VIDLENS_ALLOW_PRIVATE_URLS;
    else process.env.VIDLENS_ALLOW_PRIVATE_URLS = prev;
  }
});
