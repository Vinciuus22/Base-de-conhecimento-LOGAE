import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { USERS, login, newSession, uid } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));

test.describe('Base de Conhecimento — fluxos principais', () => {
  test('pesquisa pública com destaque e artigo com vídeo em player ampliado', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Pesquisar na Base de Conhecimento').fill('erro ao exportar relatório');
    await page.getByRole('button', { name: 'Pesquisar' }).click();
    await expect(page.getByRole('link', { name: /Como exportar relatórios/ })).toBeVisible();
    await expect(page.locator('mark.hl').first()).toBeVisible();
    await page.getByRole('link', { name: /Como exportar relatórios/ }).first().click();
    await expect(page.getByRole('heading', { level: 1, name: /Como exportar relatórios/ })).toBeVisible();
    await expect(page.locator('[data-callout="dica"]')).toContainText('Use filtros');
    const play = page.getByRole('button', { name: /Reproduzir vídeo/ });
    await expect(play).toBeVisible();
    await play.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('iframe[src*="youtube-nocookie.com/embed/M7lc1UVf-VE"]')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(play).toBeFocused();
  });

  test('artigo interno não é acessível sem login', async ({ page }) => {
    await page.goto('/artigos/procedimento-interno-reprocessar-nota-fiscal-rejeitada');
    await expect(page.getByText('Artigo não encontrado')).toBeVisible();
  });

  test('usuário externo não acessa o ambiente interno', async ({ page }) => {
    await login(page, USERS.customer);
    await expect(page.getByRole('link', { name: 'Ambiente interno' })).toHaveCount(0);
    await page.goto('/interno/artigos/novo');
    await expect(page.getByText('Acesso não autorizado')).toBeVisible();
  });

  test('editor: formatação, bloco de destaque sem código, pré-visualização e salvamento', async ({ page }) => {
    await login(page, USERS.editor);
    await page.goto('/interno/artigos/novo');
    const title = uid('Artigo E2E');
    await page.getByLabel('Título').fill(title);
    await page.getByLabel('Resumo').fill('Resumo criado no teste ponta a ponta.');
    await page.getByRole('button', { name: 'Externo' }).click();
    const editor = page.getByRole('textbox', { name: 'Conteúdo do artigo' });
    await editor.click();
    await page.keyboard.type('Texto em destaque para o teste');
    await page.keyboard.press('Control+A');
    await page.getByRole('button', { name: /Bloco de destaque/ }).click();
    await page.getByRole('menuitem', { name: 'Atenção' }).click();
    await expect(editor.locator('[data-callout="atencao"]')).toContainText('Texto em destaque');
    await page.getByRole('button', { name: 'Visualizar artigo' }).click();
    const preview = page.getByRole('dialog', { name: 'Pré-visualização do artigo' });
    await expect(preview.getByRole('heading', { name: title })).toBeVisible();
    await expect(preview.locator('[data-callout="atencao"]')).toBeVisible();
    await preview.getByRole('button', { name: 'Fechar' }).click();
    await page.getByLabel('Categoria').selectOption({ label: 'Relatórios' });
    await page.getByLabel('Sistema relacionado').selectOption({ label: 'ERP LOGAE' });
    await page.getByRole('button', { name: 'Salvar rascunho' }).click();
    await expect(page).toHaveURL(/\/interno\/artigos\/[0-9a-f-]+\/editar/);
    await expect(page.getByTestId('editing-identity')).toBeVisible();
    await page.getByRole('button', { name: 'Salvar e concluir edição' }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(page.locator('[data-callout="atencao"]')).toContainText('Texto em destaque');
  });

  test('bloqueio de edição: segundo usuário vê o responsável e não consegue editar', async ({ browser }) => {
    const a = await newSession(browser, USERS.editor);
    const b = await newSession(browser, USERS.publisher);
    // Usuário A cria e abre a edição
    await a.page.goto('/interno/artigos/novo');
    const title = uid('Bloqueio E2E');
    await a.page.getByLabel('Título').fill(title);
    await a.page.getByRole('button', { name: 'Interno' }).click();
    await a.page.getByRole('button', { name: 'Salvar rascunho' }).click();
    await expect(a.page.getByTestId('editing-identity')).toBeVisible();
    const editUrl = a.page.url();
    const articleId = editUrl.split('/').at(-2)!;

    // Usuário B abre o artigo: botão desabilitado e mensagem com o nome de A
    const res = await b.page.request.get(`/api/articles/${articleId}`);
    const slug = (await res.json()).article.slug as string;
    await b.page.goto(`/artigos/${slug}`);
    await expect(b.page.getByTestId('lock-banner')).toContainText('Este artigo está sendo editado por Edna Editora desde');
    await expect(b.page.getByTestId('edit-article')).toBeDisabled();
    // Acesso direto ao editor também fica em modo de visualização
    await b.page.goto(editUrl);
    await expect(b.page.getByTestId('lock-banner')).toContainText('Edna Editora');
    await expect(b.page.getByLabel('Título')).toBeDisabled();

    // A cancela a edição: o bloqueio é liberado e B passa a ver o artigo disponível
    await a.page.getByRole('button', { name: 'Cancelar edição' }).click();
    await expect(b.page.getByText('O artigo está disponível para edição.')).toBeVisible({ timeout: 15_000 });
    await b.page.getByRole('button', { name: 'Editar agora' }).click();
    await expect(b.page.getByTestId('editing-identity')).toBeVisible();
    await b.page.getByRole('button', { name: 'Cancelar edição' }).click();
    await a.context.close();
    await b.context.close();
  });

  test('abertura de ticket exige imagem/vídeo, gera protocolo e aparece em Meus tickets', async ({ page }) => {
    await login(page, USERS.customer);
    await page.goto('/tickets/novo');
    await page.getByLabel('Sistema').selectOption({ label: 'ERP LOGAE' });
    await page.getByLabel('Descrição').fill('Ao exportar o relatório de vendas aparece erro 500 e o arquivo não é gerado.');
    await page.getByRole('button', { name: 'Revisar e enviar' }).click();
    await expect(page.getByText('Anexe pelo menos uma imagem ou vídeo.')).toBeVisible();
    await page.locator('input[type=file]').setInputFiles(path.join(here, 'fixtures', 'captura.png'));
    await page.getByRole('button', { name: 'Revisar e enviar' }).click();
    await expect(page.getByRole('dialog', { name: /Revise as informações/ })).toBeVisible();
    await page.getByRole('button', { name: 'Confirmar e abrir ticket' }).click();
    const protocol = (await page.getByTestId('protocol').textContent())!.trim();
    expect(protocol).toMatch(/^\d{10}$/);
    await page.getByRole('link', { name: 'Meus tickets' }).last().click();
    await expect(page.getByRole('link', { name: protocol })).toBeVisible();
    await page.getByRole('link', { name: protocol }).click();
    await expect(page.getByText('Descrição original')).toBeVisible();
  });

  test('chat apresenta fontes da Base de Conhecimento e oferece ticket quando não há solução', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Abrir o assistente virtual' }).click();
    await page.getByLabel('Sua pergunta').fill('Como redefinir a senha do portal do cliente?');
    await page.getByRole('button', { name: 'Enviar pergunta' }).click();
    await expect(page.locator('.chat-source').first()).toContainText('Redefinir senha');
    await page.getByLabel('Sua pergunta').fill('Como integrar com o satélite xyzw?');
    await page.getByRole('button', { name: 'Enviar pergunta' }).click();
    await expect(page.getByText('Não encontrei na Base de Conhecimento uma solução confirmada')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Abrir ticket' })).toBeVisible();
  });

  test('layout responsivo no celular @mobile', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Abrir menu' })).toBeVisible();
    await page.getByRole('button', { name: 'Abrir menu' }).click();
    await expect(page.getByRole('link', { name: 'Atualizações' })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
  });

  test('contas de teste: interno gerencia comunicados; externo só visualiza atualizações', async ({ browser }) => {
    const ext = await newSession(browser, { email: 'externo@teste.com', password: 'Teste@12345' });
    await ext.page.goto('/atualizacoes');
    await expect(ext.page.getByRole('heading', { name: 'Atualizações' }).first()).toBeVisible();
    await expect(ext.page.getByRole('link', { name: 'Comunicados' })).toHaveCount(0);
    await expect(ext.page.getByRole('link', { name: /Gerenciar integração/ })).toHaveCount(0);
    await ext.page.goto('/comunicados');
    await expect(ext.page.getByText('Acesso não autorizado')).toBeVisible();
    await ext.context.close();

    const int = await newSession(browser, { email: 'interno@teste.com', password: 'Teste@12345' });
    await int.page.goto('/comunicados');
    await expect(int.page.getByRole('link', { name: 'Novo comunicado' })).toBeVisible();
    await int.page.goto('/interno/atualizacoes');
    await expect(int.page.getByRole('heading', { name: 'Atualizações (Jira)' })).toBeVisible();
    await int.context.close();
  });
});
