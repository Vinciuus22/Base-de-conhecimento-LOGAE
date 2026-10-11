/** Contas de teste (criadas por `SEED_TEST_USERS=true npm run seed`). NÃO use em produção. */
export const TEST_PASSWORD = 'Teste@12345';

export const TEST_ACCOUNTS = [
  { type: 'internal', label: 'Usuário interno (administrador)', email: 'interno@teste.com', password: TEST_PASSWORD },
  { type: 'external', label: 'Usuário externo (cliente)', email: 'externo@teste.com', password: TEST_PASSWORD },
] as const;
