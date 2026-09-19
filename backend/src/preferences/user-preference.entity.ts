import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One row per user, created lazily on the first preference write. Kept
 * separate from the auth-critical `users` row so future preferences
 * (language, density, …) can be added without touching authentication.
 */
@Entity('user_preferences')
export class UserPreference {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  /**
   * Theme id — validated against the enabled theme registry at the write
   * boundary, so a stored value can only be a known theme that was enabled
   * at selection time (reads re-resolve availability).
   */
  @Column({ name: 'theme_id', type: 'varchar', length: 40 })
  themeId: string;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
