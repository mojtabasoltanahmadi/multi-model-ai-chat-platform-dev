import { Injectable } from '@nestjs/common';
import type { Message } from './message.entity';
import type { MessageSource } from '../websearch/websearch.types';

/**
 * Execution phases streamed to clients (day-7-8 contract §10/§11) — safe
 * status labels about the system's own work, never model output and never
 * chain-of-thought. Closed set.
 */
export type GenerationStatus = 'thinking' | 'generating';

/**
 * Events fanned out to every subscriber of a live generation.
 *  - delta: one new text chunk (subscriber received it AFTER subscribing,
 *           so it has not been included in any snapshot the subscriber got)
 *  - status: execution phase (`thinking` before the first token, `generating`
 *           at the first delta; `detail: 'fallback'` marks the single-hop
 *           provider switch). Ephemeral — never persisted or replayed.
 *  - search_started:   the turn's opt-in web search began (transient)
 *  - search_completed: the search finished; `resultCount` hits were kept,
 *           `warning` carries the safe degrade notice (null on success)
 *  - sources: the turn's web-search citations, streamed once right after the
 *           search persisted them (data event — also forwarded on reconnect;
 *           clients replace their copy)
 *  - done:  generation finished; `message` is the final persisted row
 *  - failed: generation failed; `message` is the persisted row (status
 *           'failed'), `clientMessage` is the safe user-facing text
 *  - cancelled: generation was stopped by the user; `message` is the
 *           persisted row (status 'interrupted', partial content kept)
 */
export type GenerationEvent =
  | { type: 'delta'; text: string }
  | { type: 'status'; status: GenerationStatus; detail?: string }
  | { type: 'search_started' }
  | { type: 'search_completed'; resultCount: number; warning: string | null }
  | { type: 'sources'; sources: MessageSource[] }
  | { type: 'done'; message: Message }
  | { type: 'failed'; message: Message; clientMessage: string }
  | { type: 'cancelled'; message: Message };

export type GenerationSubscriber = (event: GenerationEvent) => void;

/**
 * In-memory registry of generations that are currently running in this
 * process. It decouples the AI generation loop from the HTTP response that
 * started it:
 *
 *   - the response subscribes while connected and unsubscribes when the
 *     client leaves — the generation itself keeps running and persisting;
 *   - a reconnecting client subscribes again and receives a snapshot of
 *     everything accumulated so far, then only the remaining deltas;
 *   - when the process dies, the registry dies with it — such rows are
 *     honestly marked 'interrupted' on reconnect (no fake resume).
 *
 * Deliberately NOT persisted and NOT shared across processes: the database
 * holds the durable state; this registry only tracks what is live right now.
 */
@Injectable()
export class GenerationRegistry {
  private readonly generations = new Map<
    string,
    {
      subscribers: Set<GenerationSubscriber>;
      content: string;
      /** Aborted by `requestCancel` to stop the underlying provider stream. */
      controller: AbortController;
      /** Settles with the final persisted row when the loop finishes. */
      completion: Promise<Message> | null;
    }
  >();

  register(messageId: string, completion?: Promise<Message>): void {
    this.generations.set(messageId, {
      subscribers: new Set(),
      content: '',
      controller: new AbortController(),
      completion: completion ?? null,
    });
  }

  /**
   * The generation's completion promise (resolves with the final persisted
   * row, never rejects) — lets the Stop endpoint await the deterministic
   * terminal state instead of returning before the loop finished.
   */
  completion(messageId: string): Promise<Message> | undefined {
    return this.generations.get(messageId)?.completion ?? undefined;
  }

  /** The generation's cancellation signal (aborted when the user stops it). */
  cancelSignal(messageId: string): AbortSignal | undefined {
    return this.generations.get(messageId)?.controller.signal;
  }

  /**
   * User-initiated stop: aborts the generation's cancellation signal so the
   * loop stops consuming the provider stream and persists the partial row.
   * Idempotent — aborting twice is a no-op; `false` when nothing is live.
   */
  requestCancel(messageId: string): boolean {
    const generation = this.generations.get(messageId);
    if (!generation) return false;
    generation.controller.abort();
    return true;
  }

  isLive(messageId: string): boolean {
    return this.generations.has(messageId);
  }

  /** Content accumulated so far (authoritative for reconnect snapshots). */
  getContent(messageId: string): string | undefined {
    return this.generations.get(messageId)?.content;
  }

  subscribe(messageId: string, subscriber: GenerationSubscriber): () => void {
    const generation = this.generations.get(messageId);
    if (!generation) return () => undefined;
    generation.subscribers.add(subscriber);
    return () => generation.subscribers.delete(subscriber);
  }

  /** Transient execution-phase narration (thinking/generating/fallback). */
  publishStatus(messageId: string, status: GenerationStatus, detail?: string): void {
    const generation = this.generations.get(messageId);
    if (!generation) return;
    for (const subscriber of generation.subscribers) {
      subscriber({ type: 'status', status, detail });
    }
  }

  /** Transient web-search lifecycle for subscribers of the initial send. */
  publishSearchStarted(messageId: string): void {
    const generation = this.generations.get(messageId);
    if (!generation) return;
    for (const subscriber of generation.subscribers) {
      subscriber({ type: 'search_started' });
    }
  }

  publishSearchCompleted(messageId: string, resultCount: number, warning: string | null): void {
    const generation = this.generations.get(messageId);
    if (!generation) return;
    for (const subscriber of generation.subscribers) {
      subscriber({ type: 'search_completed', resultCount, warning });
    }
  }

  /** Streams the turn's citations once, right after they were persisted. */
  publishSources(messageId: string, sources: MessageSource[]): void {
    const generation = this.generations.get(messageId);
    if (!generation) return;
    for (const subscriber of generation.subscribers) {
      subscriber({ type: 'sources', sources });
    }
  }

  /** Fans a delta out to subscribers and appends it to the snapshot buffer. */
  publishDelta(messageId: string, text: string): void {
    const generation = this.generations.get(messageId);
    if (!generation) return;
    generation.content += text;
    for (const subscriber of generation.subscribers) {
      subscriber({ type: 'delta', text });
    }
  }

  publishDone(messageId: string, message: Message): void {
    const generation = this.generations.get(messageId);
    if (!generation) return;
    for (const subscriber of generation.subscribers) {
      subscriber({ type: 'done', message });
    }
  }

  publishFailed(messageId: string, message: Message, clientMessage: string): void {
    const generation = this.generations.get(messageId);
    if (!generation) return;
    for (const subscriber of generation.subscribers) {
      subscriber({ type: 'failed', message, clientMessage });
    }
  }

  /** Terminal event for a user-stopped generation (row status 'interrupted'). */
  publishCancelled(messageId: string, message: Message): void {
    const generation = this.generations.get(messageId);
    if (!generation) return;
    for (const subscriber of generation.subscribers) {
      subscriber({ type: 'cancelled', message });
    }
  }

  unregister(messageId: string): void {
    this.generations.delete(messageId);
  }
}
