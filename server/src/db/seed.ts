import type pg from 'pg';
import { type RoleKey } from '@shared/permissions.js';
import { hashPassword } from '../lib/crypto.js';
import { htmlToText, slugify } from '../lib/text.js';
import { reindexArticle } from '../modules/articles/indexing.js';
import { queryOne, withTransaction } from './pool.js';
import { syncRbac } from './rbac.js';
import { TEST_ACCOUNTS } from './test-accounts.js';

async function ensureUser(
  client: pg.PoolClient,
  u: { name: string; email: string; password: string; userType: 'internal' | 'external'; companyId?: string | null; roles: RoleKey[] },
): Promise<string> {
  const existing = await queryOne<{ id: string }>(`SELECT id FROM users WHERE lower(email) = lower($1)`, [u.email], client);
  if (existing) return existing.id;
  const row = await queryOne<{ id: string }>(
    `INSERT INTO users (name, email, password_hash, user_type, company_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [u.name, u.email, await hashPassword(u.password), u.userType, u.companyId ?? null],
    client,
  );
  for (const key of u.roles) {
    await client.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE key = $2 ON CONFLICT DO NOTHING`, [row!.id, key]);
  }
  return row!.id;
}

async function ensure(client: pg.PoolClient, table: 'categories' | 'systems', name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const slug = slugify(name);
  const existing = await queryOne<{ id: string }>(`SELECT id FROM ${table} WHERE slug = $1`, [slug], client);
  if (existing) return existing.id;
  const cols = ['name', 'slug', ...Object.keys(extra)];
  const vals = [name, slug, ...Object.values(extra)];
  const row = await queryOne<{ id: string }>(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    vals,
    client,
  );
  return row!.id;
}

async function ensureArticle(
  client: pg.PoolClient,
  a: {
    title: string;
    summary: string;
    html: string;
    categoryId: string;
    systemId: string;
    keywords: string[];
    visibility: 'internal' | 'external';
    status: 'draft' | 'published';
    authorId: string;
    tags?: string[];
  },
): Promise<void> {
  const slug = slugify(a.title);
  if (await queryOne(`SELECT 1 FROM articles WHERE slug = $1`, [slug], client)) return;
  const published = a.status === 'published';
  const row = await queryOne<{ id: string }>(
    `INSERT INTO articles (slug, title, summary, content_html, content_text, category_id, system_id, keywords, status, visibility,
                           author_id, updated_by, published_at, published_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12, $13) RETURNING id`,
    [slug, a.title, a.summary, a.html, htmlToText(a.html), a.categoryId, a.systemId, a.keywords, a.status, a.visibility, a.authorId,
      published ? new Date() : null, published ? a.authorId : null],
    client,
  );
  for (const tag of a.tags ?? []) {
    const t = await queryOne<{ id: string }>(
      `INSERT INTO tags (name, slug) VALUES ($1, $2) ON CONFLICT (slug) DO UPDATE SET name = tags.name RETURNING id`,
      [tag, slugify(tag, 60)],
      client,
    );
    await client.query(`INSERT INTO article_tags (article_id, tag_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [row!.id, t!.id]);
  }
  await client.query(
    `INSERT INTO article_versions (article_id, version, title, summary, content_html, content_text, category_id, system_id, keywords, tags, status, visibility, created_by)
     SELECT id, version, title, summary, content_html, content_text, category_id, system_id, keywords, $2, status, visibility, author_id FROM articles WHERE id = $1`,
    [row!.id, a.tags ?? []],
  );
  await client.query(
    `INSERT INTO article_history (article_id, user_id, operation, version, changes, summary) VALUES ($1, $2, 'create', 1, $3, 'Artigo criado (dados iniciais)')`,
    [row!.id, a.authorId, JSON.stringify({ title: { before: null, after: a.title } })],
  );
  if (published) {
    await client.query(
      `INSERT INTO article_history (article_id, user_id, operation, version, changes, summary) VALUES ($1, $2, 'publish', 1, $3, 'Artigo publicado (dados iniciais)')`,
      [row!.id, a.authorId, JSON.stringify({ status: { before: 'draft', after: 'published' } })],
    );
  }
  await reindexArticle(client, row!.id);
}

export interface SeedOptions {
  adminEmail: string;
  adminPassword: string;
  demo: boolean;
  demoPassword?: string;
  /** Cria interno@teste.com e externo@teste.com (senha em test-accounts.ts). */
  testUsers?: boolean;
}

export async function seed(opts: SeedOptions): Promise<void> {
  await syncRbac();
  await withTransaction(async (client) => {
    const adminId = await ensureUser(client, {
      name: 'Administrador',
      email: opts.adminEmail,
      password: opts.adminPassword,
      userType: 'internal',
      roles: ['admin'],
    });
    if (opts.testUsers) {
      const testCompany =
        (await queryOne<{ id: string }>(`SELECT id FROM companies WHERE lower(name) = lower('Empresa de Teste')`, [], client))?.id ??
        (await queryOne<{ id: string }>(`INSERT INTO companies (name) VALUES ('Empresa de Teste') RETURNING id`, [], client))!.id;
      await ensureUser(client, { name: 'Usuário Interno de Teste', email: TEST_ACCOUNTS[0].email, password: TEST_ACCOUNTS[0].password, userType: 'internal', roles: ['admin'] });
      await ensureUser(client, { name: 'Usuário Externo de Teste', email: TEST_ACCOUNTS[1].email, password: TEST_ACCOUNTS[1].password, userType: 'external', companyId: testCompany, roles: ['external'] });
    }
    if (!opts.demo) return;

    const pw = opts.demoPassword ?? 'Demo12345!';
    const companyId =
      (await queryOne<{ id: string }>(`SELECT id FROM companies WHERE lower(name) = lower('Empresa Exemplo Ltda')`, [], client))?.id ??
      (await queryOne<{ id: string }>(`INSERT INTO companies (name, document) VALUES ('Empresa Exemplo Ltda', '00.000.000/0001-00') RETURNING id`, [], client))!.id;

    const editorId = await ensureUser(client, { name: 'Edna Editora', email: 'editor@exemplo.com', password: pw, userType: 'internal', roles: ['editor'] });
    await ensureUser(client, { name: 'Paulo Publicador', email: 'publicador@exemplo.com', password: pw, userType: 'internal', roles: ['editor'] });
    await client.query(
      `INSERT INTO user_permissions (user_id, permission_key, effect, granted_by)
       SELECT id, 'articles.publish', 'grant', $1 FROM users WHERE email = 'publicador@exemplo.com' ON CONFLICT DO NOTHING`,
      [adminId],
    );
    await ensureUser(client, { name: 'Ana Autora', email: 'autor@exemplo.com', password: pw, userType: 'internal', roles: ['author'] });
    await ensureUser(client, { name: 'Sérgio Suporte', email: 'suporte@exemplo.com', password: pw, userType: 'internal', roles: ['support'] });
    await ensureUser(client, { name: 'Lia Leitora', email: 'leitor@exemplo.com', password: pw, userType: 'internal', roles: ['internal_reader'] });
    await ensureUser(client, { name: 'Carlos Cliente', email: 'cliente@exemplo.com', password: pw, userType: 'external', companyId, roles: ['external'] });
    await ensureUser(client, { name: 'Clara Cliente', email: 'cliente2@exemplo.com', password: pw, userType: 'external', companyId, roles: ['external'] });

    const catAcesso = await ensure(client, 'categories', 'Acesso e login', { description: 'Senhas, permissões e autenticação', icon: 'key', sort_order: 1 });
    const catRelatorios = await ensure(client, 'categories', 'Relatórios', { description: 'Geração e exportação de relatórios', icon: 'file-bar-chart', sort_order: 2 });
    const catFiscal = await ensure(client, 'categories', 'Fiscal', { description: 'Notas fiscais e obrigações', icon: 'receipt', sort_order: 3 });
    await ensure(client, 'categories', 'Integrações', { description: 'APIs e integrações com outros sistemas', icon: 'plug', sort_order: 4 });
    const sysErp = await ensure(client, 'systems', 'ERP LOGAE', { description: 'Sistema de gestão empresarial' });
    const sysPortal = await ensure(client, 'systems', 'Portal do Cliente', { description: 'Portal web para clientes' });
    await ensure(client, 'systems', 'App Mobile', { description: 'Aplicativo para celulares' });

    await client.query(
      `INSERT INTO search_synonyms (term, synonyms) VALUES ('lentidão', ARRAY['lento', 'demora', 'desempenho'])
       ON CONFLICT DO NOTHING`,
    );

    await ensureArticle(client, {
      title: 'Como exportar relatórios em PDF e Excel',
      summary: 'Passo a passo para exportar relatórios do ERP nos formatos PDF e Excel e o que fazer quando a exportação falhar.',
      html: `<h2>Visão geral</h2><p>Todos os relatórios do <strong>ERP LOGAE</strong> podem ser exportados em <strong>PDF</strong> ou <strong>Excel (XLSX)</strong>.</p>
<div data-callout="dica"><p>Use filtros de período menores para gerar relatórios grandes com mais rapidez.</p></div>
<h2>Passo a passo</h2><ol><li><p>Acesse <em>Relatórios &gt; Gerenciais</em>.</p></li><li><p>Selecione o relatório e defina os filtros.</p></li><li><p>Clique em <strong>Exportar</strong> e escolha o formato.</p></li></ol>
<h2>Erro ao exportar relatório</h2><p>Se aparecer a mensagem <code>Falha na geração do arquivo</code>, verifique:</p>
<table><tbody><tr><th><p>Causa</p></th><th><p>Solução</p></th></tr><tr><td><p>Período muito grande</p></td><td><p>Reduza o período para no máximo 12 meses.</p></td></tr><tr><td><p>Bloqueador de pop-ups</p></td><td><p>Permita pop-ups para o endereço do ERP.</p></td></tr></tbody></table>
<div data-callout="atencao"><p>Relatórios com mais de 100 mil linhas devem ser exportados em Excel.</p></div>
<div data-video="" data-provider="youtube" data-youtube-id="M7lc1UVf-VE" data-caption="Vídeo demonstrativo da exportação de relatórios"></div>`,
      categoryId: catRelatorios,
      systemId: sysErp,
      keywords: ['exportar', 'relatório', 'pdf', 'excel', 'falha na geração'],
      visibility: 'external',
      status: 'published',
      authorId: editorId,
      tags: ['Relatórios', 'Exportação'],
    });
    await ensureArticle(client, {
      title: 'Redefinir senha de acesso ao Portal do Cliente',
      summary: 'Como recuperar o acesso ao Portal do Cliente quando a senha foi esquecida ou expirou.',
      html: `<p>Para redefinir sua senha:</p><ol><li><p>Na tela de login, clique em <strong>Esqueci minha senha</strong>.</p></li><li><p>Informe o e-mail cadastrado.</p></li><li><p>Abra o link recebido por e-mail em até 30 minutos e cadastre a nova senha.</p></li></ol>
<div data-callout="importante"><p>A nova senha deve ter pelo menos 10 caracteres, com letras e números.</p></div>
<div data-callout="info"><p>Se o e-mail não chegar, verifique a caixa de spam.</p></div>`,
      categoryId: catAcesso,
      systemId: sysPortal,
      keywords: ['senha', 'login', 'acesso', 'esqueci minha senha'],
      visibility: 'external',
      status: 'published',
      authorId: editorId,
      tags: ['Acesso'],
    });
    await ensureArticle(client, {
      title: 'Procedimento interno: reprocessar nota fiscal rejeitada',
      summary: 'Procedimento exclusivo da equipe de suporte para reprocessar notas fiscais rejeitadas pela SEFAZ.',
      html: `<div data-callout="alerta"><p>Procedimento interno. Não compartilhar com clientes.</p></div>
<p>Execute no servidor de integração:</p><pre><code class="language-bash">nfe-cli reprocessar --chave &lt;CHAVE&gt; --ambiente producao</code></pre>
<p>Depois, confirme o status em <em>Fiscal &gt; Monitor de NF-e</em>.</p>`,
      categoryId: catFiscal,
      systemId: sysErp,
      keywords: ['nota fiscal', 'rejeição', 'sefaz', 'reprocessar'],
      visibility: 'internal',
      status: 'published',
      authorId: editorId,
      tags: ['Fiscal'],
    });
    await ensureArticle(client, {
      title: 'Novo layout do relatório de vendas (rascunho)',
      summary: 'Rascunho em elaboração sobre o novo layout do relatório de vendas.',
      html: '<p>Conteúdo em elaboração.</p>',
      categoryId: catRelatorios,
      systemId: sysErp,
      keywords: ['vendas'],
      visibility: 'external',
      status: 'draft',
      authorId: editorId,
    });

    if (!(await queryOne(`SELECT 1 FROM announcements LIMIT 1`, [], client))) {
      const ann = await queryOne<{ id: string }>(
        `INSERT INTO announcements (title, content_html, content_text, category, visibility, status, author_id, published_at)
         VALUES ($1, $2, $3, 'manutencao', 'internal', 'published', $4, now()) RETURNING id`,
        [
          'Manutenção programada do ERP LOGAE',
          '<p>O ERP ficará indisponível no próximo domingo, das 02h às 04h, para atualização de infraestrutura. Avise os clientes que abrirem chamados.</p>',
          'O ERP ficará indisponível no próximo domingo, das 02h às 04h, para atualização de infraestrutura. Avise os clientes que abrirem chamados.',
          adminId,
        ],
        client,
      );
      await client.query(`INSERT INTO announcement_systems (announcement_id, system_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`, [ann!.id, sysErp, sysPortal]);
    }

    // Atualizações de exemplo (normalmente criadas pela integração com o Jira).
    if (!(await queryOne(`SELECT 1 FROM updates LIMIT 1`, [], client))) {
      const samples: Array<[string, string, string, string, 'internal' | 'external', string, string]> = [
        ['LOGAE-101', 'Exportação de relatórios em XLSX com filtros salvos', 'Agora é possível salvar filtros e exportar relatórios diretamente em XLSX.', 'v2026.10.1', 'external', 'Externo', sysErp],
        ['LOGAE-102', 'Novo layout do Portal do Cliente', 'Interface renovada com navegação simplificada e melhor desempenho em celulares.', 'v2026.10.1', 'external', 'Ambos', sysPortal],
        ['LOGAE-103', 'Ajuste interno no reprocessamento de NF-e', 'Correção no serviço de reprocessamento. Impacta somente a equipe de suporte.', 'v2026.10.1', 'internal', 'Interno', sysErp],
      ];
      for (const [key, title, desc, release, vis, aud, sys] of samples) {
        await client.query(
          `INSERT INTO updates (jira_key, jira_url, title, description_text, release, audience_raw, visibility, system_id, jira_status, completed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'Concluído', now() - interval '1 day')`,
          [key, `https://exemplo.atlassian.net/browse/${key}`, title, desc, release, aud, vis, sys],
        );
      }
    }
  });
}

