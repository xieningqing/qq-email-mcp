#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const configuredPath = process.env.QQ_EMAIL_MCP_CONFIG;
const configPath = configuredPath
  ? path.resolve(configuredPath)
  : path.join(projectRoot, "qq-email-mcp.toml");
let loadConfig;
let EnvironmentCredentialStore;
let FallbackCredentialStore;
let LocalCredentialStore;

try {
  ({ loadConfig } = await import("../dist/config/config.js"));
  ({
    EnvironmentCredentialStore,
    FallbackCredentialStore,
    LocalCredentialStore
  } = await import("../dist/security/credentials.js"));
} catch (error) {
  process.stderr.write(
    `Unable to load the built server. Run "npm run build" first.\n${
      error instanceof Error ? error.message : String(error)
    }\n`
  );
  process.exit(2);
}

let config;

try {
  config = await loadConfig({ configPath, cwd: projectRoot });
} catch (error) {
  process.stderr.write(
    `Unable to load configuration from ${configPath}: ${
      error instanceof Error ? error.message : String(error)
    }\n`
  );
  process.exit(2);
}

const credentialStore = new FallbackCredentialStore(
  new LocalCredentialStore(),
  new EnvironmentCredentialStore()
);
let credential;

try {
  credential = await credentialStore.get(
    config.security.credentialTarget,
    config.account.email
  );
} catch (error) {
  process.stderr.write(
    `Unable to read credentials for ${config.account.email}: ${
      error instanceof Error ? error.message : String(error)
    }\n`
  );
  process.exit(2);
}

if (!credential) {
  process.stderr.write(
    [
      `No authorization code found for ${config.account.email}.`,
      "Run \"npm run set-password -- qq-email-mcp " +
        `${config.account.email}\", then enter the authorization code when prompted.`,
      "or set QQ_EMAIL_AUTH_CODE for local development.",
      "Use the QQ Mail authorization code, not the QQ password."
    ].join("\n") + "\n"
  );
  process.exit(2);
}

const client = new Client(
  { name: "qq-email-mcp-smoke-test", version: "0.1.0" },
  { capabilities: {} }
);
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(projectRoot, "dist", "index.js")],
  cwd: projectRoot,
  env: {
    QQ_EMAIL_MCP_CONFIG: configPath,
    QQ_EMAIL_AUTH_CODE: credential
  },
  stderr: "pipe"
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const status = await client.callTool({
    name: "mail_status",
    arguments: {}
  });
  const folders = await client.callTool({
    name: "mail_folders",
    arguments: {}
  });
  const list = await client.callTool({
    name: "mail_list",
    arguments: {
      folder: "INBOX",
      limit: 1
    }
  });

  const results = {
    status,
    folders,
    list
  };
  const folderContent = folders.structuredContent;
  const listContent = list.structuredContent;
  const statusContent = status.structuredContent;
  const folderCount = Array.isArray(folderContent?.folders)
    ? folderContent.folders.length
    : null;
  const listMessageCount = Array.isArray(listContent?.messages)
    ? listContent.messages.length
    : null;
  const failed =
    Object.values(results).some((result) => result.isError) ||
    statusContent?.connected !== true ||
    statusContent?.ready !== true ||
    statusContent?.imap !== "ok" ||
    statusContent?.smtp !== "ok" ||
    statusContent?.folders !== "ok" ||
    folderCount === null ||
    folderCount < 1 ||
    listMessageCount === null;

  process.stdout.write(
    `${JSON.stringify(
      {
        configPath,
        tools: tools.tools.map((tool) => tool.name).sort(),
        status: statusContent,
        folderCount,
        listMessageCount,
        ok: !failed
      },
      null,
      2
    )}\n`
  );

  if (failed) {
    process.exitCode = 1;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
} finally {
  await client.close();
}
