import { ThemesService } from './themes.service';
import { createMockRepository } from '../test/mocks';
import { Theme } from './theme.entity';

/** Row factory with the entity's defaults so specs only state what matters. */
function buildTheme(overrides: Partial<Theme> & { id: string }): Theme {
  return {
    name: overrides.id,
    description: null,
    enabled: true,
    isDefault: false,
    sortOrder: 1,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as Theme;
}

describe('ThemesService', () => {
  let repository: ReturnType<typeof createMockRepository>;
  let service: ThemesService;

  beforeEach(() => {
    repository = createMockRepository();
    service = new ThemesService(repository as never);
  });

  describe('seed-on-init', () => {
    it('creates every registry theme on an empty table with light as default', async () => {
      repository.find.mockResolvedValue([]);
      // The repair step sees the freshly seeded default and does nothing.
      repository.findOne.mockImplementation(async (options: { where?: Record<string, unknown> }) => {
        if (options?.where?.isDefault) return buildTheme({ id: 'light', isDefault: true });
        return null;
      });

      await service.onModuleInit();

      expect(repository.save).toHaveBeenCalledTimes(1);
      const rows = repository.save.mock.calls[0][0] as Theme[];
      expect(rows.map((row) => row.id)).toEqual(['light', 'dark', 'midnight']);
      expect(rows.every((row) => row.enabled)).toBe(true);
      expect(rows.find((row) => row.id === 'light')?.isDefault).toBe(true);
      expect(rows.filter((row) => row.id !== 'light').every((row) => !row.isDefault)).toBe(true);
      expect(rows.map((row) => row.sortOrder)).toEqual([1, 2, 3]);
    });

    it('is idempotent: an already-seeded table is not rewritten', async () => {
      repository.find.mockResolvedValue([
        buildTheme({ id: 'light', isDefault: true, sortOrder: 1 }),
        buildTheme({ id: 'dark', sortOrder: 2 }),
        buildTheme({ id: 'midnight', sortOrder: 3 }),
      ]);
      repository.findOne.mockResolvedValue(buildTheme({ id: 'light', isDefault: true }));

      await service.onModuleInit();

      expect(repository.save).not.toHaveBeenCalled();
      expect(repository.update).not.toHaveBeenCalled();
    });

    it('seeds only the missing registry themes when some rows exist', async () => {
      repository.find.mockResolvedValue([buildTheme({ id: 'light', isDefault: true, sortOrder: 1 })]);
      repository.findOne.mockResolvedValue(buildTheme({ id: 'light', isDefault: true }));

      await service.onModuleInit();

      const rows = repository.save.mock.calls[0][0] as Theme[];
      expect(rows.map((row) => row.id)).toEqual(['dark', 'midnight']);
      // The existing default stays the default — new rows never steal it.
      expect(rows.every((row) => !row.isDefault)).toBe(true);
    });

    it('repairs a drifted table with no default by promoting the first enabled theme', async () => {
      repository.find.mockResolvedValue([
        buildTheme({ id: 'dark', sortOrder: 2 }),
        buildTheme({ id: 'midnight', sortOrder: 3 }),
      ]);
      repository.findOne.mockImplementation(async (options: { where?: Record<string, unknown> }) => {
        if (options?.where?.isDefault) return null;
        if (options?.where?.enabled) return buildTheme({ id: 'dark', sortOrder: 2 });
        return null;
      });

      await service.onModuleInit();

      expect(repository.update).toHaveBeenCalledWith({ isDefault: true }, { isDefault: false });
      expect(repository.update).toHaveBeenCalledWith({ id: 'dark' }, { isDefault: true });
    });
  });

  describe('listing', () => {
    it('listAvailable returns only enabled themes in display order', async () => {
      const rows = [
        buildTheme({ id: 'light', isDefault: true, sortOrder: 1 }),
        buildTheme({ id: 'midnight', sortOrder: 3 }),
      ];
      repository.find.mockResolvedValue(rows);

      const result = await service.listAvailable();

      expect(repository.find).toHaveBeenCalledWith({
        where: { enabled: true },
        order: { sortOrder: 'ASC', id: 'ASC' },
      });
      expect(result.map((theme) => theme.id)).toEqual(['light', 'midnight']);
    });

    it('listAll returns every theme in display order', async () => {
      const rows = [
        buildTheme({ id: 'light', sortOrder: 1 }),
        buildTheme({ id: 'dark', enabled: false, sortOrder: 2 }),
      ];
      repository.find.mockResolvedValue(rows);

      const result = await service.listAll();

      expect(repository.find).toHaveBeenCalledWith({
        order: { sortOrder: 'ASC', id: 'ASC' },
      });
      expect(result).toHaveLength(2);
    });
  });

  describe('updateStatus', () => {
    it('refuses to disable the last enabled theme', async () => {
      repository.findOne.mockResolvedValue(buildTheme({ id: 'midnight', sortOrder: 3 }));
      repository.count.mockResolvedValue(1);

      await expect(service.updateStatus('midnight', false)).rejects.toMatchObject({ status: 400 });
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('disabling the default moves the default to the first remaining enabled theme', async () => {
      const midnight = buildTheme({ id: 'midnight', sortOrder: 3, isDefault: true });
      repository.findOne.mockImplementation(async (options: { where?: Record<string, unknown> }) => {
        if (options?.where?.id === 'midnight') return midnight;
        if (options?.where?.enabled) return buildTheme({ id: 'light', sortOrder: 1 });
        return null;
      });
      repository.count.mockResolvedValue(2);

      const result = await service.updateStatus('midnight', false);

      expect(repository.update).toHaveBeenCalledWith({ id: 'light' }, { isDefault: true });
      expect(result.enabled).toBe(false);
      expect(result.isDefault).toBe(false);
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('disabling a non-default theme leaves the default untouched', async () => {
      const dark = buildTheme({ id: 'dark', sortOrder: 2 });
      repository.findOne.mockResolvedValue(dark);
      repository.count.mockResolvedValue(3);

      const result = await service.updateStatus('dark', false);

      expect(repository.update).not.toHaveBeenCalled();
      expect(result.enabled).toBe(false);
      expect(result.isDefault).toBe(false);
    });

    it('enabling a disabled theme just saves it', async () => {
      const dark = buildTheme({ id: 'dark', sortOrder: 2, enabled: false });
      repository.findOne.mockResolvedValue(dark);

      const result = await service.updateStatus('dark', true);

      expect(result.enabled).toBe(true);
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('is a no-op when the status already matches', async () => {
      repository.findOne.mockResolvedValue(buildTheme({ id: 'dark', sortOrder: 2 }));

      await service.updateStatus('dark', true);

      expect(repository.save).not.toHaveBeenCalled();
    });

    it('rejects an unknown theme id with 404', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.updateStatus('bogus', false)).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('setDefault', () => {
    it('refuses a disabled theme', async () => {
      repository.findOne.mockResolvedValue(buildTheme({ id: 'dark', sortOrder: 2, enabled: false }));

      await expect(service.setDefault('dark')).rejects.toMatchObject({ status: 400 });
    });

    it('clears the previous default and flags the new one atomically', async () => {
      const midnight = buildTheme({ id: 'midnight', sortOrder: 3 });
      repository.findOne.mockResolvedValue(midnight);

      const result = await service.setDefault('midnight');

      expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
      expect(repository.update).toHaveBeenNthCalledWith(1, Theme, { isDefault: true }, { isDefault: false });
      expect(repository.update).toHaveBeenNthCalledWith(2, Theme, { id: 'midnight' }, { isDefault: true });
      expect(result.isDefault).toBe(true);
    });

    it('is a no-op when the theme is already the default', async () => {
      const light = buildTheme({ id: 'light', sortOrder: 1, isDefault: true });
      repository.findOne.mockResolvedValue(light);

      const result = await service.setDefault('light');

      expect(repository.manager.transaction).not.toHaveBeenCalled();
      expect(result.isDefault).toBe(true);
    });

    it('rejects an unknown theme id with 404', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.setDefault('bogus')).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('update (metadata)', () => {
    it('trims the name and persists metadata edits', async () => {
      const dark = buildTheme({ id: 'dark', sortOrder: 2 });
      repository.findOne.mockResolvedValue(dark);

      const result = await service.update('dark', { name: '  شبانه  ', description: 'توضیح', sortOrder: 5 });

      expect(result.name).toBe('شبانه');
      expect(result.description).toBe('توضیح');
      expect(result.sortOrder).toBe(5);
      expect(repository.save).toHaveBeenCalledTimes(1);
    });

    it('stores an empty description as null', async () => {
      const dark = buildTheme({ id: 'dark', sortOrder: 2, description: 'قبلی' });
      repository.findOne.mockResolvedValue(dark);

      const result = await service.update('dark', { description: '   ' });

      expect(result.description).toBeNull();
    });

    it('rejects an unknown theme id with 404', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.update('bogus', { name: 'x' })).rejects.toMatchObject({ status: 404 });
    });
  });

  describe('reorder', () => {
    it('applies a complete permutation as sequential sort orders', async () => {
      const rows = [
        buildTheme({ id: 'light', sortOrder: 1 }),
        buildTheme({ id: 'dark', sortOrder: 2 }),
        buildTheme({ id: 'midnight', sortOrder: 3 }),
      ];
      repository.find.mockResolvedValue(rows);

      const result = await service.reorder({ themeIds: ['midnight', 'light', 'dark'] });

      expect(repository.update).toHaveBeenNthCalledWith(1, Theme, { id: 'midnight' }, { sortOrder: 1 });
      expect(repository.update).toHaveBeenNthCalledWith(2, Theme, { id: 'light' }, { sortOrder: 2 });
      expect(repository.update).toHaveBeenNthCalledWith(3, Theme, { id: 'dark' }, { sortOrder: 3 });
      expect(result).toHaveLength(3);
    });

    it('refuses duplicates', async () => {
      await expect(
        service.reorder({ themeIds: ['light', 'light', 'dark'] }),
      ).rejects.toMatchObject({ status: 400 });
    });

    it('refuses partial lists', async () => {
      await expect(
        service.reorder({ themeIds: ['light', 'dark'] }),
      ).rejects.toMatchObject({ status: 400 });
      expect(repository.manager.transaction).not.toHaveBeenCalled();
    });
  });

  describe('availability helpers', () => {
    it('isThemeEnabled mirrors the enabled flag', async () => {
      repository.exists.mockResolvedValue(true);
      await expect(service.isThemeEnabled('dark')).resolves.toBe(true);
      expect(repository.exists).toHaveBeenCalledWith({ where: { id: 'dark', enabled: true } });

      repository.exists.mockResolvedValue(false);
      await expect(service.isThemeEnabled('dark')).resolves.toBe(false);
    });

    it('resolveAvailableThemeId returns the preference while it is enabled', async () => {
      repository.findOne.mockImplementation(async (options: { where?: Record<string, unknown> }) => {
        if (options?.where?.id === 'midnight') return buildTheme({ id: 'midnight', sortOrder: 3 });
        return null;
      });

      await expect(service.resolveAvailableThemeId('midnight')).resolves.toBe('midnight');
    });

    it('resolveAvailableThemeId falls back to the default when the preference was disabled', async () => {
      repository.findOne.mockImplementation(async (options: { where?: Record<string, unknown> }) => {
        if (options?.where && 'id' in options.where) return null; // dark is disabled
        if (options?.where?.isDefault) return buildTheme({ id: 'light', isDefault: true, sortOrder: 1 });
        return null;
      });

      await expect(service.resolveAvailableThemeId('dark')).resolves.toBe('light');
    });

    it('resolveAvailableThemeId with no preference returns the default theme', async () => {
      repository.findOne.mockImplementation(async (options: { where?: Record<string, unknown> }) => {
        if (options?.where?.isDefault) return buildTheme({ id: 'light', isDefault: true, sortOrder: 1 });
        return null;
      });

      await expect(service.resolveAvailableThemeId(null)).resolves.toBe('light');
    });

    it('resolveAvailableThemeId without a default promotes the first enabled theme', async () => {
      repository.findOne.mockImplementation(async (options: { where?: Record<string, unknown> }) => {
        if (options?.where?.isDefault) return null;
        if (options?.where?.enabled) return buildTheme({ id: 'midnight', sortOrder: 3 });
        return null;
      });

      await expect(service.resolveAvailableThemeId(null)).resolves.toBe('midnight');
    });

    it('resolveAvailableThemeId on an empty table returns the built-in safe default', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.resolveAvailableThemeId(null)).resolves.toBe('light');
    });
  });
});
