# Relatório de testes e pendências

Ambiente de execução: Linux, Node.js 22, PostgreSQL 16.15, ffmpeg 6.1, Chromium (Playwright).

## Resumo

| Suíte | Ferramenta | Resultado |
|---|---|---|
| Backend — integração com PostgreSQL real e unitários | Vitest (`npm test -w server`) | **119/119 aprovados** (9 arquivos) |
| Frontend — unitários | Vitest + Testing Library (`npm test -w web`) | **5/5 aprovados** |
| Ponta a ponta no navegador | Playwright (`npm run e2e -w web`) | **8/8 aprovados** (desktop + celular) |
| Verificação de tipos | `tsc --noEmit` (backend e frontend) | Sem erros |
| Build de produção | esbuild + Vite; servidor iniciado a partir de `dist/` | Concluído; `/api/health` OK |
| Auditoria de dependências | `npm audit` | 1 alerta moderado sem correção (ver pendências) |

## Cobertura por critério de aceite

### 20.1 Permissões — `server/test/permissions.test.ts`
- Usuário sem permissão não publica; autor salva rascunho mas não publica.
- Usuário interno sem perfil não recebe permissões.
- Usuário externo não acessa editor, listagem interna, bloqueio, salvamento nem upload.
- Permissões internas gravadas para usuário externo não têm efeito.
- Artigos internos fora da pesquisa externa (anônimo e cliente); visíveis ao leitor interno.
- Artigos internos e rascunhos inacessíveis por URL direta (id e slug).
- CSRF e verificação de origem; operações administrativas bloqueadas sem permissão.
- Concessão/revogação auditadas com responsável; revogação com efeito imediato.
- Login inválido sem revelar existência do e-mail e sem registrar senha; troca de senha.
- E2E: usuário externo recebe “Acesso não autorizado” no ambiente interno; artigo interno inacessível sem login.

### 20.2 Pesquisa — `server/test/search.test.ts`
Título (com/sem acento, maiúsculas), conteúdo com destaque, palavras-chave, variações
(stemming e prefixo), relevância, campos exibidos, ausência de resultados, sugestões para
erro de digitação, sinônimos, filtros (categoria, sistema, período), exclusão de rascunhos
e internos para externos, e sugestões que não vazam termos internos. E2E: pesquisa na
página inicial com destaque.

### 20.3 Editor e vídeos — `articles.test.ts`, `files.test.ts`, `unit.test.ts`, E2E
Formatação rica preservada e conteúdo malicioso removido; preservação após salvar e
publicar; campos obrigatórios; vídeo do YouTube inválido descartado e vídeo enviado
mantido; pré-visualização sem publicar; regras de edição; despublicar/arquivar; tags.
Upload de imagem com miniatura, GIF, vídeo com miniatura automática (ffmpeg) e capa
manual, streaming com `Range`, rejeição de SVG/executável disfarçado, acesso a arquivos
conforme o artigo. Validação de 9 formatos de URL do YouTube e rejeição de domínios
falsos. E2E: criação com bloco “Atenção” aplicado pela barra de ferramentas,
pré-visualização, salvamento; player ampliado em modal com retorno do foco.

### 20.4 Histórico — `articles.test.ts`
Usuário, data/hora em UTC, versão e antes/depois; mudança de visibilidade; publicação,
despublicação e arquivamento; filtros por usuário, período e operação; versões e
comparação; restauração gerando nova versão sem apagar registros; imutabilidade no banco
(UPDATE/DELETE rejeitados); preservação após novo login e reinício do pool.

### 20.5 Bloqueio — `locks.test.ts` + E2E
Primeiro a adquirir edita; o segundo recebe o nome do responsável; **8 aquisições
simultâneas → exatamente 1 sucesso**; outra sessão do mesmo usuário também é bloqueada;
liberação ao concluir, cancelar e via `sendBeacon` (com token); renovação só pelo
detentor; expiração apenas após o fim do lease, com auditoria; sessão antiga não salva;
concorrência otimista (`VERSION_CONFLICT`); salvar sem bloqueio ou sem autorização é
rejeitado; publicar durante edição de terceiro é bloqueado; liberação administrativa com
motivo e auditoria. E2E com dois navegadores: mensagem “Este artigo está sendo editado
por Edna Editora desde …”, botão “Editar artigo” desabilitado, editor somente leitura,
liberação ao cancelar e aviso de disponibilidade para o segundo usuário.

### 20.6 Chat com IA — `ai.test.ts` + E2E
Com provedor simulado: resposta fundamentada com título, link e trecho; **o modelo
nunca recebe conteúdo interno ou rascunho no chat externo**; chat interno usa conteúdo
interno; IDs de fontes inventados e URLs descartados; ausência de solução sem chamar o
modelo e com oferta de ticket; rascunho de ticket apenas com texto do usuário e sem
abertura automática; modo de consulta sem chave; conversa protegida por token; auxílio na
descrição exige IA e autenticação; artigo despublicado deixa de ser usado. E2E: fontes
exibidas e oferta de ticket.

### 20.7 Tickets — `tickets.test.ts` + E2E
Bloqueios sem usuário, sistema, empresa, descrição e imagem/vídeo; anexos inválidos
(arquivo falso e mistura com texto) sem gravar nada; protocolo; vídeo aceito; listagem
com fechados, filtros e ordenação; acesso a terceiros negado (inclusive anexos) e
auditado; compartilhamento por empresa só com permissão; respostas, solicitação de
informações, retorno automático ao atendimento, solução, histórico de status com autor e
data; observações internas e seus anexos invisíveis ao cliente; transições inválidas;
reabertura com prazo; histórico preservado e imutável; escopo do suporte e da
administração; vínculo de artigos e sugestão de artigo. E2E: anexo obrigatório,
revisão, protocolo e “Meus tickets”.

### 20.8 Documentos — `documents.test.ts`
PDF e DOCX válidos com extração; não publicação automática; formato inválido; duplicidade;
visibilidade obrigatória e permissão; PDF sem texto (digitalizado) com mensagem clara;
arquivo corrompido e reprocessamento; indexação após aprovação e consulta pela IA
conforme visibilidade; bloqueio de documentos internos (metadados, arquivo e chat) para
externos; nova revisão ao tornar externo; remoção autorizada com auditoria; geração de
artigo vinculado.

## Problemas encontrados e corrigidos durante os testes

1. Parâmetro SQL sem tipo inferido quando o usuário tinha permissão ampla (listagem de
   artigos e fila de atendimento para administradores) — corrigido e coberto por teste.
2. TipTap 2 com alerta de segurança (GHSA-cp6q-959q-f8rh) — migrado para TipTap 3.31.
3. React Router 6 com alertas (GHSA-wrjc-x8rr-h8h6, GHSA-337j-9hxr-rhxg) — atualizado para 7.18.
4. Duas cópias do React no bundle — unificado no React 19.
5. Editor marcava “alterações não salvas” ao abrir (parágrafo final automático),
   impedindo cancelar sem confirmação — corrigido; detectado pelo teste E2E de bloqueio.
6. Chat combinava perguntas longas com a anterior, gerando fontes irrelevantes —
   continuação restrita a perguntas curtas.
7. Filtro de status vazio rejeitado pela API — tolerado.

## Pendências e limitações (não simuladas)

| Item | Situação |
|---|---|
| IA generativa (Claude) | Integração implementada com a SDK oficial; **não executada contra a API real** nesta sessão (sem `ANTHROPIC_API_KEY`). Testada com provedor simulado. Validar com a chave antes da produção |
| Pesquisa semântica (Voyage) | Implementada e opcional; não executada contra a API real (sem `VOYAGE_API_KEY`). Similaridade calculada na aplicação — adequada a milhares de trechos; para volumes maiores, migrar para `pgvector` |
| Armazenamento S3 | Implementado (upload, leitura, URL pré-assinada); **não testado** contra bucket real |
| Imagem Docker | `Dockerfile`/`docker-compose.yml` criados, mas **não construídos** (sem daemon Docker no ambiente) |
| YouTube | URLs, miniaturas e incorporação geradas e testadas; o carregamento real não pôde ser visto (rede do ambiente bloqueia o domínio) |
| Arquivo `.doc` | Conversão via LibreOffice implementada, desabilitada por padrão e sem teste automatizado |
| OCR | Não disponível: PDFs digitalizados geram falha com mensagem orientativa |
| Imagem de referência dos vídeos | Não recebida; layout feito conforme a descrição textual |
| Atualização do bloqueio | Por consulta periódica (8 s), não por WebSocket |
| Várias instâncias | Rate limit em memória por instância (usar Redis); fila de documentos em processo (a reivindicação no banco evita processamento duplicado) |
| Uploads não vinculados | Arquivos enviados no editor e nunca salvos não são removidos automaticamente (limpeza periódica pendente) |
| Notificações por e-mail | Não implementadas (tickets são acompanhados pela área “Meus tickets”) |
| Recuperação de senha por e-mail | Não implementada; redefinição feita pelo administrador (senha temporária) e troca em “Minha conta” |
| Bundle do frontend | ~1 MB (≈320 KB gzip); divisão por rotas (lazy loading) recomendada |
| `sprintf-js` (via `mammoth` → `argparse`) | Alerta moderado sem versão corrigida; usado apenas pela CLI do mammoth, não pelo caminho de extração da aplicação |
