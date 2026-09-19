import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageRecord } from './usage-record.entity';
import { UsageService } from './usage.service';
import { QuotaService } from './quota.service';
import { UsageController } from './usage.controller';
import { AdminUsageController } from './admin-usage.controller';
import { UsersModule } from '../users/users.module';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [TypeOrmModule.forFeature([UsageRecord]), UsersModule, BillingModule],
  controllers: [UsageController, AdminUsageController],
  providers: [UsageService, QuotaService],
  exports: [UsageService, QuotaService],
})
export class UsageModule {}
