export interface InitArgs {
  configPath?: string | undefined;
  credentialsPath?: string | undefined;
  account?: string | undefined;
  secret?: string | undefined;
}

/** Thrown when the user asks for help. Callers should exit with code 0. */
export class InitHelpRequested extends Error {
  constructor() {
    super("help requested");
    this.name = "InitHelpRequested";
  }
}

/**
 * Parses named flags only. Positional arguments are rejected on purpose:
 * a single missing value used to shift every later argument into the wrong
 * slot and silently write credentials to the global default location.
 */
export function parseInitArgs(
  argv: string[],
  options: { onHelp?: () => void } = {}
): InitArgs {
  const parsed: InitArgs = {};

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }
    if (token === "--help" || token === "-h") {
      options.onHelp?.();
      // Help is a terminal action: signal the caller to stop, never fall
      // through into initialization.
      throw new InitHelpRequested();
    }
    if (!token.startsWith("--")) {
      throw new Error(
        `Unexpected positional argument "${token}". Use named flags: ` +
          "--config, --credentials, --account, --secret."
      );
    }

    const separator = token.indexOf("=");
    const flag = separator === -1 ? token : token.slice(0, separator);
    const inlineValue = separator === -1 ? undefined : token.slice(separator + 1);
    const value = inlineValue ?? argv[index + 1];
    if (inlineValue === undefined) {
      index += 1;
    }
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }

    switch (flag) {
      case "--config":
        parsed.configPath = value;
        break;
      case "--credentials":
        parsed.credentialsPath = value;
        break;
      case "--account":
        if (looksLikePath(value)) {
          throw new Error(
            `--account received a path-like value: "${value}". Did you forget a flag?`
          );
        }
        parsed.account = value;
        break;
      case "--secret":
        parsed.secret = value;
        break;
      default:
        throw new Error(`Unknown flag "${flag}"`);
    }
  }

  return parsed;
}

export function initHelpText(): string {
  return [
    "Usage: qq-email-mcp init [options]",
    "",
    "  --account <email>       QQ Mail address (prompted if omitted)",
    "  --secret <authcode>     Authorization code (prompted if omitted;",
    "                          avoid this flag to keep it out of shell history)",
    "  --config <path>         Config file path",
    "  --credentials <path>    Credential file path",
    ""
  ].join("\n");
}

function looksLikePath(value: string): boolean {
  return /[\\/]/.test(value) || /\.(json|toml)$/i.test(value);
}
