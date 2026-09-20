import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Conversation } from './conversation.entity';
import { ConversationsService } from './conversations.service';
import { ConversationsController } from './conversations.controller';
import { ModelsModule } from '../models/models.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  // Models/Billing back the model-selection endpoint: a persisted selection
  // is validated through the same chokepoint (resolveChatModel +
  // entitlements) a chat send uses.
  imports: [TypeOrmModule.forFeature([Conversation]), ModelsModule, BillingModule],
  controllers: [ConversationsController],
  providers: [ConversationsService],
  exports: [ConversationsService],
})
export class ConversationsModule {}
