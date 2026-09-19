import { ConflictException } from '@nestjs/common';
import { PlansService } from './plans.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { createMockRepository } from '../test/mocks';

const existingPlan = {
  id: 'plan-1',
  slug: 'pro',
  name: 'Pro',
  price: '200000',
  currency: 'IRT',
  billingPeriod: 'monthly',
  dailyMessageQuota: 500,
  dailyTokenQuota: null,
  allowedModelIds: null,
  webSearch: true,
  thinking: true,
  fileProcessing: true,
  isActive: true,
  description: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const dto: CreatePlanDto = {
  slug: 'enterprise',
  name: 'سازمانی',
  description: null,
  price: 900000,
  currency: 'IRT',
  billingPeriod: 'yearly',
  dailyMessageQuota: 5000,
  dailyTokenQuota: null,
  allowedModelIds: null,
  webSearch: true,
  thinking: true,
  fileProcessing: true,
};

describe('PlansService — dynamic plan management (nothing hard-coded)', () => {
  let plansRepository: ReturnType<typeof createMockRepository>;
  let auditService: { record: jest.Mock };
  let service: PlansService;

  beforeEach(() => {
    plansRepository = createMockRepository();
    plansRepository.findOne = jest.fn(async () => null);
    plansRepository.save = jest.fn(async (data: unknown) => data);
    auditService = { record: jest.fn().mockResolvedValue(undefined) };
    service = new PlansService(plansRepository as never, auditService as never);
  });

  it('creates a plan from the DTO — amount stored as the numeric string', async () => {
    const plan = await service.create(dto, 'admin-1', 'admin@x.y');

    expect(plan.slug).toBe('enterprise');
    expect(plan.price).toBe('900000');
    expect(plan.isActive).toBe(true);
    expect(auditService.record).toHaveBeenCalledWith('plan.created', expect.anything());
  });

  it('rejects a duplicate slug (409) — plans are uniquely identified', async () => {
    plansRepository.findOne = jest.fn(async () => existingPlan);

    await expect(service.create({ ...dto, slug: 'pro' }, 'admin-1', null)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('updates only the provided fields; price becomes the numeric string', async () => {
    plansRepository.findOne = jest.fn(async () => ({ ...existingPlan }));

    const updated = await service.update('plan-1', { price: 250000, name: 'Pro+' }, 'admin-1', null);

    expect(updated.price).toBe('250000');
    expect(updated.name).toBe('Pro+');
    expect(updated.currency).toBe('IRT'); // untouched
    expect(auditService.record).toHaveBeenCalledWith(
      'plan.updated',
      expect.objectContaining({ metadata: { slug: 'pro', changedFields: ['price', 'name'] } }),
    );
  });

  it('deactivation flips isActive and audits plan.deactivated', async () => {
    plansRepository.findOne = jest.fn(async () => ({ ...existingPlan }));

    const plan = await service.setActive('plan-1', false, 'admin-1', null);

    expect(plan.isActive).toBe(false);
    expect(auditService.record).toHaveBeenCalledWith('plan.deactivated', expect.anything());
  });

  it('setActive is a no-op (no audit spam) when the state already matches', async () => {
    plansRepository.findOne = jest.fn(async () => ({ ...existingPlan }));

    await service.setActive('plan-1', true, 'admin-1', null);

    expect(auditService.record).not.toHaveBeenCalled();
  });
});
