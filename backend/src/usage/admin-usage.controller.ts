import { Controller, Get, Query } from '@nestjs/common';
import { UsageService } from './usage.service';
import { Roles } from '../common/decorators/roles.decorator';

/**
 * Admin consumption & cost overview (day-7-8 contract §16, now required):
 * totals + per-day trend + per-model split + per-user consumption.
 * Cost reporting includes failed turns (they consumed real tokens); the
 * failed-outcome exclusion applies only to quota counting.
 */
@Roles('admin')
@Controller('admin/usage')
export class AdminUsageController {
  constructor(private readonly usageService: UsageService) {}

  @Get('summary')
  summary(@Query('days') days?: string) {
    const parsed = parseInt(days ?? '7', 10);
    const clamped = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 90) : 7;
    return this.usageService.adminSummary(clamped);
  }
}
