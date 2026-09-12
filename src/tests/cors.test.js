const { resolveCorsOrigins, DEV_DEFAULT_ORIGIN, RENDER_FRONTEND_ORIGIN } = require('../security/cors');

describe('resolveCorsOrigins', () => {
  it('defaults to the local frontend outside production', () => {
    expect(resolveCorsOrigins({})).toEqual([DEV_DEFAULT_ORIGIN]);
    expect(resolveCorsOrigins({ NODE_ENV: 'development' })).toEqual([DEV_DEFAULT_ORIGIN]);
  });

  it('requires CORS_ALLOWED_ORIGINS in production and falls back to the Render frontend', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(resolveCorsOrigins({ NODE_ENV: 'production' })).toEqual([RENDER_FRONTEND_ORIGIN]);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  it('parses a comma-separated list, trimming whitespace', () => {
    const origins = resolveCorsOrigins({
      CORS_ALLOWED_ORIGINS: 'https://a.example.com, https://b.example.com ,,',
    });

    expect(origins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('CORS_ALLOWED_ORIGINS takes precedence even in production', () => {
    const origins = resolveCorsOrigins({
      NODE_ENV: 'production',
      CORS_ALLOWED_ORIGINS: 'https://app.citypass.local',
    });

    expect(origins).toEqual(['https://app.citypass.local']);
  });
});
