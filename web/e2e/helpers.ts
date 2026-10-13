import { expect, type Browser, type Page } from '@playwright/test';

export const DEMO_PASSWORD = process.env.E2E_DEMO_PASSWORD ?? 'Demo12345!';
export const USERS = {
  admin: { email: process.env.E2E_ADMIN_EMAIL ?? 'admin@exemplo.com', password: process.env.E2E_ADMIN_PASSWORD ?? 'Admin12345!' },
  editor: { email: 'editor@exemplo.com', password: DEMO_PASSWORD },
  publisher: { email: 'publicador@exemplo.com', password: DEMO_PASSWORD },
  support: { email: 'suporte@exemplo.com', password: DEMO_PASSWORD },
  customer: { email: 'cliente@exemplo.com', password: DEMO_PASSWORD },
};

export async function login(page: Page, user: { email: string; password: string }) {
  await page.goto('/entrar');
  await page.getByLabel('Login').fill(user.email);
  await page.getByLabel('Senha', { exact: true }).fill(user.password);
  await page.getByRole('button', { name: 'Entrar' }).last().click();
  await expect(page.getByRole('button', { name: 'Sair' })).toBeVisible();
}

export async function newSession(browser: Browser, user: { email: string; password: string }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, user);
  return { context, page };
}

export function uid(prefix: string) {
  return `${prefix} ${Math.random().toString(36).slice(2, 8)}`;
}
