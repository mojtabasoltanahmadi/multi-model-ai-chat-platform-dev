import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { User } from './user.entity';
import { UsersService } from './users.service';
import { AdminUsersController } from './admin-users.controller';

@Module({
  imports: [TypeOrmModule.forFeature([User])],
  controllers: [AdminUsersController],
  providers: [UsersService],
  exports: [UsersService, TypeOrmModule],
})
export class UsersModule {}
