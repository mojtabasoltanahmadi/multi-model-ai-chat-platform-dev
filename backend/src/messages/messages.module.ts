import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from './message.entity';
import { MessagesService } from './messages.service';
import { GenerationRegistry } from './generation.registry';
import { MessagesController } from './messages.controller';
import { ConversationsModule } from '../conversations/conversations.module';
import { ModelsModule } from '../models/models.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message]),
    ConversationsModule,
    ModelsModule,
    AiModule,
  ],
  controllers: [MessagesController],
  providers: [MessagesService, GenerationRegistry],
})
export class MessagesModule {}
