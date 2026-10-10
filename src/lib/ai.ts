import { edgeHeaders, edgeUrl } from './supabase';
import type { Persona } from './types';

export interface LlmMoveResult {
  move: unknown;
  table_talk?: string;
  private_reasoning?: string;
  error?: string;
}

export async function callLlmPlayer(
  game: string,
  persona: Persona,
  visible_state: Record<string, unknown>,
  legal_moves: unknown[],
): Promise<LlmMoveResult> {
  try {
    const res = await fetch(edgeUrl('llm-player'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify({ game, persona, visible_state, legal_moves }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { move: null, error: body.error ?? `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (!data || typeof data !== 'object' || !('move' in data)) {
      return { move: null, error: 'malformed_response' };
    }
    return { move: data.move, table_talk: data.table_talk, private_reasoning: data.private_reasoning };
  } catch {
    return { move: null, error: 'network_error' };
  }
}

export interface JevResult {
  answers: Record<string, unknown> | null;
  model?: string;
  usage?: { input_tokens: number; output_tokens: number };
  latency_ms?: number;
  cost_usd?: number;
  error?: string;
}

export async function callJev(
  mode: 'player' | 'referee',
  state: Record<string, unknown>,
  questions: Record<string, unknown>,
): Promise<JevResult> {
  try {
    const res = await fetch(edgeUrl('jev'), {
      method: 'POST',
      headers: edgeHeaders(),
      body: JSON.stringify({ mode, state, questions }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { answers: null, error: body.error ?? `HTTP ${res.status}` };
    }
    const data = await res.json();
    if (!data || !('answers' in data)) {
      return { answers: null, error: 'malformed_response' };
    }
    return {
      answers: data.answers,
      model: data.model,
      usage: data.usage,
      latency_ms: data.latency_ms,
      cost_usd: data.cost_usd,
    };
  } catch {
    return { answers: null, error: 'network_error' };
  }
}
