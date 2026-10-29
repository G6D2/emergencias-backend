/**
 * Script para generar un token JWT de desarrollo con formato compatible con CityPass+ LDAP.
 * Uso:
 *   node scripts/generate-dev-token.js dispatcher
 *   node scripts/generate-dev-token.js delegado
 *   node scripts/generate-dev-token.js citizen
 */

const role = process.argv[2] || 'dispatcher';

const roleMap = {
  dispatcher: {
    sub: 'juan',
    preferred_username: 'juan',
    groups: ['dispatcher'],
  },
  delegado: {
    sub: 'delegado-emer',
    preferred_username: 'delegado-emer',
    groups: ['delegados'],
  },
  citizen: {
    sub: 'U000042',
    preferred_username: 'juanpanico',
    groups: ['citizen'],
  },
};

const payload = roleMap[role] || {
  sub: role,
  preferred_username: role,
  groups: [role],
};

async function main() {
  try {
    const res = await fetch('http://localhost:3000/auth/dev/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      console.error(`Error HTTP ${res.status}: Asegurate de que emergencias-backend esté corriendo en el puerto 3000.`);
      process.exit(1);
    }

    const data = await res.json();
    console.log('\n--- TOKEN JWT DE DEV GENERADO ---');
    console.log(`Rol: ${role} (sub: ${payload.sub}, groups: ${JSON.stringify(payload.groups)})`);
    console.log('\naccess_token:\n');
    console.log(data.access_token);
    console.log('\n---------------------------------\n');
  } catch (err) {
    console.error('Error al conectar con http://localhost:3000/auth/dev/login:', err.message);
    process.exit(1);
  }
}

main();
