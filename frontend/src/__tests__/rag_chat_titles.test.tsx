import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { RAGChat } from '../screens/RAGChat';
import { sendChatMessageStream } from '../services/chatbotService';

vi.mock('../services/chatbotService', () => ({
  fetchChatSessions: vi.fn().mockResolvedValue([]), fetchSessionMessages: vi.fn().mockResolvedValue([]),
  deleteChatSession: vi.fn(), sendChatMessageStream: vi.fn(),
}));
vi.mock('../services/datasetService', () => ({ getDatasets: vi.fn().mockResolvedValue([]) }));
vi.mock('../services/semanticService', () => ({ getSemanticModels: vi.fn().mockResolvedValue([]) }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('uses the model title in the header instead of copying the first user message', async () => {
  render(<RAGChat isActive onNavigate={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message the NEOVATIC assistant' }), { target: { value: 'give me about PRJ-002' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('New Conversation');
  const onResult = vi.mocked(sendChatMessageStream).mock.calls[0][4];
  await act(async () => onResult({ reply: 'Project details', sources: [], session_id: 'saved-session', session_title: 'Project Portfolio Status' }));
  await waitFor(() => expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('Project Portfolio Status'));
  fireEvent.click(screen.getByRole('button', { name: 'Toggle chat history sidebar' }));
  expect(screen.getAllByText('Project Portfolio Status').length).toBeGreaterThanOrEqual(2);
});

it('keeps a neutral title when model title generation is unavailable', async () => {
  render(<RAGChat isActive onNavigate={vi.fn()} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Message the NEOVATIC assistant' }), { target: { value: 'show revenue for this year' } });
  fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  const onResult = vi.mocked(sendChatMessageStream).mock.calls[0][4];
  await act(async () => onResult({ reply: 'Revenue result', sources: [], session_id: 'saved-session', session_title: null }));
  expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('New Conversation');
});
