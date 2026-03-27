import { env } from "cloudflare:workers";
import { describe, it, expect } from "vitest";
import { writeClickEvent } from "../../src/services/analytics";
describe("writeClickEvent", () => {
  it("does not throw with a well-formed request", () => {
    const request = new Request("https://veer.ing/test-slug", {
      headers: {
        "user-agent": "TestAgent/1.0",
        referer: "https://referrer.example.com",
      },
    });

    expect(() => {
      writeClickEvent(env.ANALYTICS, {
        linkId: "link-1",
        slug: "test-slug",
        destinationUrl: "https://example.com/destination",
        request,
      });
    }).not.toThrow();
  });

  it("does not throw when headers are missing", () => {
    const request = new Request("https://veer.ing/bare");

    expect(() => {
      writeClickEvent(env.ANALYTICS, {
        linkId: "link-2",
        slug: "bare",
        destinationUrl: "https://example.com",
        request,
      });
    }).not.toThrow();
  });
});
