import { PreferencesService } from './preferences.service';
import { createMockRepository } from '../test/mocks';

describe('PreferencesService', () => {
  let repository: ReturnType<typeof createMockRepository>;
  let themesService: { isThemeEnabled: jest.Mock; resolveAvailableThemeId: jest.Mock };
  let service: PreferencesService;

  beforeEach(() => {
    repository = createMockRepository();
    themesService = {
      isThemeEnabled: jest.fn(),
      resolveAvailableThemeId: jest.fn(),
    };
    service = new PreferencesService(repository as never, themesService as never);
  });

  describe('getThemeId', () => {
    it('returns the stored theme id', async () => {
      repository.findOne.mockResolvedValue({ userId: 'u1', themeId: 'dark' });

      await expect(service.getThemeId('u1')).resolves.toBe('dark');
    });

    it('returns null when the user never chose a theme', async () => {
      repository.findOne.mockResolvedValue(null);

      await expect(service.getThemeId('u1')).resolves.toBeNull();
    });
  });

  describe('getResolvedThemeId', () => {
    it('resolves the stored theme through current availability', async () => {
      repository.findOne.mockResolvedValue({ userId: 'u1', themeId: 'dark' });
      themesService.resolveAvailableThemeId.mockResolvedValue('light');

      await expect(service.getResolvedThemeId('u1')).resolves.toBe('light');
      expect(themesService.resolveAvailableThemeId).toHaveBeenCalledWith('dark');
    });
  });

  describe('setThemeId', () => {
    it('rejects a theme that is not currently enabled', async () => {
      themesService.isThemeEnabled.mockResolvedValue(false);

      await expect(service.setThemeId('u1', 'dark')).rejects.toMatchObject({ status: 400 });
      expect(repository.insert).not.toHaveBeenCalled();
      expect(repository.save).not.toHaveBeenCalled();
    });

    it('inserts a row on the first choice', async () => {
      themesService.isThemeEnabled.mockResolvedValue(true);
      repository.findOne.mockResolvedValue(null);

      await expect(service.setThemeId('u1', 'midnight')).resolves.toBe('midnight');

      expect(repository.insert).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', themeId: 'midnight' }),
      );
    });

    it('updates the existing row on a later choice', async () => {
      themesService.isThemeEnabled.mockResolvedValue(true);
      repository.findOne.mockResolvedValue({ userId: 'u1', themeId: 'light' });

      await expect(service.setThemeId('u1', 'dark')).resolves.toBe('dark');

      expect(repository.save).toHaveBeenCalledWith(
        expect.objectContaining({ userId: 'u1', themeId: 'dark' }),
      );
      expect(repository.insert).not.toHaveBeenCalled();
    });
  });
});
