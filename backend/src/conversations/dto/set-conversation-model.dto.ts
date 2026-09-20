import { IsOptional, IsUUID } from 'class-validator';

/**
 * Body of PATCH /conversations/:conversationId/model.
 *  - `modelId: "<uuid>"` persists the conversation's explicitly selected model.
 *  - `modelId: null` clears it — the conversation follows the system default
 *    again (the same rule as a conversation that never picked a model).
 * A body WITHOUT the key (`undefined`) states no intent and is rejected by
 * the service — the dedicated endpoint must never guess.
 */
export class SetConversationModelDto {
  @IsOptional()
  @IsUUID('4', { message: 'شناسه مدل نامعتبر است.' })
  modelId?: string | null;
}
