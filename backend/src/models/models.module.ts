import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AiModel } from './ai-model.entity';
import { ModelsService } from './models.service';
import { ModelsController } from './models.controller';
import { AdminModelsController } from './admin-models.controller';
import { BillingModule } from '../billing/billing.module';

@Module({
  imports: [TypeOrmModule.forFeature([AiModel]), BillingModule],
  controllers: [ModelsController, AdminModelsController],
  providers: [ModelsService],
  exports: [ModelsService],
})
export class ModelsModule {}
