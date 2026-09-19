import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PlansService } from './plans.service';
import { PaymentsService } from './payments.service';
import { Payment } from './payment.entity';
import { SubscriptionsService } from './subscriptions.service';
import { AuditService } from './audit.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';

interface AuthUser {
  id: string;
  email: string;
  role: string;
}

/** Admin plan/payment/subscription/audit management. */
@Roles('admin')
@Controller('admin/billing')
export class AdminBillingController {
  constructor(
    private readonly plansService: PlansService,
    private readonly paymentsService: PaymentsService,
    private readonly subscriptionsService: SubscriptionsService,
    private readonly auditService: AuditService,
  ) {}

  // ---- Plans ----

  @Get('plans')
  listPlans() {
    return this.plansService.listAll();
  }

  @Post('plans')
  createPlan(@CurrentUser() user: AuthUser, @Body() dto: CreatePlanDto) {
    return this.plansService.create(dto, user.id, user.email);
  }

  @Patch('plans/:planId')
  updatePlan(
    @CurrentUser() user: AuthUser,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: UpdatePlanDto,
  ) {
    return this.plansService.update(planId, dto, user.id, user.email);
  }

  @Post('plans/:planId/activate')
  activatePlan(
    @CurrentUser() user: AuthUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.plansService.setActive(planId, true, user.id, user.email);
  }

  @Post('plans/:planId/deactivate')
  deactivatePlan(
    @CurrentUser() user: AuthUser,
    @Param('planId', ParseUUIDPipe) planId: string,
  ) {
    return this.plansService.setActive(planId, false, user.id, user.email);
  }

  // ---- Payments ----

  @Get('payments')
  listPayments(
    @Query('userId') userId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<Payment[]> {
    // Full rows (incl. userId + planSnapshot) — admin view needs them; the
    // user-facing controller is where the trimmed shape applies.
    return this.paymentsService.listAll({
      userId: userId || undefined,
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  // ---- Subscriptions ----

  @Get('subscriptions')
  listSubscriptions(
    @Query('userId') userId?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ) {
    return this.subscriptionsService.listAll({
      userId: userId || undefined,
      status: status || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  // ---- Audit ----

  @Get('audit')
  listAudit(
    @Query('eventType') eventType?: string,
    @Query('userId') userId?: string,
    @Query('limit') limit?: string,
  ) {
    return this.auditService.list({
      eventType: eventType || undefined,
      userId: userId || undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
