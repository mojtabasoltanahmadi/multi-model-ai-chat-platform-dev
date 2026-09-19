import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Message } from './message.entity';
import { MessagesService } from './messages.service';
import { GenerationRegistry } from './generation.registry';
import { MessagesController } from './messages.controller';
import { ConversationsModule } from '../conversations/conversations.module';
import { ModelsModule } from '../models/models.module';
import { AiModule } from '../ai/ai.module';
import { FilesModule } from '../files/files.module';
import { UsersModule } from '../users/users.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message]),
    ConversationsModule,
    ModelsModule,
    AiModule,
    // Attached-file context: only READY files of the same conversation are
    // ever resolved (FilesService enforces both conditions).
    FilesModule,
    // Plan reads (users) + quota gate and usage lifecycle (usage).
    UsersModule,
    UsageModule,
  ],
  controllers: [MessagesController],
  providers: [MessagesService, GenerationRegistry],
})
export class MessagesModule {}
