import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import configuration from '../config/configuration';
import { User } from '../users/user.entity';
import { Conversation } from '../conversations/conversation.entity';
import { Message } from '../messages/message.entity';
import { AiModel } from '../models/ai-model.entity';
import { File } from '../files/file.entity';
import { UsageRecord } from '../usage/usage-record.entity';
import { Plan } from '../billing/plan.entity';
import { Subscription } from '../billing/subscription.entity';
import { Payment } from '../billing/payment.entity';
import { WebhookEvent } from '../billing/webhook-event.entity';
import { AuditLog } from '../billing/audit-log.entity';
import { Theme } from '../themes/theme.entity';
import { UserPreference } from '../preferences/user-preference.entity';

/**
 * Central TypeORM setup. `synchronize` auto-creates the schema and is a
 * deliberate dev/MVP convenience (see docs); turn it off together with
 * real migrations for production.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        type: 'postgres' as const,
        host: configService.get<string>('database.host'),
        port: configService.get<number>('database.port'),
        username: configService.get<string>('database.username'),
        password: configService.get<string>('database.password'),
        database: configService.get<string>('database.name'),
        synchronize: configService.get<boolean>('database.synchronize'),
        entities: [
          User,
          Conversation,
          Message,
          AiModel,
          File,
          UsageRecord,
          Plan,
          Subscription,
          Payment,
          WebhookEvent,
          AuditLog,
          Theme,
          UserPreference,
        ],
        logging: false,
      }),
    }),
  ],
})
export class DatabaseModule {}
