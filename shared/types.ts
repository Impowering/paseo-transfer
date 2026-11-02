import type { TransferLimits } from "./limits";

export interface Host {
  target: string;
  label: string;
  source: "ssh" | "tailscale";
}
export interface Endpoint {
  target: string;
  home?: string;
  identityFile?: string;
  port?: number;
  knownHostsFile?: string;
}
export interface Workspace {
  workspaceId: string;
  name: string;
  cwd: string;
  isolation: string;
  project: string;
}
export interface FileEntry {
  path: string;
  data: string;
  mode: number;
  link?: string;
}
export interface Session {
  id: string;
  provider: "claude" | "codex";
  title: string;
  labels: Record<string, string>;
  archived: boolean;
  files: FileEntry[];
}
export interface Snapshot {
  version: 1;
  sourceId: string;
  workspace: Workspace;
  head: string | null;
  branch: string | null;
  bundle: string | null;
  indexPatch: string;
  files: FileEntry[];
  deleted: string[];
  sessions: Session[];
  skipped: string[];
  hasIgnored: boolean;
  fingerprint: string;
  bytes: number;
}
export interface ExportedArchive {
  file: string;
  fingerprint: string;
  checksum: string;
  wireBytes: number;
  bytes: number;
  workspace: Workspace;
  sourceId: string;
  files: number;
  branch: string | null;
  sessions: Session[];
  hasIgnored: boolean;
}
export interface Plan {
  id: string;
  workspace: Workspace;
  destination: string;
  files: number;
  sessions: number;
  bytes: number;
  branch: string | null;
  skipped: string[];
  mode: "copy" | "move";
}
export interface TransferResult {
  workspaceId: string;
  cwd: string;
  agents: string[];
  verified: boolean;
  sourceArchived: boolean;
}
export type WorkerRequest =
  | {
      action: "archive-export";
      home?: string;
      workspaceId: string;
      limits?: Partial<TransferLimits>;
    }
  | {
      action: "archive-receive";
      home?: string;
      destination: string;
      file: string;
      checksum: string;
      limits?: Partial<TransferLimits>;
    }
  | {
      action: "archive-source";
      home?: string;
      workspaceId: string;
      fingerprint: string;
      limits?: Partial<TransferLimits>;
    }
  | {
      action: "archive-upload";
      wireBytes: number;
      limits?: Partial<TransferLimits>;
    }
  | { action: "archive-release"; file: string }
  | { action: "info"; home?: string }
  | { action: "list"; home?: string }
  | { action: "snapshot"; home?: string; workspaceId: string }
  | {
      action: "check";
      home?: string;
      destination: string;
      sessions: Session[];
      limits?: Partial<TransferLimits>;
    }
  | {
      action: "receive";
      home?: string;
      destination: string;
      snapshot: Snapshot;
    }
  | {
      action: "archive";
      home?: string;
      workspaceId: string;
      fingerprint: string;
    };
