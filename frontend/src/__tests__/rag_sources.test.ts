import { expect, it } from 'vitest';
import { toRetrievedDocument } from '../screens/RAGChat';
import { resolveIntentDetails } from '../components/ThinkingProcess';

it('labels actual VECTOR_TABLE evidence with its true cosine score', () => {
  const source = toRetrievedDocument({ ID: 'v1', TEXT_CHUNK: 'PRJ-002 milestone', SCORE: .341,
    METADATA: JSON.stringify({ source: 'Milestones', source_table: 'VECTOR_TABLE', retrieval: 'hana_vector', score_type: 'cosine' }) }, 0);
  expect(source.tableOrCollection).toBe('VECTOR_TABLE');
  expect(source.relevanceScore).toBe(.341);
  expect(source.timestamp).toBe('HANA vector search');
});

it('never calls a structured exact match or snapshot keyword score cosine similarity', () => {
  const record = toRetrievedDocument({ SCORE: 1, METADATA: { source: 'Projects', source_table: 'PROJECTS', retrieval: 'structured_record' } }, 0);
  expect(record.relevanceScore).toBeNull();
  expect(record.timestamp).toBe('Exact record match');
  const fallback = toRetrievedDocument({ SCORE: 4, METADATA: { source: 'Projects', retrieval: 'snapshot_lexical', score_type: 'lexical' } }, 1);
  expect(fallback.relevanceScore).toBeNull();
  expect(fallback.timestamp).toBe('Snapshot keyword match');
});

it('shows hybrid retrieval independently of words in the answer', () => {
  expect(resolveIntentDetails('hybrid_record', [], 'S/4HANA project details').label).toBe('Hybrid Retrieval');
  expect(resolveIntentDetails('exact_record', [], 'Retrieved record').label).toBe('Record Lookup');
});
