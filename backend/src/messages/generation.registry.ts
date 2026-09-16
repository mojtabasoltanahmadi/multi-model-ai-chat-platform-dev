import { Injectable } from '@nestjs/common';
import type { Message } from './message.entity';

/**
 * Events fanned out to every subscriber of a live generation.
 *  - delta: one new text chunk (subscriber received it AFTER subscribing,
 *           so it has not been included in any snapshot the subscriber got)
 *  - done:  generation finished; `message` is the final persisted row
 *  - failed: generation failed; `message` is the persisted row (status
 *           'failed'), `clientMessage` is the safe user-facing text
 */
export type GenerationEvent =
  | { type: 'delta'; text: string }
  | { type: 'done'; message: Message }
  | { type: 'failed'; message: Message; clientMessage: string };

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
    { subscribers: Set<GenerationSubscriber>; content: string }
  >();

  register(messageId: string): void {
    this.generations.set(messageId, { subscribers: new Set(), content: '' });
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

  unregister(messageId: string): void {
    this.generations.delete(messageId);
  }
}
