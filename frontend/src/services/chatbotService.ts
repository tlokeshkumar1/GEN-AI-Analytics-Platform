import api, { getApiErrorMessage } from './api';
import { contextHeaders } from './executionContext';

// ── Types ────────────────────────────────────────────────────────────────────

export interface ProcessingStep {
  stage: string;
  status: 'running' | 'completed' | 'failed' | 'error' | 'skipped';
  message: string;
  details?: Record<string, any>;
  error?: string;
}

export interface ChatResponse {
  reply: string;
  sources: Array<{ ID?: string; TEXT_CHUNK?: string; SCORE?: number; METADATA?: string }>;
  session_id: string;
  model?: string;
  context?: Record<string, unknown>;
  graph_image?: string;
  chart_type?: string;
  insights?: string;
  intent?: string;
  processing?: ProcessingStep[];
  records_matched?: number;
  type?: string;
  status?: string;
  data?: Record<string, any>;
  query_plan?: Record<string, any>;
}

export interface ChatSession {
  SESSION_ID: string;
  SUBJECT: string;
  CREATED_AT: string;
  UPDATED_AT: string;
}

export interface ChatMessageRecord {
  MESSAGE_ID: string;
  SESSION_ID: string;
  ROLE: 'user' | 'assistant';
  CONTENT: string;
  SOURCES?: Array<{ ID?: string; TEXT_CHUNK?: string; SCORE?: number; METADATA?: string }> | null;
  INTENT?: string | null;
  METADATA?: Record<string, any> | null;
  TIMESTAMP: string;
}

export interface GenerateGraphRequest {
  prompt: string;
  chart_type?: string;
  dataset_id?: string;
  session_id?: string;
}

export interface GenerateGraphResponse {
  graph_image?: string;
  chart_type?: string;
  insights?: string;
  title?: string;
  metrics?: Record<string, any>;
  data?: Record<string, any>;
}

// ── Session API Functions ────────────────────────────────────────────────────

export const fetchChatSessions = async (signal?: AbortSignal): Promise<ChatSession[]> => {
  const res = await api.get<ChatSession[]>('/chat/sessions', { signal });
  if (!Array.isArray(res.data)) {
    throw new Error('Chat history returned an invalid response. Check the API destination and retry.');
  }
  return res.data;
};

export const fetchSessionMessages = async (sessionId: string, signal?: AbortSignal): Promise<ChatMessageRecord[]> => {
  const res = await api.get<ChatMessageRecord[]>(`/chat/sessions/${encodeURIComponent(sessionId)}`, { signal });
  if (!Array.isArray(res.data)) {
    throw new Error('Chat messages returned an invalid response. Please retry.');
  }
  return res.data;
};

export const deleteChatSession = async (sessionId: string): Promise<void> => {
  await api.delete(`/chat/sessions/${sessionId}`);
};

// ── Graph Generation API ─────────────────────────────────────────────────────

export const generateGraph = async (data: GenerateGraphRequest): Promise<GenerateGraphResponse> => {
  const res = await api.post<GenerateGraphResponse>('/graph/generate', data);
  if (res.data && res.data.graph_image && !res.data.graph_image.startsWith('data:')) {
    res.data.graph_image = `data:image/png;base64,${res.data.graph_image}`;
  }
  return res.data;
};

// ── Standard Chat Function ───────────────────────────────────────────────────

export const sendChatMessage = async (
  message: string,
  sessionId: string = 'default'
): Promise<ChatResponse> => {
  const res = await api.post<ChatResponse>('/chat', { message, session_id: sessionId });
  if (res.data && res.data.graph_image && !res.data.graph_image.startsWith('data:')) {
    res.data.graph_image = `data:image/png;base64,${res.data.graph_image}`;
  }
  return res.data;
};

// ── SSE Streaming Chat Function (Token & Stage Streaming) ───────────────────

export const sendChatMessageStream = async (
  message: string,
  sessionId: string = 'default',
  onStep: (step: ProcessingStep) => void,
  onToken: (token: string) => void,
  onResult: (res: ChatResponse) => void,
  onError: (err: any) => void,
  signal?: AbortSignal
) => {
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...contextHeaders() };
    const token = localStorage.getItem('auth_token');
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch('/api/chat/stream', {
      method: 'POST',
      headers,
      credentials: 'same-origin',
      body: JSON.stringify({ message, session_id: sessionId }),
      signal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => null);
      const detail = typeof data?.detail === 'string' ? data.detail : `Chat request failed (HTTP ${response.status}). Please retry.`;
      throw new Error(detail);
    }
    if (response.headers.get('content-type')?.includes('text/html')) {
      throw new Error('SAP returned a sign-in page. Sign in again and check the application router destination.');
    }
    if (!response.body) {
      const standardRes = await sendChatMessage(message, sessionId);
      onResult(standardRes);
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          try {
            const parsed = JSON.parse(trimmed.substring(6));

            switch (parsed.type) {
              case 'request_started':
                break;

              case 'stage': {
                const step: ProcessingStep = {
                  stage: parsed.stage,
                  status: parsed.status,
                  message: parsed.message,
                  details: parsed.details,
                  error: parsed.error,
                };
                onStep(step);
                break;
              }

              case 'processing':
                if (parsed.step) {
                  onStep(parsed.step);
                }
                break;

              case 'token':
                if (parsed.content) {
                  onToken(parsed.content);
                } else if (parsed.token) {
                  onToken(parsed.token);
                } else if (parsed.text) {
                  onToken(parsed.text);
                }
                break;

              case 'final_answer':
                if (parsed.content && !buffer.length) {
                  // If final answer is provided as a complete text
                }
                break;

              case 'result':
                if (parsed.data) {
                  const resData = parsed.data as ChatResponse;
                  if (resData.graph_image && !resData.graph_image.startsWith('data:')) {
                    resData.graph_image = `data:image/png;base64,${resData.graph_image}`;
                  }
                  onResult(resData);
                }
                break;

              case 'request_completed':
                break;

              case 'error':
                onError(new Error(parsed.message || parsed.error || 'Chat processing failed. Please retry.'));
                break;

              default:
                break;
            }
          } catch {
            // Ignore partial SSE lines
          }
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) return;
    onError(new Error(getApiErrorMessage(err, 'Chat request failed. Please retry.')));
  }
};
