import { describe, expect, it } from "vitest";
import { normalizeStreamUrl } from "../src/utils/streamUrlValidation.js";

describe("normalizeStreamUrl (Step 16 near-duplicate detection)", () => {
  it("is a no-op for an already-canonical URL", () => {
    expect(normalizeStreamUrl("https://stream.example.com/live")).toBe(
      "https://stream.example.com/live",
    );
  });

  it("case-folds the host but not the path", () => {
    expect(normalizeStreamUrl("https://Stream.Example.COM/Live")).toBe(
      "https://stream.example.com/Live",
    );
  });

  it("folds an explicit default HTTPS port (443) away", () => {
    expect(normalizeStreamUrl("https://stream.example.com:443/live")).toBe(
      "https://stream.example.com/live",
    );
  });

  it("keeps a non-default port, since that is a genuinely different origin", () => {
    expect(normalizeStreamUrl("https://stream.example.com:8443/live")).toBe(
      "https://stream.example.com:8443/live",
    );
  });

  it("folds a bare trailing slash on the root path away", () => {
    expect(normalizeStreamUrl("https://stream.example.com/")).toBe("https://stream.example.com");
    expect(normalizeStreamUrl("https://stream.example.com")).toBe("https://stream.example.com");
  });

  it("does NOT fold a trailing slash on a longer path - different mount points", () => {
    // Real Icecast/Shoutcast-style servers can and do route "/stream" and
    // "/stream/" to different mount points, so treating them as identical
    // would be a false-positive duplicate, not a real one.
    expect(normalizeStreamUrl("https://stream.example.com/live/")).not.toBe(
      normalizeStreamUrl("https://stream.example.com/live"),
    );
  });

  it("preserves query strings, which can carry a meaningful stream key/mount id", () => {
    expect(normalizeStreamUrl("https://stream.example.com/live?mount=1")).not.toBe(
      normalizeStreamUrl("https://stream.example.com/live?mount=2"),
    );
  });

  it("treats two spellings of the same effective URL as equal", () => {
    expect(normalizeStreamUrl("https://Stream.Example.com:443/live")).toBe(
      normalizeStreamUrl("https://stream.example.com/live"),
    );
  });

  it("falls back to a lowercased trim for an unparseable value rather than throwing", () => {
    expect(normalizeStreamUrl("  not a url  ")).toBe("not a url");
  });
});
