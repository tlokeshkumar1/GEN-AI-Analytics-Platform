import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { agentActivityStore } from '../services/agentActivityStore';
import { clearLocalIdentity, SIGNED_OUT_KEY } from '../services/authNavigation';
import { getDatasetAgentActivity } from '../services/datasetService';

vi.mock('../services/datasetService', () => ({ getDatasetAgentActivity: vi.fn() }));

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  agentActivityStore.clear();
});
afterEach(() => {
  agentActivityStore.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('clears stored history, running records and the open cockpit on logout', () => {
  const activity = agentActivityStore.startIngestion('Projects.xlsx');
  agentActivityStore.openModal(activity.id);
  localStorage.setItem('unrelated_preference', 'keep');
  const changed = vi.fn();
  const unsubscribe = agentActivityStore.subscribe(changed);
  clearLocalIdentity(true);
  expect(localStorage.getItem('neovatic_agent_activity_records')).toBeNull();
  expect(agentActivityStore.getActivities()).toEqual([]);
  expect(agentActivityStore.getActiveActivity()).toBeUndefined();
  expect(agentActivityStore.isAnyProcessing()).toBe(false);
  expect(agentActivityStore.isModalOpen()).toBe(false);
  expect(changed).toHaveBeenCalled();
  expect(localStorage.getItem('unrelated_preference')).toBe('keep');
  unsubscribe();
});

it('cancels pending persistence and ignores late updates after logout', () => {
  vi.useFakeTimers();
  const activity = agentActivityStore.startIngestion('Projects.xlsx');
  agentActivityStore.updateProgress(activity.id, 1, 'running', 'Processing');
  clearLocalIdentity(true);
  agentActivityStore.updateProgress(activity.id, 2, 'completed', 'Late update');
  vi.runAllTimers();
  expect(agentActivityStore.getActivities()).toEqual([]);
  expect(localStorage.getItem('neovatic_agent_activity_records')).toBeNull();
});

it('does not restore an in-flight dataset activity response after logout', async () => {
  const activity = agentActivityStore.startIngestion('Projects.xlsx', 'projects');
  let resolve!: (value: typeof activity) => void;
  vi.mocked(getDatasetAgentActivity).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  const pending = agentActivityStore.loadDatasetActivity('projects');
  clearLocalIdentity(true);
  resolve(activity);
  await pending;
  expect(agentActivityStore.getActivities()).toEqual([]);
  expect(localStorage.getItem('neovatic_agent_activity_records')).toBeNull();
});

it('clears the current tab when another tab logs out', () => {
  agentActivityStore.startIngestion('Projects.xlsx');
  window.dispatchEvent(new StorageEvent('storage', { key: SIGNED_OUT_KEY, newValue: 'true' }));
  expect(agentActivityStore.getActivities()).toEqual([]);
  expect(localStorage.getItem('neovatic_agent_activity_records')).toBeNull();
});

it('keeps upload history when clearing an expired identity without signing out', () => {
  agentActivityStore.startIngestion('Projects.xlsx');
  clearLocalIdentity(false);
  expect(agentActivityStore.getActivities()).toHaveLength(1);
});
