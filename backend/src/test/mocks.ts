/**
 * Creates a minimal in-memory TypeORM repository mock covering the subset
 * of Repository<T> used by the services under test. All methods are plain
 * jest.Mocks so individual specs can re-stub their behavior.
 *
 * `save()` assigns a generated id on the first call for any input that has
 * none, mutates the input (mirroring TypeORM's behaviour on a plain insert
 * with a `@PrimaryGeneratedColumn`), and pushes the snapshot onto a
 * `saved[]` history. Tests can read `saved` directly to inspect what was
 * actually persisted, including after subsequent in-memory mutations of
 * the original input reference.
 */
function mockFn(impl?: (...args: any[]) => any): jest.Mock {
  return jest.fn(impl) as jest.Mock;
}

export function createMockRepository() {
  const store: any[] = [];
  const saved: any[] = [];
  let autoId = 0;

  const repository = {
    store,
    saved,
    create: mockFn((data?: any) => data ?? {}),
    save: mockFn(async (data: any) => {
      // Take a snapshot of the data at save time. We return that same
      // object (so `await repository.save()` hydrates the caller's
      // reference with the generated id, exactly like TypeORM). The
      // `saved[]` history gets its own shallow copy so that mutations the
      // service makes to the returned entity after the fact do not
      // retroactively rewrite earlier writes — the stored history reflects
      // what was persisted at each call, not the entity's current state.
      const snapshot = { ...data };
      if (!snapshot.id) snapshot.id = `generated-${++autoId}`;
      saved.push({ ...snapshot });
      return snapshot;
    }),
    find: mockFn(async () => store),
    findOne: mockFn(async () => null),
    count: mockFn(async () => store.length),
    exists: mockFn(async () => false),
    update: mockFn(async () => undefined),
    insert: mockFn(async () => undefined),
    remove: mockFn(async (entity: any) => entity),
    manager: {
      // Transaction callbacks receive the SAME mock methods as the outer
      // repository, so `manager.save(...)` inside a transaction behaves
      // identically to a direct `save(...)` (used by the usage-records
      // transaction wrapper in beginChatTurn).
      transaction: mockFn(async (callback: any) => callback(repository as any)),
    },
  };

  return repository;
}

export function httpExceptionStatus(error: unknown): number | undefined {
  return (error as { status?: number })?.status;
}
