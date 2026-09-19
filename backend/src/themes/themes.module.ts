import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Theme } from './theme.entity';
import { ThemesService } from './themes.service';
import { ThemesController } from './themes.controller';
import { AdminThemesController } from './admin-themes.controller';

@Module({
  imports: [TypeOrmModule.forFeature([Theme])],
  controllers: [ThemesController, AdminThemesController],
  providers: [ThemesService],
  exports: [ThemesService],
})
export class ThemesModule {}
