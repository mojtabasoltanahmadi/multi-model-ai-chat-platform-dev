import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import { ConversationsService } from './conversations.service';
import { CreateConversationDto } from './dto/create-conversation.dto';
import { SetConversationModelDto } from './dto/set-conversation-model.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('conversations')
export class ConversationsController {
  constructor(private readonly conversationsService: ConversationsService) {}

  @Get()
  list(@CurrentUser() user: { id: string }) {
    return this.conversationsService.listForUser(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateConversationDto,
  ) {
    return this.conversationsService.create(user.id, dto ?? {});
  }

  @Get(':conversationId')
  async getOne(
    @CurrentUser() user: { id: string },
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
  ) {
    return this.conversationsService.getOwnedWithMessages(user.id, conversationId);
  }

  /**
   * Persists the conversation's explicitly selected model (null clears it —
   * the conversation then follows the system default). This is the value a
   * refresh reads back, so the user's choice survives reloads and switches.
   */
  @Patch(':conversationId/model')
  setModel(
    @CurrentUser() user: { id: string; role: 'user' | 'admin' },
    @Param('conversationId', ParseUUIDPipe) conversationId: string,
    @Body() dto: SetConversationModelDto,
  ) {
    return this.conversationsService.setModel(
      user.id,
      conversationId,
      dto?.modelId,
      user.role === 'admin',
    );
  }
}
