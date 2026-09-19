import { Controller, Get } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { ThemesService } from './themes.service';

/**
 * Public theme availability. Pre-login pages (login/register) also theme
 * themselves, so this endpoint must be reachable without a token; it only
 * ever exposes enabled themes and their display metadata.
 */
@Public()
@Controller('themes')
export class ThemesController {
  constructor(private readonly themesService: ThemesService) {}

  @Get('available')
  available() {
    return this.themesService.listAvailable();
  }
}
