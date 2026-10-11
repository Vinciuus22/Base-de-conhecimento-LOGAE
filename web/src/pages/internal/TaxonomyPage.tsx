import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderTree, Plus, Trash2 } from 'lucide-react';
import { del, errorMessage, get, post, put } from '../../lib/api';
import type { Taxonomy } from '../../lib/types';
import { PageHeader } from '../../components/Layout';
import { Alert, Button, ConfirmDialog, Field, Modal, Spinner, TagInput, useToast } from '../../components/ui';

type Kind = 'categories' | 'systems' | 'tags';

export function TaxonomyPage() {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState<Kind | 'synonyms'>('categories');
  const [editing, setEditing] = useState<{ kind: Kind; id?: string; name: string; description?: string | null; active?: boolean; sortOrder?: number } | null>(null);
  const [removing, setRemoving] = useState<{ kind: Kind | 'search-synonyms'; id: string; name: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syn, setSyn] = useState<{ term: string; synonyms: string[] }>({ term: '', synonyms: [] });
  const taxonomy = useQuery({ queryKey: ['taxonomy'], queryFn: () => get<Taxonomy>('/api/taxonomy') });
  const synonyms = useQuery({ queryKey: ['synonyms'], queryFn: () => get<{ items: Array<{ id: string; term: string; synonyms: string[] }> }>('/api/search-synonyms'), enabled: tab === 'synonyms' });

  const reload = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['taxonomy'] }), queryClient.invalidateQueries({ queryKey: ['synonyms'] })]);

  const save = async () => {
    if (!editing) return;
    setError(null);
    try {
      const body =
        editing.kind === 'categories'
          ? { name: editing.name, description: editing.description || null, sortOrder: editing.sortOrder ?? 0 }
          : editing.kind === 'systems'
            ? { name: editing.name, description: editing.description || null, active: editing.active ?? true }
            : { name: editing.name };
      if (editing.id) await put(`/api/${editing.kind}/${editing.id}`, body);
      else await post(`/api/${editing.kind}`, body);
      toast('success', 'Registro salvo.');
      setEditing(null);
      await reload();
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  if (taxonomy.isLoading || !taxonomy.data) return <Spinner />;
  const items: Array<{ id: string; name: string; description?: string | null; active?: boolean; sortOrder?: number }> = tab === 'synonyms' ? [] : taxonomy.data[tab];

  return (
    <div className="page">
      <PageHeader title="Categorias, sistemas e tags" subtitle="Organização dos artigos e termos alternativos da pesquisa." icon={<FolderTree size={24} aria-hidden />} />
      <div className="tabs" role="tablist">
        {(
          [
            ['categories', 'Categorias'],
            ['systems', 'Sistemas'],
            ['tags', 'Tags'],
            ['synonyms', 'Sinônimos da pesquisa'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>

      {tab !== 'synonyms' ? (
        <>
          <Button variant="primary" onClick={() => setEditing({ kind: tab, name: '', active: true })}>
            <Plus size={16} aria-hidden /> Adicionar
          </Button>
          <div className="card table-wrap" style={{ marginTop: 12 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>Nome</th>
                  {tab !== 'tags' && <th>Descrição</th>}
                  {tab === 'systems' && <th>Situação</th>}
                  <th />
                </tr>
              </thead>
              <tbody>
                {items.map((i) => (
                  <tr key={i.id}>
                    <td>{i.name}</td>
                    {tab !== 'tags' && <td className="small">{i.description ?? '—'}</td>}
                    {tab === 'systems' && <td>{i.active ? 'Ativo' : 'Inativo'}</td>}
                    <td className="btn-group">
                      {tab !== 'tags' && (
                        <Button size="sm" onClick={() => setEditing({ kind: tab, ...i })}>
                          Editar
                        </Button>
                      )}
                      <Button size="sm" onClick={() => setRemoving({ kind: tab, id: i.id, name: i.name })}>
                        <Trash2 size={14} aria-hidden /> Excluir
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <div className="grid grid-2" style={{ alignItems: 'start' }}>
          <div className="card card-body stack">
            <strong>Novo grupo de termos</strong>
            <Field label="Termo" htmlFor="syn-term">
              <input id="syn-term" className="input" value={syn.term} onChange={(e) => setSyn({ ...syn, term: e.target.value })} placeholder="ex.: lentidão" />
            </Field>
            <Field label="Termos alternativos" htmlFor="syn-list" hint="Enter ou vírgula para adicionar.">
              <TagInput id="syn-list" value={syn.synonyms} onChange={(v) => setSyn({ ...syn, synonyms: v })} placeholder="ex.: lento, demora" />
            </Field>
            {error && <Alert kind="danger">{error}</Alert>}
            <Button
              variant="primary"
              disabled={!syn.term.trim() || !syn.synonyms.length}
              onClick={async () => {
                setError(null);
                try {
                  await post('/api/search-synonyms', syn);
                  setSyn({ term: '', synonyms: [] });
                  toast('success', 'Sinônimos cadastrados.');
                  await reload();
                } catch (err) {
                  setError(errorMessage(err));
                }
              }}
            >
              Adicionar
            </Button>
          </div>
          <div className="card">
            <ul className="article-list">
              {synonyms.data?.items.map((s) => (
                <li key={s.id} className="row">
                  <span style={{ flex: 1 }}>
                    <strong>{s.term}</strong> → {s.synonyms.join(', ')}
                  </span>
                  <Button size="sm" onClick={() => setRemoving({ kind: 'search-synonyms', id: s.id, name: s.term })} aria-label={`Excluir ${s.term}`}>
                    <Trash2 size={14} aria-hidden />
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {editing && (
        <Modal
          title={editing.id ? 'Editar' : 'Adicionar'}
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Cancelar</Button>
              <Button variant="primary" onClick={save} disabled={editing.name.trim().length < 2}>
                Salvar
              </Button>
            </>
          }
        >
          <div className="stack">
            <Field label="Nome" htmlFor="tx-name" required>
              <input id="tx-name" className="input" value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
            </Field>
            {editing.kind !== 'tags' && (
              <Field label="Descrição" htmlFor="tx-desc">
                <input id="tx-desc" className="input" value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} />
              </Field>
            )}
            {editing.kind === 'categories' && (
              <Field label="Ordem de exibição" htmlFor="tx-order">
                <input id="tx-order" type="number" min={0} className="input" value={editing.sortOrder ?? 0} onChange={(e) => setEditing({ ...editing, sortOrder: Number(e.target.value) })} />
              </Field>
            )}
            {editing.kind === 'systems' && (
              <label className="checkbox">
                <input type="checkbox" checked={editing.active ?? true} onChange={(e) => setEditing({ ...editing, active: e.target.checked })} /> Ativo
              </label>
            )}
            {error && <Alert kind="danger">{error}</Alert>}
          </div>
        </Modal>
      )}
      {removing && (
        <ConfirmDialog
          title="Excluir registro"
          message={`Excluir “${removing.name}”? Itens em uso não podem ser excluídos.`}
          confirmLabel="Excluir"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            try {
              await del(`/api/${removing.kind}/${removing.id}`);
              toast('success', 'Registro excluído.');
              setRemoving(null);
              await reload();
            } catch (err) {
              throw new Error(errorMessage(err));
            }
          }}
        />
      )}
    </div>
  );
}
