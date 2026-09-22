#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config/config.js";
import { ImapAdapter } from "./adapters/imap-adapter.js";
import { SmtpAdapter } from "./adapters/smtp-adapter.js";
import { MailService } from "./mail/mail-service.js";
import { createMcpServer } from "./mcp/server.js";
import {
  EnvironmentCredentialStore,
  FallbackCredentialStore,
  LocalCredentialStore,
  requireCredential
} from "./security/credentials.js";
import { FileAuditLogger } from "./security/audit.js";
import { verifyRuntimePaths } from "./security/runtime-paths.js";
import { initialize } from "./init.js";
import { initHelpText, parseInitArgs } from "./init-args.js";
import path from "node:path";

async function main(): Promise<void> {
  if (process.argv[2] === "init") {
    const args = parseInitArgs(process.argv.slice(3), {
      onHelp: () => process.stderr.write(initHelpText())
    });
    const result = await initialize({
      configPath: args.configPath,
      account: args.account,
      secret: args.secret,
      credentialsPath: args.credentialsPath
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          configPath: result.configPath,
          credentialsPath: result.credentialsPath,
          clientConfig: result.clientConfig
        },
        null,
        2
      )}\n`
    );
    return;
  }

  const config = await loadConfig();
  const credentialStore = new FallbackCredentialStore(
    new LocalCredentialStore(),
    new EnvironmentCredentialStore()
  );
  const password = await requireCredential(
    credentialStore,
    config.security.credentialTarget,
    config.account.email
  );
  const logDir = config.configPath
    ? path.join(path.dirname(config.configPath), "logs")
    : path.resolve(process.cwd(), "logs");
  await verifyRuntimePaths({
    attachmentDir: config.security.attachmentDir,
    logDir
  });

  const imap = new ImapAdapter({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    user: config.account.email,
    password
  });
  const smtp = new SmtpAdapter({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    user: config.account.email,
    password
  });
  const mail = new MailService({
    config,
    imap,
    smtp,
    audit: new FileAuditLogger(path.join(logDir, "audit.jsonl"))
  });

  const server = createMcpServer(mail);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  const shutdown = async () => {
    await mail.close();
    await server.close();
  };

  process.once("SIGINT", () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown().finally(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exit(1);
});

