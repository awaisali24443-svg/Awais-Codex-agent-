export interface FileAttachment {
  name: string;
  type: string;
  size?: number;
  base64?: string;
  dataUrl?: string;
}

export interface TaskExecutePayload {
  agent: string;
  input: any;
  environment: string;
  background?: boolean;
  stream?: boolean;
  previous_interaction_id?: string;
}

export interface AntigravityError {
  type: string;
  message: string;
  status?: number;
}
