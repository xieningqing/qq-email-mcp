export interface MailAddress {
  name: string | null;
  address: string;
}

export interface AttachmentSummary {
  attachmentId: string;
  filename: string;
  contentType: string;
  size: number;
  disposition: string | null;
  contentId: string | null;
}

export interface MessageSummary {
  messageRef: string;
  subject: string;
  from: MailAddress | null;
  to: MailAddress[];
  date: string;
  unread: boolean;
  flagged: boolean;
  hasAttachments: boolean;
  attachmentCount: number;
  snippet: string | null;
}

export interface AgentContext {
  messageRef: string;
  threadRef: string | null;
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  cc: MailAddress[];
  replyTo: MailAddress[];
  date: string;
  text: string;
  signature?: string | null;
  signatureTruncated?: boolean;
  quotedHistory?: string | null;
  quotedHistoryTruncated?: boolean;
  htmlClean: string | null;
  htmlCleanTruncated?: boolean;
  attachments: AttachmentSummary[];
  links: string[];
  warnings: string[];
  truncated: boolean;
  nextCursor: string | null;
  isUntrusted: true;
}

export interface ThreadMessage {
  messageRef: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  subject: string;
  from: MailAddress[];
  to: MailAddress[];
  date: string;
  text: string;
  truncated: boolean;
  isUntrusted: true;
}

export interface ThreadContext {
  threadRef: string | null;
  messages: ThreadMessage[];
  truncated: boolean;
  isUntrusted: true;
}

export interface FolderInfo {
  name: string;
  displayName: string;
  role: string | null;
  selectable: boolean;
  specialUse: string | null;
}

export interface MailboxSnapshot {
  path: string;
  exists: number;
  uidValidity: string;
  uidNext: number;
}

export interface FetchedMessage {
  uid: number;
  source: Buffer;
  flags: Set<string>;
  internalDate: Date | null;
  hasAttachments: boolean;
  attachmentCount: number;
  envelope: {
    subject?: string | null;
    date?: Date | null;
    messageId?: string | null;
    inReplyTo?: string | null;
    from?: Array<{ name?: string | null; address?: string | null }>;
    to?: Array<{ name?: string | null; address?: string | null }>;
  } | null;
}

export interface FetchedMessageSummary {
  uid: number;
  flags: Set<string>;
  internalDate: Date | null;
  hasAttachments: boolean;
  attachmentCount: number;
  snippetText: string | null;
  envelope: FetchedMessage["envelope"];
}
