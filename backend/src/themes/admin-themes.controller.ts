import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { Roles } from '../common/decorators/roles.decorator';
import { ThemesService } from './themes.service';
import { UpdateThemeDto } from './dto/update-theme.dto';
import { UpdateThemeStatusDto } from './dto/update-theme-status.dto';
import { ReorderThemesDto } from './dto/reorder-themes.dto';

/**
 * Admin theme management. Theme ids are stable registry keys (not UUIDs), so
 * they are validated in the service (unknown → 404) instead of ParseUUIDPipe.
 */
@Roles('admin')
@Controller('admin/themes')
export class AdminThemesController {
  constructor(private readonly themesService: ThemesService) {}

  @Get()
  list() {
    return this.themesService.listAll();
  }

  @Patch(':themeId')
  update(@Param('themeId') themeId: string, @Body() dto: UpdateThemeDto) {
    return this.themesService.update(themeId, dto);
  }

  @Patch(':themeId/status')
  updateStatus(
    @Param('themeId') themeId: string,
    @Body() dto: UpdateThemeStatusDto,
  ) {
    return this.themesService.updateStatus(themeId, dto.enabled);
  }

  @HttpCode(HttpStatus.OK)
  @Post(':themeId/default')
  setDefault(@Param('themeId') themeId: string) {
    return this.themesService.setDefault(themeId);
  }

  @HttpCode(HttpStatus.OK)
  @Post('reorder')
  reorder(@Body() dto: ReorderThemesDto) {
    return this.themesService.reorder(dto);
  }
}
