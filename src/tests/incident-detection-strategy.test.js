const { detectGroups } = require('../domain/incident-detection-strategy');

describe('incident-detection-strategy', () => {
  describe('detectGroups', () => {
    it('primary funciona bien y devuelve grupos: se usa ese resultado, fallback nunca se invoca', async () => {
      const primary = jest.fn().mockReturnValue([['e1', 'e2']]);
      const fallback = jest.fn().mockReturnValue([['fallback-group']]);

      const result = await detectGroups(['candidate'], { radiusMeters: 300 }, { primary, fallback });

      expect(result.groups).toEqual([['e1', 'e2']]);
      expect(result.strategy).toBe('primary');
      expect(primary).toHaveBeenCalledTimes(1);
      expect(primary).toHaveBeenCalledWith(['candidate'], { radiusMeters: 300 });
      expect(fallback).not.toHaveBeenCalled();
    });

    it('primary devuelve [] (sin cluster, sin excepcion): se devuelve [], fallback nunca se invoca', async () => {
      const primary = jest.fn().mockReturnValue([]);
      const fallback = jest.fn().mockReturnValue([['fallback-group']]);

      const result = await detectGroups(['candidate'], {}, { primary, fallback });

      expect(result.groups).toEqual([]);
      expect(result.strategy).toBe('primary');
      expect(fallback).not.toHaveBeenCalled();
    });

    it('primary tira una excepcion sync: se usa el resultado de fallback y se loguea un warning', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const primary = jest.fn(() => {
        throw new Error('primary rompio sync');
      });
      const fallback = jest.fn().mockReturnValue([['from-fallback']]);

      const result = await detectGroups(['candidate'], {}, { primary, fallback });

      expect(result.groups).toEqual([['from-fallback']]);
      expect(result.strategy).toBe('fallback');
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy.mock.calls[0][0]).toContain('primary rompio sync');

      consoleWarnSpy.mockRestore();
    });

    it('primary es async y su promesa rechaza: mismo comportamiento que la excepcion sync', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const primary = jest.fn().mockRejectedValue(new Error('primary rompio async'));
      const fallback = jest.fn().mockResolvedValue([['from-fallback-async']]);

      const result = await detectGroups(['candidate'], {}, { primary, fallback });

      expect(result.groups).toEqual([['from-fallback-async']]);
      expect(result.strategy).toBe('fallback');
      expect(fallback).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
      expect(consoleWarnSpy.mock.calls[0][0]).toContain('primary rompio async');

      consoleWarnSpy.mockRestore();
    });

    it('primary y fallback fallan los dos: la excepcion de fallback se propaga', async () => {
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const primary = jest.fn(() => {
        throw new Error('primary rompio');
      });
      const fallback = jest.fn(() => {
        throw new Error('fallback tambien rompio');
      });

      await expect(detectGroups(['candidate'], {}, { primary, fallback }))
        .rejects.toThrow('fallback tambien rompio');

      consoleWarnSpy.mockRestore();
    });
  });
});
