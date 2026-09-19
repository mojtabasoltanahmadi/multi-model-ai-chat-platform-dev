import {
  Column,
  CreateDateColumn,
  Entity,
  OneToMany,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Conversation } from '../conversations/conversation.entity';

export type UserRole = 'user' | 'admin';

/** Subscription plan. Read FRESH from the DB per request — never from the JWT. */
export type UserPlan = 'free' | 'premium';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 255, unique: true })
  email: string;

  @Column({ name: 'password_hash', type: 'varchar', length: 255 })
  passwordHash: string;

  @Column({ type: 'varchar', length: 20, default: 'user' })
  role: UserRole;

  /**
   * Plan behind the quota + model-access rules. Default 'free'; admins change
   * it via PATCH /admin/users/:userId/plan. Kept out of the JWT deliberately:
   * a plan change takes effect on the caller's NEXT request, not on re-login.
   */
  @Column({ type: 'varchar', length: 20, default: 'free' })
  plan: UserPlan;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @OneToMany(() => Conversation, (conversation) => conversation.user)
  conversations: Conversation[];
}
