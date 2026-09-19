import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UsageRecord } from './usage-record.entity';
import { UsageService } from './usage.service';
import { QuotaService } from './quota.service';
import { UsageController } from './usage.controller';
import { AdminUsageController } from './admin-usage.controller';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [TypeOrmModule.forFeature([UsageRecord]), UsersModule],
  controllers: [UsageController, AdminUsageController],
  providers: [UsageService, QuotaService],
  exports: [UsageService, QuotaService],
})
export class UsageModule {}
