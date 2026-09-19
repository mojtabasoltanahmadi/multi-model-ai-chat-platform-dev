import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/**
 * One row per theme in the server-side registry (`theme-registry.ts`). The
 * primary key is the stable theme id — not a UUID — because the frontend
 * addresses themes by the same key it puts on `data-theme`.
 */
@Entity('themes')
export class Theme {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string;

  @Column({ type: 'varchar', length: 80 })
  name: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  description: string | null;

  /**
   * Whether users may select this theme. Enforced server-side: the available
   * list, the preference write and the resolved preference all filter on it.
   */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /**
   * The global default theme. Invariant (maintained by ThemesService): at
   * most one default, and a default is always enabled.
   */
  @Column({ name: 'is_default', type: 'boolean', default: false })
  isDefault: boolean;

  /** Display order (ascending); managed through the reorder endpoint. */
  @Column({ name: 'sort_order', type: 'integer', default: 0 })
  sortOrder: number;

  /** Reserved for per-theme display metadata (e.g. preview palettes). */
  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
