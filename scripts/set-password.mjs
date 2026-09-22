#!/usr/bin/env node
import process from "node:process";
import { LocalCredentialStore } from "../dist/security/credentials.js";

const [serviceArgument, accountArgument, secretArgument] = process.argv.slice(2);
if (!serviceArgument || !accountArgument) {
  process.stderr.write(
    "Usage: node scripts/set-password.mjs <service> <account> [authorization-code]\n"
  );
  process.exit(2);
}

let secret = secretArgument;
if (!secret) {
  secret = await promptHidden("QQ Mail authorization code: ");
}

if (!secret) {
  process.stderr.write("Authorization code cannot be empty.\n");
  process.exit(2);
}

await new LocalCredentialStore().set(serviceArgument, accountArgument, secret);
process.stdout.write("Credential stored.\n");

async function promptHidden(prompt) {
  const input = process.stdin;
  const output = process.stderr;

  if (!input.isTTY) {
    const chunks = [];
    for await (const chunk of input) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString("utf8").split(/\r?\n/, 1)[0].trim();
  }

  output.write(prompt);
  input.setRawMode(true);
  input.resume();
  let value = "";

  try {
    for await (const chunk of input) {
      for (const character of chunk.toString("utf8")) {
        if (character === "\r" || character === "\n") {
          output.write("\n");
          return value.trim();
        }
        if (character === "\u0003") {
          output.write("\n");
          process.exit(130);
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += character;
      }
    }
  } finally {
    input.setRawMode(false);
    input.pause();
  }

  return value.trim();
}
