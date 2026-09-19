import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserPlan } from './user.entity';

/** Shape returned by the admin user list — never includes secrets. */
export type AdminUser = Pick<User, 'id' | 'email' | 'role' | 'plan' | 'createdAt'>;

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  findByEmail(email: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { email } });
  }

  findById(id: string): Promise<User | null> {
    return this.usersRepository.findOne({ where: { id } });
  }

  async create(email: string, passwordHash: string, role: 'user' | 'admin'): Promise<User> {
    const user = this.usersRepository.create({ email, passwordHash, role });
    return this.usersRepository.save(user);
  }

  /**
   * Fresh plan read for one request. The plan is NEVER taken from the JWT:
   * an admin plan change must take effect on the caller's next send.
   */
  async getPlan(userId: string): Promise<UserPlan> {
    const user = await this.usersRepository.findOne({
      where: { id: userId },
      select: ['id', 'plan'],
    });
    if (!user) throw new NotFoundException('کاربر پیدا نشد.');
    return user.plan;
  }

  /** All users for the admin panel (oldest first; no secrets). */
  async listAll(): Promise<AdminUser[]> {
    const users = await this.usersRepository.find({
      select: ['id', 'email', 'role', 'plan', 'createdAt'],
      order: { createdAt: 'ASC' },
    });
    // Explicit mapping (not just the select) so no extra column can ever leak.
    return users.map((user) => this.toAdminUser(user));
  }

  async setPlan(userId: string, plan: UserPlan): Promise<AdminUser> {
    const user = await this.usersRepository.findOne({ where: { id: userId } });
    if (!user) throw new NotFoundException('کاربر پیدا نشد.');
    if (user.plan === plan) {
      // Idempotent no-op: return the current state instead of failing.
      return this.toAdminUser(user);
    }
    user.plan = plan;
    return this.toAdminUser(await this.usersRepository.save(user));
  }

  private toAdminUser(user: User): AdminUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      plan: user.plan,
      createdAt: user.createdAt,
    };
  }
}
