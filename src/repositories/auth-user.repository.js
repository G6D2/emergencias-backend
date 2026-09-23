const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_ROUNDS = 10;

function mapAuthUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    groups: Array.isArray(row.groups) ? row.groups : [],
    hasAntipanicButton: Boolean(row.has_antipanic_button),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

class AuthUserRepository {
  constructor(pool) {
    if (!pool) {
      throw new Error('AuthUserRepository requires a database pool');
    }
    this.pool = pool;
  }

  async findByEmail(email) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized) return null;
    const result = await this.pool.query(
      `SELECT id, email, password_hash, display_name, groups, has_antipanic_button,
              created_at, updated_at
       FROM auth_users
       WHERE lower(email) = $1`,
      [normalized]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      ...mapAuthUser(row),
      passwordHash: row.password_hash,
    };
  }

  async findById(id) {
    const result = await this.pool.query(
      `SELECT id, email, display_name, groups, has_antipanic_button, created_at, updated_at
       FROM auth_users
       WHERE id = $1`,
      [id]
    );
    return mapAuthUser(result.rows[0]);
  }

  async create({ email, password, displayName, groups, hasAntipanicButton = false }) {
    const id = randomUUID();
    const normalizedEmail = String(email).trim().toLowerCase();
    const name = typeof displayName === 'string' && displayName.trim()
      ? displayName.trim().slice(0, 120)
      : normalizedEmail.split('@')[0].slice(0, 120);
    const userGroups = Array.isArray(groups) && groups.length > 0
      ? groups.filter((g) => typeof g === 'string')
      : ['citizen'];
    const passwordHash = await bcrypt.hash(String(password), BCRYPT_ROUNDS);

    const result = await this.pool.query(
      `INSERT INTO auth_users
         (id, email, password_hash, display_name, groups, has_antipanic_button, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5::text[], $6, now(), now())
       RETURNING id, email, display_name, groups, has_antipanic_button, created_at, updated_at`,
      [id, normalizedEmail, passwordHash, name, userGroups, Boolean(hasAntipanicButton)]
    );
    return mapAuthUser(result.rows[0]);
  }

  async verifyPassword(passwordHash, password) {
    if (!passwordHash || typeof password !== 'string') return false;
    return bcrypt.compare(password, passwordHash);
  }
}

module.exports = { AuthUserRepository, mapAuthUser, BCRYPT_ROUNDS };
