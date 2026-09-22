import { describe, expect, it } from "vitest";
import { networkFailureKind } from "../../src/errors.js";

describe("networkFailureKind", () => {
  it("classifies DNS, TLS and connection failures", () => {
    expect(networkFailureKind("ENOTFOUND")).toBe("dns");
    expect(networkFailureKind("EAI_AGAIN")).toBe("dns");
    expect(networkFailureKind("CERT_HAS_EXPIRED")).toBe("tls");
    expect(networkFailureKind("ECONNREFUSED")).toBe("connection");
    expect(networkFailureKind("EUNKNOWN")).toBe("network");
    expect(networkFailureKind(undefined)).toBeUndefined();
  });
});
