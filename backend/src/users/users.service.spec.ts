import { UsersService } from './users.service';

describe('UsersService — plans', () => {
  let repository: { findOne: jest.Mock; find: jest.Mock; save: jest.Mock };
  let service: UsersService;

  const user = (overrides: Partial<any> = {}) => ({
    id: 'user-1',
    email: 'sara@example.com',
    role: 'user',
    plan: 'free',
    createdAt: new Date(),
    ...overrides,
  });

  beforeEach(() => {
    repository = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn(async (data: any) => ({ ...data })),
    };
    service = new UsersService(repository as any);
  });

  it('getPlan reads the plan fresh from the DB', async () => {
    repository.findOne.mockResolvedValue(user({ plan: 'premium' }));
    await expect(service.getPlan('user-1')).resolves.toBe('premium');
    expect(repository.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-1' }, select: ['id', 'plan'] }),
    );
  });

  it('getPlan rejects an unknown user', async () => {
    await expect(service.getPlan('ghost')).rejects.toMatchObject({ status: 404 });
  });

  it('setPlan changes the plan', async () => {
    repository.findOne.mockResolvedValue(user());
    const result = await service.setPlan('user-1', 'premium');
    expect(result.plan).toBe('premium');
    expect(repository.save).toHaveBeenCalledWith(expect.objectContaining({ plan: 'premium' }));
  });

  it('setPlan is idempotent for the current plan (no save)', async () => {
    repository.findOne.mockResolvedValue(user({ plan: 'premium' }));
    const result = await service.setPlan('user-1', 'premium');
    expect(result.plan).toBe('premium');
    expect(repository.save).not.toHaveBeenCalled();
  });

  it('setPlan rejects an unknown user (404)', async () => {
    await expect(service.setPlan('ghost', 'premium')).rejects.toMatchObject({ status: 404 });
  });

  it('listAll returns only the admin-safe columns', async () => {
    repository.find.mockResolvedValue([user({ passwordHash: 'secret' })]);
    const list = await service.listAll();
    expect(list[0]).toEqual({
      id: 'user-1',
      email: 'sara@example.com',
      role: 'user',
      plan: 'free',
      createdAt: expect.any(Date),
    });
    expect(list[0]).not.toHaveProperty('passwordHash');
  });
});
