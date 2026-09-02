/**
 * Headers de seguridad + HTTPS detrás de proxy (Render, etc.).
 * En producción exige X-Forwarded-Proto=https (o TLS directo).
 */
function createSecurityMiddleware(env = process.env) {
  const isProduction = env.NODE_ENV === 'production';
  const forceHttps = env.FORCE_HTTPS === 'true' || isProduction;

  return function securityMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()'
    );

    if (forceHttps) {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains'
      );

      const forwardedProto = req.get('x-forwarded-proto');
      const secure = req.secure || forwardedProto === 'https';

      // Health puede vivir en probes internos; el resto exige HTTPS en prod.
      if (!secure && req.path !== '/health') {
        const host = req.get('host') || 'localhost';
        return res.redirect(301, `https://${host}${req.originalUrl}`);
      }
    }

    next();
  };
}

module.exports = { createSecurityMiddleware };
