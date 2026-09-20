import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Conversation } from './conversation.entity';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { Message } from '../messages/message.entity';
import { ModelsService } from '../models/models.service';
import { EntitlementsService } from '../billing/entitlements.service';

@Injectable()
export class ConversationsService {
  constructor(
    @InjectRepository(Conversation)
    private readonly conversationsRepository: Repository<Conversation>,
    private readonly modelsService: ModelsService,
    private readonly entitlementsService: EntitlementsService,
  ) {}

  listForUser(userId: string): Promise<Conversation[]> {
    return this.conversationsRepository.find({
      where: { userId },
      order: { updatedAt: 'DESC' },
    });
  }

  create(userId: string, dto: CreateConversationDto): Promise<Conversation> {
    const conversation = this.conversationsRepository.create({
      userId,
      title: dto.title?.trim() || 'گفتگوی جدید',
    });
    return this.conversationsRepository.save(conversation);
  }

  /**
   * Returns a conversation only if it belongs to the given user.
   * Ownership is part of the lookup, never a post-check.
   */
  async getOwned(userId: string, conversationId: string): Promise<Conversation> {
    const conversation = await this.conversationsRepository.findOne({
      where: { id: conversationId, userId },
    });
    if (!conversation) {
      throw new NotFoundException('گفتگو پیدا نشد.');
    }
    return conversation;
  }

  /** Conversation with its messages, owned by the given user. */
  async getOwnedWithMessages(userId: string, conversationId: string) {
    const conversation = await this.getOwned(userId, conversationId);
    const messages = await this.conversationsRepository.manager
      .getRepository(Message)
      .find({
        where: { conversationId: conversation.id },
        order: { createdAt: 'ASC' },
      });
    return { conversation, messages };
  }

  async renameTitle(conversation: Conversation, title: string): Promise<void> {
    await this.conversationsRepository.update(conversation.id, {
      title: title.slice(0, 200),
    });
  }

  /**
   * Persists (or clears) the conversation's explicitly selected model — the
   * value a refreshed client restores instead of falling back to the default.
   * A concrete model must pass the EXACT checks a chat send would enforce
   * (resolveChatModel + plan allowlist + thinking gate, mirroring
   * assertChatTurnAllowed): a selection that would fail the next send can
   * never be persisted. `null` clears the explicit selection so the
   * conversation follows the system default again; a missing key is a client
   * bug and is rejected. The default itself is never written here — only an
   * explicit user choice lands in this column.
   */
  async setModel(
    userId: string,
    conversationId: string,
    modelId: string | null | undefined,
    isAdmin = false,
  ): Promise<Conversation> {
    if (modelId === undefined) {
      throw new BadRequestException('شناسه مدل الزامی است.');
    }
    const conversation = await this.getOwned(userId, conversationId);

    if (modelId !== null) {
      const entitlements = await this.entitlementsService.resolveForUser(userId);
      const model = await this.modelsService.resolveChatModel(modelId, entitlements.tier);
      if (
        entitlements.allowedModelIds !== null &&
        !entitlements.allowedModelIds.includes(model.id)
      ) {
        throw new ForbiddenException('این مدل در طرح فعلی شما مجاز نیست.');
      }
      if (!isAdmin && model.capabilities.includes('reasoning') && !entitlements.features.thinking) {
        throw new ForbiddenException('قابلیت تفکر عمیق در طرح فعلی شما فعال نیست.');
      }
    }

    conversation.modelId = modelId;
    return this.conversationsRepository.save(conversation);
  }
}
