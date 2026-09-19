import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { AuditLog } from './audit-log.entity';

// Single import site for consumers: the writer + the event-type catalog.
export { AuditEventType } from './audit-log.entity';

export interface AuditEventInfo {
  actorId?: string | null;
  actor?: string | null;
  target?: string | null;
  correlationId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Append-only audit writer (INV-08). Two modes:
 *  - in-transaction: pass an EntityManager and the row commits atomically
 *    with the business effect it describes (used for activation/expiration).
 *  - best-effort (default): never throws — an audit failure must not break
 *    the user-facing flow; it is logged instead.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(
    @InjectRepository(AuditLog)
    private readonly auditRepository: Repository<AuditLog>,
  ) {}

  async record(eventType: string, info: AuditEventInfo = {}, manager?: EntityManager): Promise<void> {
    const log = this.auditRepository.create({
      eventType,
      actorId: info.actorId ?? null,
      actor: info.actor ?? null,
      target: info.target ?? null,
      correlationId: info.correlationId ?? null,
      metadata: info.metadata ?? {},
    });
    try {
      if (manager) {
        await manager.save(log);
      } else {
        await this.auditRepository.save(log);
      }
    } catch (error) {
      // Best-effort only when NOT transactional: inside a transaction a throw
      // would roll back real business work, so surfacing it is correct there.
      if (manager) throw error;
      this.logger.error(
        `AuditWriteFailed eventType=${eventType} target=${info.target ?? '-'}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  /** Read-only admin listing (filter + cap). There is deliberately NO write path. */
  async list(filters: { eventType?: string; userId?: string; limit?: number } = {}): Promise<AuditLog[]> {
    const limit = Math.min(Math.max(filters.limit ?? 100, 1), 500);
    const qb = this.auditRepository
      .createQueryBuilder('log')
      .orderBy('log.createdAt', 'DESC')
      .take(limit);
    if (filters.eventType) {
      qb.andWhere('log.eventType = :eventType', { eventType: filters.eventType });
    }
    if (filters.userId) {
      qb.andWhere('log.actorId = :userId', { userId: filters.userId });
    }
    return qb.getMany();
  }
}
