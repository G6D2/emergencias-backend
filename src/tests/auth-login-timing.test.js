// Hash señuelo del login (igualación de tiempos, ver auth.controller.js): se
// calcula en el primer login y queda memorizado, no al cargar el módulo.
//
// Cada test carga el controller en un registro de módulos propio para arrancar
// sin nada memorizado, y espía la misma instancia de bcryptjs que usa.
function loadFresh() {
  let loaded;
  jest.isolateModules(() => {
    const bcrypt = require('bcryptjs');
    const hashSync = jest.spyOn(bcrypt, 'hashSync');
    const hash = jest.spyOn(bcrypt, 'hash');
    const { AuthController } = require('../controllers/auth.controller');
    const { BCRYPT_ROUNDS } = require('../repositories/auth-user.repository');
    loaded = { bcrypt, hashSync, hash, AuthController, BCRYPT_ROUNDS };
  });
  return loaded;
}

const issuer = {
  issueAccessToken: async () => ({ access_token: 't', token_type: 'Bearer', expires_in: 900 }),
};

function repoWithoutUsers() {
  return {
    findByEmail: jest.fn(async () => null),
    verifyPassword: jest.fn(async () => false),
  };
}

const CREDENTIALS = { email: 'no-existe@example.com', password: 'otra-cosa' };

describe('hash señuelo del login', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('cargar el módulo no calcula ningún hash', () => {
    const { hashSync, hash } = loadFresh();

    expect(hashSync).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it('el primer login lo calcula con el costo de los reales y los siguientes lo reusan', async () => {
    const { bcrypt, hash, hashSync, AuthController, BCRYPT_ROUNDS } = loadFresh();
    const repo = repoWithoutUsers();
    const controller = new AuthController(repo, issuer);

    for (let i = 0; i < 3; i += 1) {
      await expect(controller.login(CREDENTIALS)).rejects.toThrow('Correo o contraseña incorrectos.');
    }

    expect(hashSync).not.toHaveBeenCalled();
    expect(hash).toHaveBeenCalledTimes(1);
    expect(hash.mock.calls[0][1]).toBe(BCRYPT_ROUNDS);

    // Con el correo inexistente se compara igual, las tres veces contra el
    // mismo hash, que es un bcrypt real del mismo costo.
    expect(repo.verifyPassword).toHaveBeenCalledTimes(3);
    const hashes = repo.verifyPassword.mock.calls.map(([passwordHash]) => passwordHash);
    expect(new Set(hashes).size).toBe(1);
    expect(bcrypt.getRounds(hashes[0])).toBe(BCRYPT_ROUNDS);
    expect(repo.verifyPassword.mock.calls[0][1]).toBe(CREDENTIALS.password);
  });

  it('también lo calcula si el correo existe: el costo del primer login no delata la cuenta', async () => {
    const { hash, AuthController } = loadFresh();
    const repo = {
      findByEmail: jest.fn(async () => ({
        id: 'u-1', displayName: 'Ana', groups: ['citizen'], hasAntipanicButton: false, passwordHash: 'hash-real',
      })),
      verifyPassword: jest.fn(async () => true),
    };
    const controller = new AuthController(repo, issuer);

    await expect(controller.login({ email: 'ana@example.com', password: 'secreto12' }))
      .resolves.toMatchObject({ user: { sub: 'u-1' } });

    expect(hash).toHaveBeenCalledTimes(1);
    // La comparación va contra el hash de la cuenta, no contra el señuelo.
    expect(repo.verifyPassword).toHaveBeenCalledWith('hash-real', 'secreto12');
  });

  it('dos logins simultáneos no lo calculan dos veces', async () => {
    const { hash, AuthController } = loadFresh();
    const controller = new AuthController(repoWithoutUsers(), issuer);

    const results = await Promise.allSettled([controller.login(CREDENTIALS), controller.login(CREDENTIALS)]);

    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(hash).toHaveBeenCalledTimes(1);
  });

  it('si el cálculo falla no queda memorizado el error: el próximo login lo reintenta', async () => {
    const { hash, AuthController } = loadFresh();
    hash.mockRejectedValueOnce(new Error('bcrypt roto'));
    const repo = repoWithoutUsers();
    const controller = new AuthController(repo, issuer);

    await expect(controller.login(CREDENTIALS)).rejects.toThrow('bcrypt roto');
    expect(repo.verifyPassword).not.toHaveBeenCalled();

    await expect(controller.login(CREDENTIALS)).rejects.toThrow('Correo o contraseña incorrectos.');
    expect(hash).toHaveBeenCalledTimes(2);
    expect(repo.verifyPassword).toHaveBeenCalledTimes(1);
  });
});
