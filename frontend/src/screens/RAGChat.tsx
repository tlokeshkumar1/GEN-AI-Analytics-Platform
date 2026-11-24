import './RAGChat.css';
import { ApprovedPublicationAction } from '../components/PublishToFiles';
import React, { useState, useRef, useEffect } from 'react';
import { Sparkles, Rows3, ChartNoAxesCombined, ChartColumnIncreasing, Database, ArrowRight, ArrowUp, LoaderCircle } from 'lucide-react';
import {
  sendChatMessageStream,
  ChatResponse,
  ProcessingStep,
  fetchChatSessions,
  fetchSessionMessages,
  deleteChatSession
} from '../services/chatbotService';
import { MarkdownRenderer } from '../components/MarkdownRenderer';
import { ThinkingProcess, resolveIntentDetails } from '../components/ThinkingProcess';
import { getApiErrorMessage } from '../services/api';
import { getSemanticModels } from '../services/semanticService';
import { selectedContext, selectContext } from '../services/executionContext';
import { getDatasets } from '../services/datasetService';
import { DatasetItem } from '../types/dataset';

interface RAGChatProps {
  onNavigate: (path: string) => void;
  isActive: boolean;
  onClose?: () => void;
  onToggleMaximize?: () => void;
  isMaximized?: boolean;
  user?: {
    name?: string;
    email?: string;
    user_id?: string;
    [key: string]: any;
  } | null;
  userName?: string;
}

export interface RetrievedDocument {
  retrieval?: string;
  id: string;
  source: string;
  snippet: string;
  relevanceScore: number | null;
  tableOrCollection: string;
  timestamp: string;
}

export interface ChatMessage {
  retrievalWarnings?: string[];
  id: string;
  sender: 'user' | 'agent';
  timestamp: string;
  userRole?: string;
  text?: string;
  agentMeta?: {
    latency: string;
    cosineSim?: string;
    model: string;
  };
  chartData?: {
    title: string;
    unit: string;
    items: { label: string; value: number; displayValue: string }[];
  };
  riskFactors?: { title: string; desc: string }[];
  sources?: string;
  retrievedDocs?: RetrievedDocument[];
  processing?: ProcessingStep[];
  graph_image?: string;
  chart_type?: string;
  intent?: string;
  insights?: string;
  isStreaming?: boolean;
}

export interface ChatThread {
  id: string;
  title: string;
  subtitle: string;
  group: 'Today' | 'Yesterday' | 'Previous 7 Days' | 'Older';
  timestamp: string;
  messages: ChatMessage[];
}

export const toRetrievedDocument = (source: any, index: number): RetrievedDocument => {
  let meta: any = source.METADATA || {};
  if (typeof meta === 'string') { try { meta = JSON.parse(meta); } catch { meta = {}; } }
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) meta = {};
  const retrieval = meta.retrieval || (meta.row_id ? 'structured_record' : 'unknown');
  const isCosine = meta.score_type === 'cosine' || (meta.source_table === 'VECTOR_TABLE' && meta.score_type !== 'lexical');
  const score = isCosine && typeof source.SCORE === 'number' && Number.isFinite(source.SCORE) ? source.SCORE : null;
  return { id: source.ID || `source-${index}`, source: meta.source || 'Dataset evidence',
    snippet: source.TEXT_CHUNK || source.snippet || '', relevanceScore: score, retrieval,
    tableOrCollection: meta.source_table || meta.table || meta.dataset_id || 'Dataset evidence',
    timestamp: retrieval === 'hana_vector' ? 'HANA vector search' : retrieval === 'structured_record' ? 'Exact record match' :
      ['fallback', 'snapshot_lexical'].includes(retrieval) ? 'Snapshot keyword match' : 'Dataset evidence' };
};

const getGroupForDate = (dateStr?: string): 'Today' | 'Yesterday' | 'Previous 7 Days' | 'Older' => {
  if (!dateStr) return 'Today';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'Today';

  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays <= 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  if (diffDays <= 7) return 'Previous 7 Days';
  return 'Older';
};

// ── Client-Side Session Tracking (Maintained ONLY on client side, never in HANA/backend) ──

export const createNewEmptyThread = (): ChatThread => ({
  id: `thread-${Date.now()}`,
  title: 'New Conversation',
  subtitle: 'Empty context',
  group: 'Today',
  timestamp: 'Just now',
  messages: [],
});

export const formatStageTitle = (stage: string): string => {
  switch (stage) {
    case 'intent_classification':
    case 'intent_detection':
      return 'Intent Classification';
    case 'vector_search':
    case 'vector_retrieval':
      return 'HANA Vector Retrieval';
    case 'erp_lookup':
      return 'ERP Document Flow';
    case 'sql_execution':
      return 'Columnar SQL Execution';
    case 'llm_generation':
    case 'final_response':
      return 'NVIDIA NIM Synthesis';
    case 'document_flow':
      return 'Document Flow Verification';
    default:
      return stage
        .split('_')
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
  }
};

export const getTimeGreeting = (date: Date = new Date()): string => {
  const hour = date.getHours();
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 17) return 'Good afternoon';
  if (hour >= 17 && hour < 22) return 'Good evening';
  return 'Good evening';
};

/**
 * Extracts a clean, human-friendly display name (NOT an email address).
 * If the user's name or id contains an email, the domain is stripped and
 * the username portion is cleanly formatted.
 */
export const resolveUserName = (
  user?: { name?: string; email?: string; user_id?: string;[key: string]: any } | null,
  fallbackName?: string
): string => {
  if (fallbackName && typeof fallbackName === 'string' && fallbackName.trim()) {
    const trimmed = fallbackName.trim();
    if (trimmed.includes('@')) {
      const handle = trimmed.split('@')[0].trim();
      return handle
        .replace(/[._-]+/g, ' ')
        .split(' ')
        .filter(Boolean)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
    }
    return trimmed;
  }

  let candidate = user?.name || user?.user_id || '';

  if (!candidate && typeof window !== 'undefined') {
    try {
      const stored = sessionStorage.getItem('auth_user') || localStorage.getItem('auth_user');
      if (stored) {
        const parsed = JSON.parse(stored);
        candidate = parsed.name || parsed.user_id || parsed.email || '';
      }
    } catch {
      // ignore
    }
  }

  candidate = candidate.trim();

  // If candidate is an email or contains '@', strip domain and format username
  if (candidate.includes('@')) {
    const handle = candidate.split('@')[0].trim();
    const formatted = handle
      .replace(/[._-]+/g, ' ')
      .split(' ')
      .filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
    return formatted || 'User';
  }

  if (candidate) {
    const words = candidate.split(' ').filter(Boolean);
    if (words.length > 0) {
      return words
        .map(w => (w.length <= 2 && w === w.toUpperCase() ? w : w.charAt(0).toUpperCase() + w.slice(1)))
        .join(' ');
    }
    return candidate;
  }

  return 'User';
};

export const getUserInitials = (name: string): string => {
  if (!name || name === 'User') return 'U';
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 1) {
    return parts[0].slice(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
};

interface PromptSuggestion {
  icon: string;
  color: string;
  title: string;
  query: string;
  badge?: string;
}

const suggestionIcons: Record<string, React.ElementType> = { table_rows: Rows3, insights: ChartNoAxesCombined, bar_chart: ChartColumnIncreasing, database: Database };

const DEFAULT_SUGGESTIONS: PromptSuggestion[] = [
  {
    icon: 'table_rows',
    color: 'text-indigo-600',
    title: 'Count source records',
    query: 'Count records',
    badge: 'Summary',
  },
  {
    icon: 'insights',
    color: 'text-violet-600',
    title: 'Executive KPI Summary',
    query: 'Summarize key KPIs and leading contributors in the active dataset',
    badge: 'Insights',
  },
  {
    icon: 'bar_chart',
    color: 'text-sky-600',
    title: 'Metric Trend Analysis',
    query: 'Plot primary numeric metric trends across time periods',
    badge: 'Visualization',
  },
  {
    icon: 'database',
    color: 'text-emerald-600',
    title: 'Vector Grounding Audit',
    query: 'Search vector partitions for key record attributes',
    badge: 'Vector Engine',
  },
];

export const RAGChat: React.FC<RAGChatProps> = ({
  onNavigate,
  isActive,
  onClose,
  onToggleMaximize,
  isMaximized,
  user,
  userName,
}) => {
  const displayName = resolveUserName(user, userName);
  const userInitials = getUserInitials(displayName);
  const [suggestions, setSuggestions] = useState<PromptSuggestion[]>(DEFAULT_SUGGESTIONS);

  // Load suggestions from active dataset semantic model if available
  useEffect(() => {
    let cancelled = false;
    getDatasets().then(allDatasets => {
      if (cancelled || !allDatasets || allDatasets.length === 0) return;
      const activeDs = allDatasets.find(d => d.isActive) || allDatasets[0];
      const version = activeDs.currentVersion || 1;
      getSemanticModels(activeDs.id, version).then(models => {
        if (cancelled) return;
        const approved = models.find(m => m.status === 'approved') || models[0];
        if (approved) {
          const dynamicMeasures = approved.fields
            .filter(f => f.role === 'measure' && f.default_aggregation)
            .slice(0, 3)
            .map(f => ({
              icon: 'bar_chart',
              color: 'text-indigo-600',
              title: `${f.default_aggregation} ${f.semantic_name}`,
              query: `${f.default_aggregation} ${f.name}`,
              badge: 'Measure',
            }));
          if (dynamicMeasures.length > 0) {
            setSuggestions([DEFAULT_SUGGESTIONS[0], ...dynamicMeasures]);
          }
        }
      }).catch(() => {});
    }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  // Model and input state
  const [inputText, setInputText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [searchThreads, setSearchThreads] = useState('');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 144)}px`;
  }, [inputText]);

  // Chat history drawer (slides in above current chat from the side toggle)
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);

  // Three-dot menu and modal states
  const [activeMenuThreadId, setActiveMenuThreadId] = useState<string | null>(null);
  const [threadToDelete, setThreadToDelete] = useState<ChatThread | null>(null);
  const [deletingThread, setDeletingThread] = useState(false);
  const [threadToRename, setThreadToRename] = useState<ChatThread | null>(null);
  const [renameTitleInput, setRenameTitleInput] = useState('');
  const manuallyRenamedThreads = useRef(new Set<string>());
  const [previewGraphModalUrl, setPreviewGraphModalUrl] = useState<{ url: string; title?: string } | null>(null);

  // Expanded document source cards per message
  const [expandedDocMessageId, setExpandedDocMessageId] = useState<string | null>(null);
  const [loadingSessionId, setLoadingSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionLoadError, setSessionLoadError] = useState<string | null>(null);
  const [sessionsRetry, setSessionsRetry] = useState(0);
  const hasLoadedSessionsRef = useRef(false);
  const messageRequestRef = useRef<AbortController | null>(null);
  const streamRequestRef = useRef<AbortController | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 2500);
  };

  // ── Session State Initialization ──────────────────────────────────────────
  // 1) First-time opening: ALWAYS display a new empty chat session by default.
  // 2) If the user opens an existing session and navigates away and returns:
  //    automatically display the last chat session that the user had opened.
  // 3) Loads real sessions exclusively from SAP HANA Cloud via backend APIs (no mock/seed threads).
  const [threads, setThreads] = useState<ChatThread[]>(() => [createNewEmptyThread()]);
  const [activeThreadId, setActiveThreadId] = useState<string>(() => threads[0].id);
  const draftIds = useRef(new Set([threads[0].id]));

  useEffect(() => () => { messageRequestRef.current?.abort(); streamRequestRef.current?.abort(); }, []);

  // Close history drawer when Escape is pressed
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isSidebarOpen) {
        setIsSidebarOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isSidebarOpen]);

  // Currently active thread
  const activeThread = threads.find(t => t.id === activeThreadId) || threads[0] || null;
  const messages = activeThread?.messages || [];

  // Fetch only session summaries when the user opens RAG Chat (stale-while-revalidate on repeat opens).
  useEffect(() => {
    if (!isActive) return;
    const controller = new AbortController();
    if (!hasLoadedSessionsRef.current) {
      setLoadingSessions(true);
    }
    setSessionsError(null);
    const loadSessionsFromBackend = async () => {
      try {
        const sessions = await fetchChatSessions(controller.signal);
        if (controller.signal.aborted) return;
        hasLoadedSessionsRef.current = true;
        if (sessions && Array.isArray(sessions)) {
          const loadedThreads: ChatThread[] = sessions.map(s => {
            const group = getGroupForDate(s.UPDATED_AT || s.CREATED_AT);
            let timeDisplay = 'Recently';
            if (s.UPDATED_AT) {
              const d = new Date(s.UPDATED_AT);
              if (!isNaN(d.getTime())) {
                timeDisplay = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              }
            }

            return {
              id: s.SESSION_ID,
              title: s.SUBJECT || 'Conversation',
              subtitle: `Session: ${s.SESSION_ID.slice(0, 14)}...`,
              group,
              timestamp: timeDisplay,
              messages: [],
            };
          });

          // Keep drafts and already loaded messages; never open a saved session automatically.
          setThreads(prev => {
            const ids = new Set(loadedThreads.map(thread => thread.id));
            const localThreads = prev.filter(thread => !ids.has(thread.id));
            const savedThreads = loadedThreads.map(thread => {
              const existing = prev.find(item => item.id === thread.id);
              if (existing) return { ...thread, title: manuallyRenamedThreads.current.has(thread.id) ? existing.title : thread.title, subtitle: existing.subtitle, messages: existing.messages };
              return thread;
            });
            ids.forEach(id => draftIds.current.delete(id));
            return [...localThreads, ...savedThreads];
          });
        }
      } catch (err) {
        if (!controller.signal.aborted) setSessionsError(getApiErrorMessage(err, 'Unable to load chat sessions. Please retry.'));
      } finally {
        if (!controller.signal.aborted) setLoadingSessions(false);
      }
    };
    loadSessionsFromBackend();
    return () => controller.abort();
  }, [isActive, sessionsRetry]);

  // Fetch full message history for a given session from backend
  const loadThreadMessages = async (threadId: string, signal: AbortSignal) => {
    try {
      const rawMsgs = await fetchSessionMessages(threadId, signal);
      if (signal.aborted) return;
      if (!Array.isArray(rawMsgs)) throw new Error('Invalid conversation response');

      const convertedMsgs: ChatMessage[] = rawMsgs.map(m => {
        // Parse SOURCES safely
        let sourcesArray: any[] = [];
        if (Array.isArray(m.SOURCES)) {
          sourcesArray = m.SOURCES;
        } else if (typeof m.SOURCES === 'string') {
          try {
            sourcesArray = JSON.parse(m.SOURCES);
          } catch {
            sourcesArray = [];
          }
        }

        // Parse METADATA safely
        let metaObj: any = {};
        if (typeof m.METADATA === 'object' && m.METADATA !== null) {
          metaObj = m.METADATA;
        } else if (typeof m.METADATA === 'string') {
          try {
            metaObj = JSON.parse(m.METADATA);
          } catch {
            metaObj = {};
          }
        }

        // Map retrieved docs
        const retrievedDocs: RetrievedDocument[] = (Array.isArray(sourcesArray) ? sourcesArray : []).map(toRetrievedDocument);

        // Parse timestamp
        let formattedTime = 'Just now';
        if (m.TIMESTAMP) {
          const parsedDate = new Date(m.TIMESTAMP);
          if (!isNaN(parsedDate.getTime())) {
            formattedTime = parsedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          }
        }

        const scoredDocsHist = retrievedDocs.filter(d => typeof d.relevanceScore === 'number' && d.relevanceScore > 0);
        const maxDocHist = scoredDocsHist.length > 0 ? scoredDocsHist.reduce((max, d) => (d.relevanceScore! > max.relevanceScore! ? d : max)) : null;
        const histCosine = metaObj.cosineSim && metaObj.cosineSim !== 'Not available' ? metaObj.cosineSim : (maxDocHist?.relevanceScore != null ? String(maxDocHist.relevanceScore) : undefined);

        return {
          id: m.MESSAGE_ID || `msg-${Math.random()}`,
          sender: m.ROLE === 'user' ? 'user' : 'agent',
          timestamp: formattedTime,
          userRole: m.ROLE === 'user' ? `You · ${displayName}` : undefined,
          text: m.CONTENT,
          agentMeta: m.ROLE !== 'user' ? {
            latency: metaObj.latency || 'Not available',
            cosineSim: histCosine,
            model: metaObj.model || 'Not available',
          } : undefined,
          chartData: metaObj.chartData || (metaObj.chart_type ? {
            title: `${metaObj.chart_type.toUpperCase()} Analytics Chart`,
            unit: 'Value',
            items: [],
          } : undefined),
          riskFactors: metaObj.riskFactors || undefined,
          sources: sourcesArray.length > 0 ? `${sourcesArray.length} RAG sources evaluated` : undefined,
          retrievedDocs,
          graph_image: metaObj.graph_image,
          chart_type: metaObj.chart_type,
          intent: m.INTENT || metaObj.intent,
          insights: metaObj.insights,
          processing: metaObj.processing,
          retrievalWarnings: metaObj.warnings,
        };
      });

      setThreads(prev =>
        prev.map(t => {
          if (t.id === threadId) {
            const lastUserMsg = [...convertedMsgs].reverse().find(m => m.sender === 'user');
            const newSubtitle = lastUserMsg?.text
              ? lastUserMsg.text.slice(0, 42)
              : (t.subtitle || 'Session conversation');

            return {
              ...t,
              subtitle: newSubtitle,
              messages: convertedMsgs,
            };
          }
          return t;
        })
      );
    } catch (err) {
      if (!signal.aborted) setSessionLoadError(getApiErrorMessage(err, 'Unable to open this conversation. Please retry.'));
    }
  };

  // Scroll smoothly to bottom when messages or submitting state change
  useEffect(() => {
    if (messages.length > 0 || isSubmitting) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isSubmitting]);

  // Close menus on outside click
  useEffect(() => {
    const handleWindowClick = () => {
      setActiveMenuThreadId(null);
    };
    window.addEventListener('click', handleWindowClick);
    return () => window.removeEventListener('click', handleWindowClick);
  }, []);

  const handleSelectThread = async (threadId: string) => {
    if (isSubmitting) return;
    messageRequestRef.current?.abort();
    messageRequestRef.current = null;
    setActiveThreadId(threadId);
    setIsSidebarOpen(false);
    setSessionLoadError(null);
    setInputText('');
    if (draftIds.current.has(threadId)) {
      setLoadingSessionId(null);
      return;
    }
    const controller = new AbortController();
    messageRequestRef.current = controller;
    setLoadingSessionId(threadId);
    try {
      await loadThreadMessages(threadId, controller.signal);
    } finally {
      if (messageRequestRef.current === controller) {
        messageRequestRef.current = null;
        setLoadingSessionId(null);
      }
    }
  };

  const handleCreateNewChat = () => {
    const newThread = createNewEmptyThread();
    messageRequestRef.current?.abort();
    messageRequestRef.current = null;
    setLoadingSessionId(null);
    setSessionLoadError(null);
    draftIds.current.add(newThread.id);

    setThreads(prev => {
      const updated = [newThread, ...prev];
      return updated;
    });
    setActiveThreadId(newThread.id);
    setIsSidebarOpen(false);
    setInputText('');
    showToast('Created new conversation');
    setTimeout(() => inputRef.current?.focus(), 80);
  };

  const handleDeleteThreadConfirmed = async () => {
    if (!threadToDelete) return;
    if (deletingThread) return;
    setDeletingThread(true);
    const deletedId = threadToDelete.id;
    try {
      if (!draftIds.current.has(deletedId)) await deleteChatSession(deletedId);
    } catch (err) {
      setSessionLoadError(getApiErrorMessage(err, 'Unable to delete this conversation. Please retry.'));
      setThreadToDelete(null);
      setDeletingThread(false);
      return;
    }
    const remaining = threads.filter(t => t.id !== deletedId);
    setThreads(remaining);
    draftIds.current.delete(deletedId);

    if (activeThreadId === deletedId) {
      messageRequestRef.current?.abort();
      messageRequestRef.current = null;
      setLoadingSessionId(null);
      setSessionLoadError(null);
      const fallback = createNewEmptyThread();
      draftIds.current.add(fallback.id);
      setThreads([fallback, ...remaining]);
      setActiveThreadId(fallback.id);
    }

    setThreadToDelete(null);
    setDeletingThread(false);
    showToast('Conversation permanently deleted');
  };

  const handleRenameThreadConfirmed = () => {
    if (!threadToRename || !renameTitleInput.trim()) return;
    manuallyRenamedThreads.current.add(threadToRename.id);
    setThreads(prev =>
      prev.map(t =>
        t.id === threadToRename.id
          ? { ...t, title: renameTitleInput.trim() }
          : t
      )
    );
    setThreadToRename(null);
    showToast('Conversation renamed');
  };

  const handleSendMessage = () => {
    if (!inputText.trim() || isSubmitting || loadingSessionId || sessionLoadError) return;

    const query = inputText.trim();
    setInputText('');

    const startTime = Date.now();
    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      sender: 'user',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      userRole: `You · ${displayName}`,
      text: query,
    };

    const agentMsgId = `agent-${Date.now()}`;
    const lowerQ = query.toLowerCase();
    let initialIntent = 'analytics_graph';
    if (
      lowerQ.includes('order') ||
      lowerQ.includes('so-') ||
      lowerQ.includes('fulfillment')
    ) {
      initialIntent = 'order_lookup';
    } else if (
      lowerQ.includes('vector') ||
      lowerQ.includes('hana') ||
      lowerQ.includes('search') ||
      lowerQ.includes('document')
    ) {
      initialIntent = 'hana_vector_search';
    }

    const initialAgentMsg: ChatMessage = {
      id: agentMsgId,
      sender: 'agent',
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      intent: initialIntent,
      agentMeta: {
        latency: 'Streaming...',
        cosineSim: undefined,
        model: 'NVIDIA NIM / SAP AI Core',
      },
      text: '',
      processing: [],
      isStreaming: true,
    };

    // Append user message & placeholder agent message in active thread
    setThreads(prev =>
      prev.map(t => {
        if (t.id === activeThreadId) {
          return {
            ...t,
            subtitle: query.slice(0, 42),
            messages: [...t.messages, userMsg, initialAgentMsg],
          };
        }
        return t;
      })
    );

    setIsSubmitting(true);

    // Handle stage updates from SSE
    const handleStep = (step: ProcessingStep) => {
      setThreads(prev =>
        prev.map(t => {
          if (t.id === activeThreadId) {
            return {
              ...t,
              messages: t.messages.map(m => {
                if (m.id === agentMsgId) {
                  const existingSteps = m.processing || [];
                  const existsIdx = existingSteps.findIndex(s => s.stage === step.stage);
                  let updatedSteps: ProcessingStep[];
                  if (existsIdx >= 0) {
                    updatedSteps = [...existingSteps];
                    updatedSteps[existsIdx] = { ...updatedSteps[existsIdx], ...step };
                  } else {
                    updatedSteps = [...existingSteps, step];
                  }

                  let newIntent = m.intent;
                  const stepMsg = (step.message || '').toLowerCase();
                  if (stepMsg.includes('order')) newIntent = 'order_lookup';
                  else if (stepMsg.includes('vector') || stepMsg.includes('hana')) newIntent = 'hana_vector_search';
                  else if (stepMsg.includes('analytics') || stepMsg.includes('graph')) newIntent = 'analytics_graph';

                  return {
                    ...m,
                    intent: newIntent,
                    processing: updatedSteps,
                  };
                }
                return m;
              }),
            };
          }
          return t;
        })
      );
    };

    // Handle real-time token streaming
    const handleToken = (token: string) => {
      setThreads(prev =>
        prev.map(t => {
          if (t.id === activeThreadId) {
            return {
              ...t,
              messages: t.messages.map(m => {
                if (m.id === agentMsgId) {
                  return {
                    ...m,
                    text: (m.text || '') + token,
                  };
                }
                return m;
              }),
            };
          }
          return t;
        })
      );
    };

    // Handle full result metadata
    const handleResult = (res: ChatResponse) => {
      const docs: RetrievedDocument[] = (res.sources || []).map(toRetrievedDocument);

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);

      setThreads(prev =>
        prev.map(t => {
          if (t.id === activeThreadId) {
            return {
              ...t,
              id: res.session_id || t.id,
              title: manuallyRenamedThreads.current.has(t.id) ? t.title : (res.session_title || t.title),
              messages: t.messages.map(m => {
                if (m.id === agentMsgId) {
                  const completedProcessing = (m.processing || []).map(p => ({
                    ...p,
                    status: (p.status === 'running' ? 'completed' : p.status) as any,
                  }));

                  const scoredDocList = docs.filter(d => typeof d.relevanceScore === 'number' && d.relevanceScore > 0);
                  const topDoc = scoredDocList.length > 0 ? scoredDocList.reduce((max, d) => (d.relevanceScore! > max.relevanceScore! ? d : max)) : null;
                  const cosineScore = res.cosine_score != null ? String(res.cosine_score) : (topDoc?.relevanceScore != null ? topDoc.relevanceScore.toFixed(3) : undefined);

                  return {
                    ...m,
                    isStreaming: false,
                    text: res.reply || m.text || res.insights || 'Grounded response generated.',
                    agentMeta: {
                      latency: `${elapsed}s`,
                      cosineSim: cosineScore,
                      model: res.model || 'Not reported',
                    },
                    sources: `${docs.length} dataset evidence sources`,
                    retrievedDocs: docs,
                    graph_image: res.graph_image,
                    chart_type: res.chart_type,
                    insights: res.insights,
                    intent: res.intent || initialIntent,
                    processing: completedProcessing,
                    retrievalWarnings: res.warnings,
                  };
                }
                return m;
              }),
            };
          }
          return t;
        })
      );
      if (res.session_id && res.session_id !== activeThreadId) {
        if (manuallyRenamedThreads.current.delete(activeThreadId)) manuallyRenamedThreads.current.add(res.session_id);
        draftIds.current.delete(activeThreadId);
        setActiveThreadId(res.session_id);
      }
      setIsSubmitting(false);
    };

    streamRequestRef.current?.abort();
    const streamController = new AbortController();
    streamRequestRef.current = streamController;
    sendChatMessageStream(
      query,
      draftIds.current.has(activeThreadId) ? 'default' : activeThreadId,
      handleStep,
      handleToken,
      handleResult,
      (err: unknown) => {
        const message = getApiErrorMessage(err, 'Chat processing failed. Please retry.');
        handleStep({ stage: 'error', status: 'failed', message, error: message });
        setThreads(prev => prev.map(t => t.id === activeThreadId ? {
          ...t,
          messages: t.messages.map(m => m.id === agentMsgId ? { ...m, isStreaming: false, text: message } : m),
        } : t));
        setIsSubmitting(false);
      },
      streamController.signal,
      undefined
    );
  };

  const handleSuggestedPrompt = (promptText: string) => {
    setInputText(promptText);
    inputRef.current?.focus();
  };

  const handleExportMarkdown = (thread: ChatThread) => {
    const transcript = thread.messages
      .map(m => {
        if (m.sender === 'user') {
          return `### ${m.userRole || 'User'} (${m.timestamp})\n\n${m.text}\n`;
        } else {
          return `### NEOVATIC RAG Assistant (${m.timestamp})\n*Model: ${m.agentMeta?.model || 'Not reported'} | Latency: ${m.agentMeta?.latency || 'Not available'} | Match score: ${m.agentMeta?.cosineSim || 'Not available'}*\n\n${m.text}\n\n**Sources:** ${m.sources || 'No sources returned'}\n`;
        }
      })
      .join('\n---\n\n');

    const blob = new Blob([`# ${thread.title}\n\n${transcript}`], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${thread.title.replace(/[^a-zA-Z0-9]/g, '_')}_Transcript.md`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Conversation exported as Markdown');
  };

  const filteredThreads = threads.filter(
    t =>
      t.title.toLowerCase().includes(searchThreads.toLowerCase()) ||
      t.subtitle.toLowerCase().includes(searchThreads.toLowerCase())
  );

  const groups: ('Today' | 'Yesterday' | 'Previous 7 Days' | 'Older')[] = ['Today', 'Yesterday', 'Previous 7 Days', 'Older'];

  return (
    <div className="rag-chat-workspace flex w-full h-full overflow-hidden rounded-[var(--radius-page)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-sm)] relative select-auto font-sans">
      {/* Toast Alert */}
      {toastMessage && (
        <div className="fixed top-20 right-4 sm:right-8 z-50 bg-[var(--color-text-primary)] text-white px-4 py-2.5 rounded-[var(--radius-element)] shadow-[var(--shadow-xl)] flex items-center gap-2.5 text-xs animate-in fade-in slide-in-from-top-2 border border-[var(--color-border)]">
          <span className="material-symbols-outlined text-[17px] text-[var(--color-success)]">check_circle</span>
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {threadToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs animate-in fade-in">
          <div role="alertdialog" aria-modal="true" aria-labelledby="delete-chat-title"
            className="w-full max-w-md bg-[var(--color-surface)] rounded-[var(--radius-page)] p-6 shadow-[var(--shadow-xl)] border border-[var(--color-border)] animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-3.5 mb-4">
              <div className="w-10 h-10 rounded-[var(--radius-element)] bg-[var(--color-danger-subtle)] text-[var(--color-danger)] flex items-center justify-center shrink-0 border border-[var(--color-danger-border)]">
                <span className="material-symbols-outlined text-[22px]">delete_forever</span>
              </div>
              <div className="flex flex-col">
                <h3 id="delete-chat-title" className="text-base text-[var(--color-text-primary)] font-semibold">Delete Conversation?</h3>
                <p className="text-xs text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                  Are you sure you want to permanently delete <strong className="text-[var(--color-text-primary)]">"{threadToDelete.title}"</strong>? This will remove all prompt history, retrieved vectors, and charts in this session.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-3 border-t border-[var(--color-border)]">
              <button
                type="button"
                disabled={deletingThread}
                autoFocus
                onClick={() => setThreadToDelete(null)}
                className="px-4 py-2 rounded-[var(--radius-element)] text-xs font-medium text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDeleteThreadConfirmed}
                disabled={deletingThread}
                className="px-4 py-2 rounded-[var(--radius-element)] text-xs font-medium bg-[var(--color-danger)] hover:opacity-90 text-white shadow-[var(--shadow-2xs)] transition-colors flex items-center gap-1.5 cursor-pointer active:scale-95"
              >
                <span className="material-symbols-outlined text-[16px]">delete</span>
                <span>{deletingThread ? 'Deleting…' : 'Delete Chat'}</span>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Conversation Modal */}
      {threadToRename && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-xs animate-in fade-in">
          <div
            className="w-full max-w-md bg-white rounded-2xl p-6 shadow-2xl border border-slate-200 animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2 mb-3">
              <span className="material-symbols-outlined text-[20px] text-indigo-600">edit</span>
              <h3 className="font-headline-sm text-slate-900 font-semibold">Rename Conversation</h3>
            </div>
            <p className="text-body-sm text-slate-600 mb-3">
              Enter a concise descriptive title for this session thread.
            </p>
            <input
              type="text"
              value={renameTitleInput}
              onChange={(e) => setRenameTitleInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleRenameThreadConfirmed();
                if (e.key === 'Escape') setThreadToRename(null);
              }}
              className="w-full h-10 px-3.5 rounded-xl bg-slate-50 border border-slate-200 text-slate-900 font-body-md focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 mb-4 transition-all"
              autoFocus
            />
            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={() => setThreadToRename(null)}
                className="px-4 py-2 rounded-xl text-body-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleRenameThreadConfirmed}
                className="px-4 py-2 rounded-xl text-body-sm font-medium bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-700 hover:to-indigo-700 text-white shadow-xs transition-all active:scale-95 cursor-pointer"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* SAP AI Core Graph Enlarge Modal */}
      {previewGraphModalUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 bg-slate-900/60 backdrop-blur-sm animate-in fade-in"
          onClick={() => setPreviewGraphModalUrl(null)}
        >
          <div
            className="w-full max-w-4xl max-h-[90vh] bg-white rounded-2xl p-4 sm:p-6 shadow-2xl border border-slate-200 flex flex-col animate-in zoom-in-95 duration-150"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-3 mb-3 border-b border-slate-100 shrink-0">
              <div className="flex items-center gap-2">
                <span className="material-symbols-outlined text-[20px] text-violet-600">insert_chart</span>
                <h3 className="font-headline-sm text-sm sm:text-base text-slate-900 font-semibold">
                  {previewGraphModalUrl.title ? `${previewGraphModalUrl.title.charAt(0).toUpperCase() + previewGraphModalUrl.title.slice(1)} Visualization` : 'SAP AI Core Graph Generation'}
                </h3>
                <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-700 bg-violet-50 px-2.5 py-0.5 rounded-full border border-violet-200">
                  SAP AI Core
                </span>
              </div>
              <div className="flex items-center gap-2">
                <a
                  href={previewGraphModalUrl.url}
                  download="generated_analytics_graph.png"
                  className="h-8.5 px-3 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-medium inline-flex items-center gap-1.5 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[15px]">download</span>
                  <span>Download PNG</span>
                </a>
                <button
                  type="button"
                  onClick={() => setPreviewGraphModalUrl(null)}
                  className="w-8.5 h-8.5 rounded-xl flex items-center justify-center text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  <span className="material-symbols-outlined text-[20px]">close</span>
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto flex items-center justify-center p-3 bg-slate-50/70 rounded-xl border border-slate-100">
              <img
                src={previewGraphModalUrl.url}
                alt="Enlarged SAP AI Core Graph"
                className="max-h-[72vh] max-w-full object-contain rounded-lg shadow-xs"
              />
            </div>
          </div>
        </div>
      )}

      {/* Chat History Overlay Backdrop (covers current chat when drawer is open) */}
      {isSidebarOpen && (
        <div
          className="absolute inset-0 z-30 bg-slate-900/20 backdrop-blur-[1px] transition-opacity duration-300 animate-in fade-in"
          onClick={() => setIsSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* ============================================================ */}
      {/* 1. CHAT SESSIONS DRAWER: Slides in above current chat from the side */}
      {/* ============================================================ */}
      <aside
        className={`
          rag-history absolute inset-y-0 left-0 z-40 w-[285px] sm:w-[320px] max-w-[85%]
          bg-slate-50/95 backdrop-blur-md border-r border-slate-200/90 flex flex-col justify-between
          transition-all duration-300 ease-in-out p-3.5 overflow-hidden h-full
          ${isSidebarOpen ? 'translate-x-0 pointer-events-auto shadow-2xl opacity-100 visible' : '-translate-x-full pointer-events-none shadow-none opacity-0 invisible'}
        `}
        id="rag-chat-history"
        aria-label="Chat history sessions"
      >
        <div className="flex flex-col h-full min-w-[245px] overflow-hidden">
          {/* Top Actions: New Chat & Collapse */}
          <div className="flex items-center gap-2 mb-3 shrink-0">
            <button
              type="button"
              onClick={handleCreateNewChat}
              className="flex-1 h-9 px-3 rounded-xl bg-gradient-to-r from-violet-600 via-indigo-600 to-indigo-700 hover:from-violet-700 hover:to-indigo-800 text-white font-label-md text-label-md font-medium flex items-center justify-center gap-2 transition-all shadow-sm shadow-indigo-500/20 active:scale-95 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[18px]">add</span>
              <span>New Chat</span>
            </button>

            {/* Collapse toggle */}
            <button
              type="button"
              onClick={() => setIsSidebarOpen(false)}
              title="Collapse history sidebar"
              className="w-9 h-9 rounded-xl bg-white hover:bg-slate-100 border border-slate-200/90 text-slate-500 hover:text-slate-800 flex items-center justify-center transition-colors shrink-0 shadow-2xs cursor-pointer active:scale-95"
              aria-label="Collapse history sidebar"
            >
              <span className="material-symbols-outlined text-[18px]">left_panel_close</span>
            </button>
          </div>

          {/* Quick Search Input */}
          <div className="relative mb-3 shrink-0">
            <span className="material-symbols-outlined absolute left-2.5 top-2.5 text-slate-400 text-[16px] pointer-events-none">
              search
            </span>
            <input
              type="text"
              value={searchThreads}
              onChange={(e) => setSearchThreads(e.target.value)}
              placeholder="Search conversations..."
              className="w-full h-8.5 pl-8 pr-7 rounded-xl bg-white border border-slate-200/90 text-xs text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/10 transition-all shadow-2xs"
            />
            {searchThreads && (
              <button
                onClick={() => setSearchThreads('')}
                className="absolute right-2.5 top-2 text-slate-400 hover:text-slate-700"
              >
                <span className="material-symbols-outlined text-[14px]">close</span>
              </button>
            )}
          </div>

          {/* Controlled Scrollable Thread List */}
          <div className="flex-1 overflow-y-auto space-y-3.5 pr-0.5 select-none scroll-touch min-h-0">
            {loadingSessions && (
              <div role="status" className="py-3 text-center text-xs text-slate-500 flex items-center justify-center gap-1.5">
                <span className="material-symbols-outlined text-[16px] animate-spin text-indigo-600">progress_activity</span>
                <span>Loading chat sessions...</span>
              </div>
            )}
            {sessionsError && (
              <div role="alert" className="py-2 text-center text-xs text-rose-600">
                {sessionsError}{' '}
                <button onClick={() => setSessionsRetry(value => value + 1)} className="underline font-semibold ml-1 cursor-pointer">
                  Retry
                </button>
              </div>
            )}
            {filteredThreads.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-400">
                No conversations found
              </div>
            ) : (
              groups.map(group => {
                const groupThreads = filteredThreads.filter(t => t.group === group);
                if (groupThreads.length === 0) return null;

                return (
                  <div key={group} className="space-y-1">
                    <div className="px-2 text-[10px] uppercase font-semibold text-slate-400 tracking-wider mb-1">
                      {group}
                    </div>

                    {groupThreads.map(thread => {
                      const isCurrent = thread.id === activeThreadId;
                      const isMenuOpen = activeMenuThreadId === thread.id;

                      return (
                        <div
                          key={thread.id}
                          className={`group relative flex items-center justify-between rounded-xl px-2.5 py-2 transition-all cursor-pointer ${isCurrent
                            ? 'bg-white border border-slate-200/90 shadow-xs text-slate-900'
                            : 'hover:bg-white/80 text-slate-600 hover:text-slate-900 border border-transparent'
                            }`}
                          onClick={() => handleSelectThread(thread.id)}
                        >
                          {/* Active Indicator Bar */}
                          {isCurrent && (
                            <div className="absolute left-0 top-2 bottom-2 w-1 bg-gradient-to-b from-violet-600 to-indigo-600 rounded-r" />
                          )}

                          {/* Thread Title & Subtitle */}
                          <div className="flex flex-col min-w-0 pr-1 pl-1 flex-1">
                            <span className={`text-xs truncate ${isCurrent ? 'font-semibold text-slate-900' : 'font-medium group-hover:text-slate-900'}`}>
                              {thread.title}
                            </span>
                            <span className="text-[11px] text-slate-400 truncate mt-0.5">
                              {thread.subtitle || 'Empty session'}
                            </span>
                          </div>

                          {/* Three-Dot Menu Action Button or Session Loading Spinner */}
                          {loadingSessionId === thread.id ? (
                            <div className="w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ml-1 text-indigo-600" title="Loading session data...">
                              <span className="material-symbols-outlined text-[17px] animate-spin">progress_activity</span>
                            </div>
                          ) : (
                            <div
                              className="relative shrink-0 ml-1"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveMenuThreadId(isMenuOpen ? null : thread.id);
                                }}
                                title="Chat options"
                                aria-label="Chat options"
                                className={`w-7 h-7 rounded-lg flex items-center justify-center transition-all hover:bg-slate-100 text-slate-400 hover:text-slate-800 ${isMenuOpen ? 'opacity-100 bg-slate-100 text-slate-800' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'
                                  }`}
                              >
                                <span className="material-symbols-outlined text-[17px]">more_vert</span>
                              </button>

                              {/* Three-dot Dropdown Menu */}
                              {isMenuOpen && (
                                <div
                                  className="absolute right-0 top-8 w-44 rounded-xl bg-white border border-slate-200 shadow-xl py-1 z-30 animate-in fade-in zoom-in-95 text-left"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  {/* Rename Action */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setActiveMenuThreadId(null);
                                      setThreadToRename(thread);
                                      setRenameTitleInput(thread.title);
                                    }}
                                    className="w-full px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2 transition-colors cursor-pointer"
                                  >
                                    <span className="material-symbols-outlined text-[16px] text-slate-400">edit</span>
                                    <span>Rename</span>
                                  </button>

                                  {/* Export Action */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setActiveMenuThreadId(null);
                                      handleExportMarkdown(thread);
                                    }}
                                    className="w-full px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2 transition-colors cursor-pointer"
                                  >
                                    <span className="material-symbols-outlined text-[16px] text-slate-400">download</span>
                                    <span>Export MD</span>
                                  </button>

                                  <div className="my-1 border-t border-slate-100" />

                                  {/* Delete Chat Action */}
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setActiveMenuThreadId(null);
                                      setThreadToDelete(thread);
                                    }}
                                    className="w-full px-3 py-1.5 text-xs text-rose-600 hover:bg-rose-50 flex items-center gap-2 transition-colors font-medium cursor-pointer"
                                  >
                                    <span className="material-symbols-outlined text-[16px] text-rose-600">delete</span>
                                    <span>Delete Chat</span>
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>

          {/* Sidebar Footer: HANA Memory Health Summary */}
          <div className="pt-2.5 mt-2 border-t border-slate-200/80 flex items-center justify-between text-[11px] text-slate-500 shrink-0">
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
              <span className="font-mono text-slate-800">Dataset sources</span>
            </div>
            <span className="font-mono text-[10px] text-slate-500 px-1.5 py-0.5 rounded bg-slate-100 border border-slate-200/80">HANA</span>
          </div>
        </div>
      </aside>

      {/* ============================================================ */}
      {/* 2. MAIN CHAT APPLICATION CONTAINER (Full Width, Never Shrinks) */}
      {/* ============================================================ */}
      <div className="flex-1 w-full flex flex-col h-full min-w-0 bg-[var(--color-surface)] overflow-hidden">
        {/* ============================================================ */}
        {/* CHAT HEADER: Persistent, Stable Top Control Bar */}
        {/* ============================================================ */}
        <header className="rag-header h-[56px] border-b border-[var(--color-border)] px-3 sm:px-5 flex items-center justify-between bg-[var(--color-surface)]/95 backdrop-blur-md shrink-0 z-10 gap-2 sm:gap-3 w-full">
          {/* Left: Sidebar Toggle Button + Auto-truncating Active Session Title with Dots */}
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0 flex-1 overflow-hidden mr-2">
            {/* Sidebar Toggle Button */}
            <button
              type="button"
              onClick={() => setIsSidebarOpen(prev => !prev)}
              title={isSidebarOpen ? "Collapse chat history" : "Open chat history"}
              className="w-8 h-8 rounded-[var(--radius-element)] flex items-center justify-center text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-surface-hover)] transition-colors border border-[var(--color-border)] bg-[var(--color-surface)] shrink-0 shadow-[var(--shadow-2xs)] cursor-pointer active:scale-95"
              aria-label="Toggle chat history sidebar"
              aria-expanded={isSidebarOpen}
              aria-controls="rag-chat-history"
            >
              <span className="material-symbols-outlined text-[18px]">
                {isSidebarOpen ? 'left_panel_close' : 'dock_to_left'}
              </span>
            </button>

            {/* Active Thread Title & Metadata */}
            <div className="min-w-0 flex-1 overflow-hidden">
              <div className="flex items-center gap-2 min-w-0 overflow-hidden">
                <h2
                  title={activeThread?.title || 'Conversational Analytics'}
                  className="text-xs sm:text-sm text-[var(--color-text-primary)] font-semibold truncate block leading-tight min-w-0 max-w-[140px] xs:max-w-[180px] sm:max-w-xs md:max-w-md"
                >
                  {activeThread?.title || 'Conversational Analytics'}
                </h2>
                <span className="hidden sm:inline-flex items-center gap-1.5 px-2 py-0.5 rounded-[var(--radius-full)] bg-[var(--color-success-subtle)] text-[var(--color-success)] text-[10px] font-medium border border-[var(--color-success-border)] shrink-0">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse"></span>
                  <span>Dataset assistant</span>
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[10px] sm:text-[11px] text-[var(--color-text-muted)] truncate leading-tight mt-0.5 min-w-0">
                <span className="font-mono text-[var(--color-text-secondary)]">Workspace</span>
                <span aria-hidden="true" className="text-[var(--color-border-strong)]">·</span>
                <span>{messages.length} msgs</span>
                <span aria-hidden="true" className="text-[var(--color-border-strong)] hidden sm:inline">·</span>
                <span className="hidden sm:inline">{activeThread?.timestamp || 'Active'}</span>
              </div>
            </div>
          </div>

          {/* Right: Header Action Controls */}
          <div className="rag-header-actions flex items-center gap-1.5 sm:gap-2 shrink-0 ml-auto">
            {/* Export MD */}
            {activeThread && (
              <button
                onClick={() => handleExportMarkdown(activeThread)}
                title="Export thread as Markdown transcript"
                aria-label="Export thread as Markdown transcript"
                className="h-8 px-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] text-xs font-medium inline-flex items-center gap-1.5 transition-all shadow-[var(--shadow-2xs)] shrink-0 whitespace-nowrap active:scale-95 cursor-pointer"
              >
                <span className="material-symbols-outlined text-[15px] text-[var(--color-text-muted)]">download</span>
                <span className="rag-action-label">Export</span>
              </button>
            )}

            {/* Clear Context */}
            <button
              onClick={() => {
                if (activeThread) {
                  setThreads(prev =>
                    prev.map(t => (t.id === activeThread.id ? { ...t, messages: [] } : t))
                  );
                  showToast('Context cleared for this session');
                }
              }}
              title="Clear all messages in active session"
              aria-label="Clear all messages in active session"
              className="h-8 px-2.5 rounded-[var(--radius-element)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] text-xs font-medium inline-flex items-center gap-1.5 transition-all shadow-[var(--shadow-2xs)] shrink-0 whitespace-nowrap active:scale-95 cursor-pointer"
            >
              <span className="material-symbols-outlined text-[15px] text-[var(--color-text-muted)]">restart_alt</span>
              <span className="rag-action-label">Clear</span>
            </button>

            {onToggleMaximize && (
              <button
                type="button"
                onClick={onToggleMaximize}
                title={isMaximized ? "Restore window" : "Maximize chat window"}
                className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface)] hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] border border-[var(--color-border)] inline-flex items-center justify-center transition-all shadow-[var(--shadow-2xs)] shrink-0 active:scale-95 cursor-pointer"
                aria-label={isMaximized ? "Restore window" : "Maximize chat window"}
              >
                <span className="material-symbols-outlined text-[16px]">
                  {isMaximized ? 'collapse_content' : 'open_in_full'}
                </span>
              </button>
            )}

            {onClose && (
              <button
                type="button"
                onClick={onClose}
                title="Close chat"
                className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface)] hover:bg-[var(--color-danger-subtle)] text-[var(--color-text-secondary)] hover:text-[var(--color-danger)] border border-[var(--color-border)] hover:border-[var(--color-danger-border)] inline-flex items-center justify-center transition-all shadow-[var(--shadow-2xs)] shrink-0 active:scale-95 cursor-pointer"
                aria-label="Close chat"
              >
                <span className="material-symbols-outlined text-[17px]">close</span>
              </button>
            )}
          </div>
        </header>

        {/* ============================================================ */}
        {/* CHAT CONVERSATION AREA: The Primary Scrollable Region */}
        {/* ============================================================ */}
        <div className="rag-conversation flex-1 overflow-y-auto p-4 sm:p-6 lg:p-8 space-y-6 scroll-touch min-h-0 bg-[var(--color-bg-base)] relative">
          {sessionLoadError ? (
            <div role="alert" className="py-8 text-center text-xs text-[var(--color-danger)] font-medium">
              {sessionLoadError}{' '}
              <button onClick={() => void handleSelectThread(activeThreadId)} className="underline ml-1 font-semibold cursor-pointer">
                Retry
              </button>
            </div>
          ) : loadingSessionId ? (
            /* ============================================================ */
            /* Session Loading State: Visible while selected session loads  */
            /* ============================================================ */
            <div className="h-full min-h-[340px] flex flex-col items-center justify-center max-w-sm mx-auto text-center px-4 py-16 animate-in fade-in duration-150">
              <div className="w-12 h-12 rounded-[var(--radius-container)] bg-[var(--color-surface-active)] border border-[var(--color-border)] flex items-center justify-center text-[var(--color-text-primary)] shadow-[var(--shadow-2xs)] mb-4">
                <span className="material-symbols-outlined text-[24px] animate-spin text-[var(--color-text-secondary)]">
                  progress_activity
                </span>
              </div>
              <h3 className="text-sm text-[var(--color-text-primary)] font-semibold">
                Loading Conversation History...
              </h3>
              <p className="text-xs text-[var(--color-text-muted)] mt-1.5 max-w-xs leading-relaxed">
                Retrieving session messages and vector grounding records
              </p>
            </div>
          ) : messages.length === 0 ? (
            /* ============================================================ */
            /* Empty State: Modern Enterprise AI Welcome & Prompt Starters  */
            /* ============================================================ */
            <div className="rag-welcome">
              <div className="rag-welcome-emblem" aria-hidden="true"><Sparkles size={27} strokeWidth={1.65} /></div>
              <p className="rag-welcome-greeting">{getTimeGreeting()}, {displayName}</p>
              <h3 className="rag-welcome-title">What would you like<br className="rag-title-break" /> to explore?</h3>
              <p className="rag-welcome-description">Ask a question, explore a trend, or find an insight.<br />A conversation with your data starts here.</p>

              {/* Suggested prompt starter cards */}
              <div className="rag-suggestions" aria-label="Suggested questions">
                {suggestions.map((card, idx) => {
                  const Icon = suggestionIcons[card.icon] || ChartNoAxesCombined;
                  return (
                    <button key={idx} type="button" className="rag-suggestion" onClick={() => handleSuggestedPrompt(card.query)}>
                      <div className="rag-suggestion-top">
                        <span className="rag-suggestion-icon" aria-hidden="true"><Icon size={20} strokeWidth={1.7} /></span>
                        {card.badge && <span className="rag-suggestion-category">{card.badge}</span>}
                      </div>
                      <span className="rag-suggestion-title">{card.title}</span>
                      <span className="rag-suggestion-bottom"><span>{card.query}</span><ArrowRight size={17} strokeWidth={1.7} aria-hidden="true" /></span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            /* ============================================================ */
            /* Message Stream: Distinct User & Assistant Bubbles */
            /* ============================================================ */
            messages.map((msg) => {
              if (msg.sender === 'user') {
                return (
                  /* User Message Bubble (Right-aligned) */
                  <div key={msg.id} className="flex justify-end items-start gap-2.5 sm:gap-3 max-w-2xl ml-auto animate-in fade-in duration-150">
                    <div className="flex flex-col items-end">
                      <div className="flex items-center gap-2 mb-1.5 text-[11px] text-[var(--color-text-muted)]">
                        <span>{msg.userRole || `You · ${displayName}`}</span>
                        <span aria-hidden="true">·</span>
                        <span>{msg.timestamp}</span>
                      </div>
                      <div className="rag-user-bubble bg-[var(--color-text-primary)] text-[var(--color-surface)] px-4 py-2.5 rounded-[var(--radius-container)] rounded-tr-[var(--radius-inner)] shadow-[var(--shadow-2xs)] text-xs sm:text-sm leading-relaxed break-words font-normal">
                        {msg.text}
                      </div>
                    </div>
                    <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] border border-[var(--color-border)] flex items-center justify-center text-xs font-semibold shrink-0 mt-3.5 shadow-[var(--shadow-2xs)]" title={displayName}>
                      {userInitials}
                    </div>
                  </div>
                );
              }

              /* Assistant Message Bubble (Left-aligned) */
              const areDocsExpanded = expandedDocMessageId === msg.id;
              const intentInfo = resolveIntentDetails(msg.intent, msg.processing, msg.text);
              const IntentIcon = intentInfo.icon;

              return (
                <div key={msg.id} className="flex items-start gap-3 sm:gap-3.5 rag-assistant-message max-w-4xl mr-auto animate-in fade-in duration-200">
                  {/* Assistant Avatar: Subtle Astryx icon */}
                  <div className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-surface-active)] text-[var(--color-text-primary)] border border-[var(--color-border)] flex items-center justify-center shrink-0 mt-0.5 shadow-[var(--shadow-2xs)]">
                    <span className="material-symbols-outlined text-[17px]">auto_awesome</span>
                  </div>

                  <div className="flex-1 flex flex-col space-y-2 min-w-0">
                    {/* Assistant Header */}
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold text-[var(--color-text-primary)]">
                          NEOVATIC Assistant
                        </span>
                        {msg.agentMeta?.latency && msg.agentMeta.latency !== 'Streaming...' && (
                          <>
                            <span aria-hidden="true" className="text-[var(--color-border-strong)]">·</span>
                            <span className="text-[11px] text-[var(--color-text-muted)] font-mono">
                              {msg.agentMeta.latency}
                            </span>
                          </>
                        )}
                      </div>

                      {/* Grounding Confidence Score (Only shown when valid score exists) */}
                      {msg.agentMeta?.cosineSim && !['Not available', 'undefined', 'null', 'N/A'].includes(msg.agentMeta.cosineSim) && (
                        <div className="flex items-center gap-1.5 text-[11px] text-[var(--color-success)] bg-[var(--color-success-subtle)] px-2.5 py-0.5 rounded-[var(--radius-full)] border border-[var(--color-success-border)] font-medium">
                          <span className="material-symbols-outlined text-[13px] text-[var(--color-success)]">verified</span>
                          <span>Vector similarity {msg.agentMeta.cosineSim}</span>
                        </div>
                      )}
                    </div>

                    {/* Assistant Response Content Card */}
                    <div className="rag-answer bg-[var(--color-surface)] border border-[var(--color-border)] rounded-[var(--radius-container)] rounded-tl-[var(--radius-inner)] p-4 sm:p-5 text-[var(--color-text-primary)] text-xs sm:text-sm leading-relaxed shadow-[var(--shadow-2xs)] space-y-3.5">
                      {/* Step-wise Intent & Thinking Process */}
                      {msg.processing && msg.processing.length > 0 && (
                        <ThinkingProcess
                          steps={msg.processing}
                          isStreaming={msg.isStreaming}
                          intent={msg.intent}
                          latency={msg.agentMeta?.latency}
                          model={msg.agentMeta?.model}
                          similarity={msg.agentMeta?.cosineSim}
                        />
                      )}

                      {/* Live streaming token generation placeholder */}
                      {msg.isStreaming && !msg.text && (
                        <div className="flex items-center gap-2 py-2 text-xs text-[var(--color-text-muted)] font-mono">
                          <span className="w-2 h-2 rounded-full bg-[var(--color-primary)] animate-pulse" />
                          <span>Preparing your answer…</span>
                        </div>
                      )}

                      {/* Render text with Markdown formatting (tables, headers, code blocks, lists, quotes) */}
                      {msg.text && (
                        <div className="relative">
                          <MarkdownRenderer
                            content={msg.text}
                            onCodeCopy={() => showToast('Snippet copied to clipboard')}
                          />
                          {msg.isStreaming && (
                            <span className="inline-block w-1.5 h-4 ml-1 bg-[var(--color-primary)] animate-pulse align-middle" />
                          )}
                        </div>
                      )}

                      {msg.retrievalWarnings?.length ? (
                        <div role="status" className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-900">
                          {msg.retrievalWarnings.map((warning, index) => <p key={index}>{warning}</p>)}
                        </div>
                      ) : null}

                      {/* Generated Graph Image (Powered by SAP AI Core) */}
                      {msg.graph_image && (
                        <div className="rag-graph-card bg-gradient-to-br from-slate-50/90 to-indigo-50/20 rounded-xl p-3.5 sm:p-4 border border-slate-200/90 shadow-2xs space-y-2.5">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2 font-label-md text-xs font-semibold text-slate-900">
                              <span className="material-symbols-outlined text-[17px] text-violet-600">analytics</span>
                              <span>{msg.chart_type ? `${msg.chart_type.charAt(0).toUpperCase() + msg.chart_type.slice(1)} Chart` : 'Generated Analytics Visualization'}</span>
                            </div>
                            <span className="text-[10px] font-semibold uppercase tracking-wider text-violet-700 bg-violet-50 px-2 py-0.5 rounded-full border border-violet-200">
                              SAP AI Core
                            </span>
                          </div>
                          <div
                            onClick={() => setPreviewGraphModalUrl({ url: msg.graph_image!, title: msg.chart_type })}
                            className="relative group rounded-lg overflow-hidden border border-slate-200 bg-white cursor-pointer hover:border-violet-400 transition-all shadow-xs"
                          >
                            <img
                              src={msg.graph_image}
                              alt="Generated Analytics Graph"
                              className="w-full max-h-[380px] object-contain mx-auto group-hover:scale-[1.01] transition-transform duration-200"
                            />
                            <div className="absolute inset-0 bg-slate-900/0 group-hover:bg-slate-900/20 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                              <span className="px-3.5 py-1.5 rounded-full bg-white/95 text-slate-900 text-xs font-semibold shadow-md flex items-center gap-1.5 backdrop-blur-xs">
                                <span className="material-symbols-outlined text-[15px]">zoom_in</span>
                                <span>Click to Enlarge</span>
                              </span>
                            </div>
                          </div>
                        </div>
                      )}

                      {/* Key AI Insights Callout (if present and distinct) */}
                      {msg.insights && msg.insights !== msg.text && (
                        <div className="rag-insight bg-gradient-to-r from-violet-50/80 to-purple-50/80 border border-violet-200/80 rounded-xl p-3.5 space-y-1.5">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-700">
                            <span className="material-symbols-outlined text-[16px]">lightbulb</span>
                            <span>Key Model Insights</span>
                          </div>
                          <p className="text-xs text-purple-900 leading-relaxed">
                            {msg.insights}
                          </p>
                        </div>
                      )}

                      {/* Inline Analytical Chart Visualization (if present) */}
                      {msg.chartData && (
                        <div className="rag-chart-card bg-slate-50/80 rounded-xl p-3.5 sm:p-4 border border-slate-200 shadow-2xs space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-1.5 font-label-md text-xs font-semibold text-slate-900">
                              <span className="material-symbols-outlined text-[16px] text-indigo-600">bar_chart</span>
                              <span>{msg.chartData.title}</span>
                            </div>
                            <span className="text-[11px] text-slate-500 font-mono">
                              {msg.chartData.unit}
                            </span>
                          </div>

                          <div className="space-y-2.5 pt-1">
                            {msg.chartData.items.map((item, idx) => {
                              const barColors = ['bg-violet-600', 'bg-indigo-600', 'bg-teal-600', 'bg-sky-600'];
                              const chosenColor = barColors[idx % barColors.length];
                              return (
                                <div key={idx} className="space-y-1">
                                  <div className="flex items-center justify-between text-xs">
                                    <span className="text-slate-700 font-medium truncate mr-2">
                                      {item.label}
                                    </span>
                                    <span className="font-semibold text-slate-900 font-mono shrink-0">
                                      {item.displayValue}
                                    </span>
                                  </div>
                                  <div className="w-full h-2 rounded-full bg-slate-200 overflow-hidden">
                                    <div
                                      className={`h-full rounded-full ${chosenColor} transition-all duration-500`}
                                      style={{ width: `${Math.min(item.value, 100)}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Risk Factors / Variances */}
                      {msg.riskFactors && msg.riskFactors.length > 0 && (
                        <div className="bg-amber-50/70 border border-amber-200/80 rounded-xl p-3.5 space-y-2">
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-900">
                            <span className="material-symbols-outlined text-[16px] text-amber-600">warning</span>
                            <span>Identified Variance Factors</span>
                          </div>
                          <ul className="space-y-1.5 text-xs text-amber-900 pl-5 list-disc">
                            {msg.riskFactors.map((rf, idx) => (
                              <li key={idx}>
                                <strong>{rf.title}:</strong> {rf.desc}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Retrieved Documents & Grounding Accordion */}
                      {msg.retrievedDocs && msg.retrievedDocs.length > 0 && (
                        <div className="rag-source-panel pt-2 border-t border-slate-200/80">
                          <button
                            type="button"
                            aria-expanded={areDocsExpanded}
                            aria-controls={`rag-sources-${msg.id}`}
                            onClick={() =>
                              setExpandedDocMessageId(areDocsExpanded ? null : msg.id)
                            }
                            className="w-full flex items-center justify-between p-2 rounded-lg bg-slate-50 hover:bg-slate-100/80 border border-slate-200 text-xs font-medium text-slate-600 transition-colors cursor-pointer"
                          >
                            <div className="flex items-center gap-2">
                              <span className="material-symbols-outlined text-[16px] text-violet-600">source</span>
                              <span>Supporting sources ({msg.retrievedDocs.length})</span>
                            </div>
                            <span className="material-symbols-outlined text-[18px] text-slate-500">
                              {areDocsExpanded ? 'expand_less' : 'expand_more'}
                            </span>
                          </button>

                          {areDocsExpanded && (
                            <div id={`rag-sources-${msg.id}`} className="mt-2 space-y-2 animate-in fade-in slide-in-from-top-1">
                              {msg.retrievedDocs.map((doc, sourceIndex) => (
                                <div
                                  key={doc.id}
                                  className="rag-source-card p-3 rounded-xl bg-slate-50 border border-slate-200/90 space-y-1.5 text-xs"
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="font-semibold text-slate-900 font-mono text-[11px] truncate">
                                      [{sourceIndex + 1}] {doc.source}
                                    </span>
                                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                                      {doc.relevanceScore != null ? `Cosine: ${doc.relevanceScore.toFixed(3)}` : doc.retrieval === 'structured_record' ? 'Exact match' : ['fallback', 'snapshot_lexical', 'hana_vector'].includes(doc.retrieval || '') ? 'Keyword match' : 'Evidence'}
                                    </span>
                                  </div>
                                  <p className="text-slate-700 font-mono text-[11px] bg-white p-2 rounded-lg border border-slate-200 leading-relaxed break-words">
                                    {doc.snippet}
                                  </p>
                                  <div className="text-[10px] text-slate-500">
                                    Source: {doc.tableOrCollection} · {doc.timestamp}
                                  </div>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Assistant Actions Bar */}
                    <div className="rag-message-actions flex items-center gap-1.5 text-xs text-slate-500 pt-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(msg.text || '');
                          showToast('Copied answer to clipboard');
                        }}
                        className="px-2.5 py-1 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-slate-900 flex items-center gap-1 transition-colors cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[15px]">content_copy</span>
                        <span>Copy</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => onNavigate('build-your-kpi-graph-studio')}
                        className="px-2.5 py-1 rounded-lg hover:bg-indigo-50 text-indigo-600 hover:text-indigo-800 flex items-center gap-1 transition-colors cursor-pointer"
                      >
                        <span className="material-symbols-outlined text-[15px]">query_stats</span>
                        <span>Open in Studio</span>
                      </button>

                      <ApprovedPublicationAction navigate={onNavigate}/>
                    </div>
                  </div>
                </div>
              );
            })
          )}

          {/* Submitting / Retrieving State - only fallback if no streaming message in thread */}
          {isSubmitting && !messages.some(m => m.isStreaming) && (
            <div className="flex items-start gap-3.5 max-w-2xl mr-auto animate-in fade-in">
              <div className="w-8.5 h-8.5 rounded-xl bg-gradient-to-tr from-violet-600 via-indigo-600 to-sky-500 text-white flex items-center justify-center shrink-0 shadow-sm animate-pulse">
                <span className="material-symbols-outlined text-[18px]">auto_awesome</span>
              </div>
              <div className="rag-loading-state bg-gradient-to-r from-violet-50/80 to-indigo-50/70 border border-violet-200/80 rounded-2xl rounded-tl-xs p-3.5 sm:p-4 text-xs text-indigo-950 space-y-2 shadow-2xs">
                <div className="flex items-center gap-2 font-medium text-indigo-900">
                  <span className="material-symbols-outlined text-[18px] animate-spin text-indigo-600">
                    progress_activity
                  </span>
                  <span>Retrieving context from SAP HANA in-memory vector store...</span>
                </div>
                <div className="flex items-center gap-2 text-indigo-700 pl-6 text-[11px]">
                  <span>Searching relevant dataset evidence</span>
                </div>
              </div>
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* ============================================================ */}
        {/* CHAT INPUT AREA: Modern Enterprise Floating Dock (Claude 3.5 & Gemini Inspired) */}
        {/* ============================================================ */}
        <div className="rag-composer p-3 sm:pb-4 sm:px-6 bg-[var(--color-bg-base)] shrink-0 z-20">
          <div className="max-w-4xl mx-auto rounded-[var(--radius-container)] bg-[var(--color-surface)] border border-[var(--color-border)] shadow-[var(--shadow-md)] hover:border-[var(--color-border-strong)] focus-within:border-[var(--color-primary)] focus-within:ring-1 focus-within:ring-[var(--color-primary)] transition-all p-2.5 sm:p-3">
            {/* Input row */}
            <div className="flex items-center gap-2 sm:gap-3 px-1">
              <textarea
                ref={inputRef}
                rows={1}
                aria-label="Message the NEOVATIC assistant"
                title="Enter to send; Shift+Enter for a new line"
                value={inputText}
                disabled={Boolean(loadingSessionId || sessionLoadError)}
                onChange={(e) => setInputText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    handleSendMessage();
                  }
                }}
                placeholder="Ask anything about your data…"
                className="flex-1 min-w-0 bg-transparent text-xs sm:text-sm text-[var(--color-text-primary)] placeholder:text-[var(--color-text-muted)] focus:outline-none py-1"
              />

              {/* Modern Astryx Send Button */}
              <button
                type="button"
                onClick={handleSendMessage}
                disabled={isSubmitting || Boolean(loadingSessionId || sessionLoadError) || !inputText.trim()}
                aria-label="Send message"
                className="w-8 h-8 rounded-[var(--radius-element)] bg-[var(--color-primary)] hover:bg-[var(--color-primary-hover)] disabled:bg-[var(--color-surface-active)] disabled:text-[var(--color-text-muted)] text-white flex items-center justify-center transition-all disabled:opacity-60 disabled:cursor-not-allowed shrink-0 shadow-[var(--shadow-2xs)] active:scale-95 cursor-pointer"
              >
                {isSubmitting ? <LoaderCircle size={19} className="animate-spin" aria-hidden="true" /> : <ArrowUp size={19} strokeWidth={2} aria-hidden="true" />}
              </button>
            </div>

            {/* Metadata & Controls Bottom Row */}
            <div className="rag-composer-footer flex items-center justify-between pt-2 mt-1 border-t border-[var(--color-border)] px-1 text-[11px] text-[var(--color-text-muted)]">
              <div className="flex items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-[var(--color-text-secondary)] font-medium">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--color-success)] animate-pulse"></span>
                  <span className="rag-provider-label">NVIDIA NIM <span aria-hidden="true">·</span> SAP HANA Cloud</span>
                </span>
              </div>
              <div className="rag-keyboard-hint hidden sm:flex items-center gap-2 text-[var(--color-text-muted)]">
                <span>Send with</span>
                <kbd className="px-1.5 py-0.5 rounded-[var(--radius-inner)] bg-[var(--color-surface-active)] border border-[var(--color-border)] text-[10px] font-mono text-[var(--color-text-secondary)] shadow-[var(--shadow-2xs)]">Enter ↵</kbd>

              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
