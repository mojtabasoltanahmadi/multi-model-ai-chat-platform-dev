import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD, APP_FILTER } from '@nestjs/core';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ConversationsModule } from './conversations/conversations.module';
import { MessagesModule } from './messages/messages.module';
import { ModelsModule } from './models/models.module';
import { FilesModule } from './files/files.module';
import { UsageModule } from './usage/usage.module';
import { BillingModule } from './billing/billing.module';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';

/**
 * Modular monolith: each folder is one bounded domain.
 * Security is global-by-default: JwtAuthGuard and RolesGuard apply to every
 * route unless explicitly opened with @Public() / @Roles().
 */
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    UsersModule,
    ConversationsModule,
    FilesModule,
    MessagesModule,
    ModelsModule,
    UsageModule,
    BillingModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  configure(consumer: MiddlewareConsumer) {
    // No middleware needed for the MVP.
  }
}
