import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { MessagesService, ChatStreamEvent } from './messages.service';
import { SendMessageDto } from './dto/send-message.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * Chat streaming endpoints (SSE over HTTP — kept per architecture rule).
 *
 * POST /:conversationId/messages
 *   Starts the turn and streams events while THIS connection is alive.
 *   The generation itself runs detached from the response: when the client
 *   disconnects (refresh, closed tab, network loss) the connection simply
 *   unsubscribes — the generation continues server-side and persists its
 *   progress. The client never sees "client disconnected" as an answer.
 *
 * GET /:conversationId/messages/:messageId/stream
 *   Reconnect/recovery stream for an existing assistant generation:
 *   snapshot (full content so far) → remaining deltas → terminal event.
 *   Completed messages replay as snapshot + done without invoking the AI.
 *   Orphaned generations (server restart) are honestly marked 'interrupted'.
 *
 * Event grammar (both endpoints):
 *   meta      → send only: { userMessage, assistantMessage(pending), model, replay }
 *   snapshot  → reconnect only: { assistantMessage } — full content so far
 *   delta     → { text } (append)
 *   done      → { assistantMessage } (terminal success)
 *   failed    → { assistantMessage, message } (terminal; safe message only)
 *
 * Idempotency: clientMessageId (or Idempotency-Key header) reuses the user
 * row on retry (meta.replay = true) — no duplicate user rows, and content
 * collisions are rejected pre-stream with a normal 400.
 */
@Controller('conversations')
export class MessagesController {
  constructor(private readonly messagesService: MessagesService) {}

  @Post(':conversationId/messages')
  async sendMessage(
    @CurrentUser() user: { id: string },
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: SendMessageDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    // Idempotency-Key header mirrors clientMessageId (defense-in-depth: lets
    // proxies / future replay logs correlate without parsing the body).
    const clientMessageId =
      dto.clientMessageId ??
      (typeof request.headers['idempotency-key'] === 'string'
        ? request.headers['idempotency-key']
        : undefined);

    // Validate ownership, model availability, and idempotency BEFORE opening
    // the SSE stream, so these errors reach the client as normal JSON errors.
    await this.messagesService.assertChatTurnAllowed(user.id, conversationId, dto.modelId, {
      clientMessageId,
      content: dto.content.trim(),
    });

    // Nest defaults POST to 201; an SSE stream is a normal 200 response.
    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();

    const turn = await this.messagesService.beginChatTurn(
      user.id,
      conversationId,
      dto.content.trim(),
      dto.modelId,
      clientMessageId,
    );

    // Disconnect signal: 'close' fires on both premature disconnects and our
    // own normal end; the race just settles early in the normal case.
    const disconnected = new Promise<void>((resolve) => {
      response.once('close', resolve);
    });

    const pump = (async () => {
      for await (const event of turn.events) {
        if (response.writableEnded || response.destroyed) return;
        if (event.type === 'meta') {
          this.writeEvent(response, 'meta', {
            userMessage: this.serializeMessage(event.userMessage),
            assistantMessage: this.serializeMessage(event.assistantMessage),
            model: { id: event.model.id, name: event.model.name, provider: event.model.provider },
            replay: event.replay,
          });
        } else if (event.type === 'delta') {
          this.writeEvent(response, 'delta', { text: event.text });
        } else if (event.type === 'done') {
          this.writeEvent(response, 'done', {
            assistantMessage: this.serializeMessage(event.assistantMessage),
          });
          return;
        } else if (event.type === 'failed') {
          this.writeEvent(response, 'failed', {
            assistantMessage: this.serializeMessage(event.assistantMessage),
            message: event.clientMessage,
          });
          return;
        }
      }
    })();

    // Hold the response open until the generation completes or the client
    // leaves. If the client leaves first: stop pumping (unsubscribe) and end
    // the response — the generation keeps running server-side.
    await Promise.race([pump, disconnected]);
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
  }

  @Get(':conversationId/messages/:messageId/stream')
  async reconnectStream(
    @CurrentUser() user: { id: string },
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Param('messageId', ParseUUIDPipe) messageId: string,
    @Req() _request: Request,
    @Res() response: Response,
  ): Promise<void> {
    // Ownership/existence errors surface as normal JSON before SSE starts.
    await this.messagesService.assertReconnectAllowed(user.id, conversationId, messageId);

    response.status(HttpStatus.OK);
    response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    response.setHeader('Cache-Control', 'no-cache');
    response.setHeader('Connection', 'keep-alive');
    response.setHeader('X-Accel-Buffering', 'no');
    response.flushHeaders?.();

    const disconnected = new Promise<void>((resolve) => {
      response.once('close', resolve);
    });

    const pump = (async () => {
      // beginChatTurn-style pre-flight errors (404/ownership) must surface as
      // JSON, not SSE — validate before flushing… but headers are already
      // flushed for SSE symmetry; instead the generator throws before its
      // first event, so capture that and emit a terminal `failed` event (the
      // response is already committed at this point).
      try {
        for await (const event of this.messagesService.reconnectGeneration(
          user.id,
          conversationId,
          messageId,
        )) {
          if (response.writableEnded || response.destroyed) return;
          if (event.type === 'snapshot') {
            this.writeEvent(response, 'snapshot', {
              assistantMessage: this.serializeMessage(event.assistantMessage),
            });
          } else if (event.type === 'delta') {
            this.writeEvent(response, 'delta', { text: event.text });
          } else if (event.type === 'done') {
            this.writeEvent(response, 'done', {
              assistantMessage: this.serializeMessage(event.assistantMessage),
            });
            return;
          } else if (event.type === 'failed') {
            this.writeEvent(response, 'failed', {
              assistantMessage: this.serializeMessage(event.assistantMessage),
              message: event.clientMessage,
            });
            return;
          }
        }
      } catch {
        // Ownership/not-found while the SSE headers are already sent: the
        // client treats a closed stream without a terminal as "nothing to
        // recover" and re-fetches the conversation via GET (JSON errors are
        // available on the normal endpoints).
        this.writeEvent(response, 'failed', {
          assistantMessage: null,
          message: 'پیام قابل بازیابی نیست.',
        });
      }
    })();

    await Promise.race([pump, disconnected]);
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
  }

  private writeEvent(response: Response, event: string, data: unknown) {
    if (response.destroyed || response.writableEnded) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private serializeMessage(message: {
    id: string;
    conversationId: string;
    role: string;
    content: string;
    status: string | null;
    errorMessage: string | null;
    modelId: string | null;
    clientMessageId: string | null;
    createdAt: Date;
  }) {
    return {
      id: message.id,
      conversationId: message.conversationId,
      role: message.role,
      content: message.content,
      status: message.status,
      errorMessage: message.errorMessage,
      // Per-turn model attribution: the client can show which model produced
      // each assistant response, including after a mid-conversation switch.
      modelId: message.modelId,
      // Idempotency token echoed back; frontend can correlate retries with
      // the original user intent and link Retry buttons to the right turn.
      clientMessageId: message.clientMessageId,
      createdAt: message.createdAt,
    };
  }
}

export type { ChatStreamEvent };
