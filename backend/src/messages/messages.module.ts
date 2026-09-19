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
import { WebsearchModule } from '../websearch/websearch.module';
import { UsersModule } from '../users/users.module';
import { UsageModule } from '../usage/usage.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Message]),
    ConversationsModule,
    ModelsModule,
    AiModule,
    // Attached-file context: only READY files of the same conversation are
    // ever resolved (FilesService enforces both conditions).
    FilesModule,
    // Opt-in web search behind the provider abstraction (Serper for MVP).
    WebsearchModule,
    // Plan reads (users) + quota gate and usage lifecycle (usage).
    UsersModule,
    UsageModule,
    // Subscription/entitlement resolution for the pre-flight gate (INV-05/06).
    BillingModule,
  ],
  controllers: [MessagesController],
  providers: [MessagesService, GenerationRegistry],
})
export class MessagesModule {}
