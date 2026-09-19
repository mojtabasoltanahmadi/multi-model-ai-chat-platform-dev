import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { Roles } from '../common/decorators/roles.decorator';
import { UpdatePlanDto } from './dto/update-plan.dto';

/**
 * Admin user management (day-7-8 contract §16): list users and change plans.
 * Plan changes take effect on the affected user's NEXT request — the plan is
 * re-read from the DB per send, never from the JWT.
 */
@Roles('admin')
@Controller('admin/users')
export class AdminUsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  list() {
    return this.usersService.listAll();
  }

  @Patch(':userId/plan')
  setPlan(@Param('userId', ParseUUIDPipe) userId: string, @Body() dto: UpdatePlanDto) {
    return this.usersService.setPlan(userId, dto.plan);
  }
}
