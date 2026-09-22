import { describe, expect, it } from "vitest";
import { InitHelpRequested, parseInitArgs } from "../../src/init-args.js";

describe("init argument parsing", () => {
  it("accepts named flags", () => {
    const args = parseInitArgs([
      "--config",
      "/tmp/config.toml",
      "--credentials",
      "/tmp/credentials.json",
      "--account",
      "me@qq.com",
      "--secret",
      "code"
    ]);

    expect(args).toEqual({
      configPath: "/tmp/config.toml",
      credentialsPath: "/tmp/credentials.json",
      account: "me@qq.com",
      secret: "code"
    });
  });

  it("rejects positional arguments that used to shift silently", () => {
    expect(() =>
      parseInitArgs(["/tmp/config.toml", "me@qq.com", "code"])
    ).toThrow(/Unexpected positional argument/);
  });

  it("rejects a path-like value passed as the account", () => {
    expect(() =>
      parseInitArgs(["--account", "/tmp/credentials.json"])
    ).toThrow(/path-like/);
  });

  it("accepts inline --flag=value form", () => {
    const args = parseInitArgs(["--account=me@qq.com"]);
    expect(args.account).toBe("me@qq.com");
  });

  it("stops parsing when help is requested", () => {
    expect(() => parseInitArgs(["--help"])).toThrow(InitHelpRequested);
    expect(() => parseInitArgs(["-h"])).toThrow(InitHelpRequested);
    // Help must terminate even when mixed with other flags.
    expect(() => parseInitArgs(["--account", "me@qq.com", "--help"])).toThrow(
      InitHelpRequested
    );
  });
});
