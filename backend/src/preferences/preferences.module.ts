import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserPreference } from './user-preference.entity';
import { PreferencesService } from './preferences.service';
import { PreferencesController } from './preferences.controller';
import { ThemesModule } from '../themes/themes.module';

@Module({
  imports: [TypeOrmModule.forFeature([UserPreference]), ThemesModule],
  controllers: [PreferencesController],
  providers: [PreferencesService],
})
export class PreferencesModule {}
