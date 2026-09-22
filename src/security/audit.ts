import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export interface AuditEvent {
  tool: string;
  action: string;
  result: "success" | "failure";
  folder?: string;
  uid?: number;
  errorCode?: string;
  durationMs?: number;
}

export interface AuditLogger {
  write(event: AuditEvent): Promise<void>;
}

export class FileAuditLogger implements AuditLogger {
  constructor(
    private readonly logPath: string,
    private readonly enabled = true
  ) {}

  async write(event: AuditEvent): Promise<void> {
    if (!this.enabled) {
      return;
    }

    await mkdir(path.dirname(this.logPath), { recursive: true });
    const record = {
      timestamp: new Date().toISOString(),
      ...event
    };
    await appendFile(this.logPath, `${JSON.stringify(record)}\n`, "utf8");
  }
}

export class NoopAuditLogger implements AuditLogger {
  async write(_event: AuditEvent): Promise<void> {}
}
