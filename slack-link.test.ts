import { describe, expect, it } from "vitest";
import { normalizeSlackLink } from "./slack-link";

describe("Slack message links", () => {
  it("accepts a message permalink and preserves thread context without tracking parameters", () => {
    expect(
      normalizeSlackLink(
        " https://example.slack.com/archives/C12345/p1700000000123456?thread_ts=1699999999.654321&cid=C12345 ",
      ),
    ).toBe(
      "https://example.slack.com/archives/C12345/p1700000000123456?thread_ts=1699999999.654321",
    );
    expect(
      normalizeSlackLink(
        "https://example.slack.com/archives/D12345/p1700000000123456/",
      ),
    ).toBe("https://example.slack.com/archives/D12345/p1700000000123456");
    expect(normalizeSlackLink("  ")).toBeNull();
  });
  it.each([
    "javascript:alert(1)",
    "http://example.slack.com/archives/C12345/p1700000000123456",
    "https://example.slack.com.evil.example/archives/C12345/p1700000000123456",
    "https://example.slack.com@evil.example/archives/C12345/p1700000000123456",
    "https://user:password@example.slack.com/archives/C12345/p1700000000123456",
    "https://example.slack.com/archives/C12345",
    "https://example.slack.com/archives/C12345/p1700000000123456?thread_ts=wrong",
    "https://example.slack.com:8443/archives/C12345/p1700000000123456",
  ])("rejects invalid or unsafe links: %s", (url) => {
    expect(() => normalizeSlackLink(url)).toThrow("Paste a Slack message link");
  });
});
