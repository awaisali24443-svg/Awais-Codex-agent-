export interface TaskAttachment {
  name: string;
  size?: number;
  type?: string;
  base64?: string;
}

export interface TaskStep {
  type: string;
  signature?: string;
  summary?: string;
  title?: string;
  content?: { type: string; text: string }[];
  arguments?: { command?: string; path?: string; [key: string]: any };
  result?: { output?: string; status?: string; [key: string]: any };
  status?: 'running' | 'completed' | 'failed';
}

export interface InteractionArtifact {
  id?: string;
  name: string;
  type: 'code' | 'apk' | 'binary' | 'log' | 'doc';
  path?: string;
  code?: string;
  size?: string;
}

export interface ProjectTask {
  id: string;
  interactionId?: string;
  prompt: string;
  files?: TaskAttachment[];
  status: 'running' | 'completed' | 'failed';
  engine: string;
  steps: TaskStep[];
  output?: string;
  error?: string;
  errorType?: 'quota_exceeded' | 'auth_failed' | 'agent_unavailable' | 'unknown_error';
  created: string;
  updated: string;
  startedAt?: number;
  liveStatusMessage?: string;
  _artifacts?: InteractionArtifact[];
}

export type AgentEngine = 'antigravity-preview-05-2026';
