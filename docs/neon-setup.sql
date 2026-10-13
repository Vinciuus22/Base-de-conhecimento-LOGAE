--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)
-- Dumped by pg_dump version 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: pg_trgm; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;


--
-- Name: EXTENSION pg_trgm; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pg_trgm IS 'text similarity measurement and index searching based on trigrams';


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: unaccent; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS unaccent WITH SCHEMA public;


--
-- Name: EXTENSION unaccent; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION unaccent IS 'text search dictionary that removes accents';


--
-- Name: article_refresh_search_vector(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.article_refresh_search_vector(p_article uuid) RETURNS void
    LANGUAGE sql
    AS $$
  UPDATE articles a SET search_vector =
      setweight(to_tsvector('pt_unaccent', coalesce(a.title, '')), 'A')
   || setweight(to_tsvector('pt_unaccent', array_to_string(a.keywords, ' ')), 'B')
   || setweight(to_tsvector('pt_unaccent', coalesce((
        SELECT string_agg(t.name, ' ') FROM article_tags at JOIN tags t ON t.id = at.tag_id WHERE at.article_id = a.id
      ), '')), 'B')
   || setweight(to_tsvector('pt_unaccent', coalesce(a.summary, '')), 'B')
   || setweight(to_tsvector('pt_unaccent', coalesce((SELECT c.name FROM categories c WHERE c.id = a.category_id), '')
        || ' ' || coalesce((SELECT s.name FROM systems s WHERE s.id = a.system_id), '')), 'C')
   || setweight(to_tsvector('pt_unaccent', coalesce(a.content_text, '')), 'D')
  WHERE a.id = p_article;
$$;


--
-- Name: immutable_unaccent(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.immutable_unaccent(text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
    AS $_$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $_$;


--
-- Name: prevent_audit_mutation(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_audit_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'Registros de auditoria são imutáveis (tabela %)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END$$;


--
-- Name: pt_unaccent; Type: TEXT SEARCH CONFIGURATION; Schema: public; Owner: -
--

CREATE TEXT SEARCH CONFIGURATION public.pt_unaccent (
    PARSER = pg_catalog."default" );

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR asciiword WITH portuguese_stem;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR word WITH public.unaccent, portuguese_stem;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR numword WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR email WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR url WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR host WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR sfloat WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR version WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR hword_numpart WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR hword_part WITH public.unaccent, portuguese_stem;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR hword_asciipart WITH portuguese_stem;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR numhword WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR asciihword WITH portuguese_stem;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR hword WITH public.unaccent, portuguese_stem;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR url_path WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR file WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR "float" WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR "int" WITH simple;

ALTER TEXT SEARCH CONFIGURATION public.pt_unaccent
    ADD MAPPING FOR uint WITH simple;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: ai_conversations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_conversations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    anon_token_hash text,
    audience text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_conversations_audience_check CHECK ((audience = ANY (ARRAY['internal'::text, 'external'::text])))
);


--
-- Name: ai_message_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_message_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    message_id uuid NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    chunk_id uuid,
    title text NOT NULL,
    url text NOT NULL,
    excerpt text NOT NULL,
    CONSTRAINT ai_message_sources_source_type_check CHECK ((source_type = ANY (ARRAY['article'::text, 'document'::text])))
);


--
-- Name: ai_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id uuid NOT NULL,
    role text NOT NULL,
    content text NOT NULL,
    steps jsonb DEFAULT '[]'::jsonb NOT NULL,
    found_solution boolean,
    mode text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_messages_role_check CHECK ((role = ANY (ARRAY['user'::text, 'assistant'::text])))
);


--
-- Name: announcement_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcement_articles (
    announcement_id uuid NOT NULL,
    article_id uuid NOT NULL
);


--
-- Name: announcement_systems; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcement_systems (
    announcement_id uuid NOT NULL,
    system_id uuid NOT NULL
);


--
-- Name: announcements; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.announcements (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    content_html text DEFAULT ''::text NOT NULL,
    content_text text DEFAULT ''::text NOT NULL,
    category text NOT NULL,
    system_id uuid,
    visibility text DEFAULT 'internal'::text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    author_id uuid NOT NULL,
    published_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('public.pt_unaccent'::regconfig, COALESCE(title, ''::text)), 'A'::"char") || setweight(to_tsvector('public.pt_unaccent'::regconfig, COALESCE(content_text, ''::text)), 'D'::"char"))) STORED,
    CONSTRAINT announcements_category_check CHECK ((category = ANY (ARRAY['novidade'::text, 'alteracao'::text, 'manutencao'::text, 'comunicado'::text]))),
    CONSTRAINT announcements_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text]))),
    CONSTRAINT announcements_title_check CHECK ((length(TRIM(BOTH FROM title)) > 0)),
    CONSTRAINT announcements_visibility_check CHECK ((visibility = ANY (ARRAY['internal'::text, 'external'::text])))
);


--
-- Name: article_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_history (
    id bigint NOT NULL,
    article_id uuid NOT NULL,
    user_id uuid NOT NULL,
    operation text NOT NULL,
    version integer NOT NULL,
    changes jsonb DEFAULT '{}'::jsonb NOT NULL,
    summary text,
    result text DEFAULT 'success'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT article_history_result_check CHECK ((result = ANY (ARRAY['success'::text, 'failure'::text])))
);


--
-- Name: article_history_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.article_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: article_history_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.article_history_id_seq OWNED BY public.article_history.id;


--
-- Name: article_locks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_locks (
    article_id uuid NOT NULL,
    user_id uuid NOT NULL,
    session_id uuid,
    lock_token uuid NOT NULL,
    acquired_at timestamp with time zone DEFAULT now() NOT NULL,
    renewed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: article_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_reads (
    user_id uuid NOT NULL,
    article_id uuid NOT NULL,
    read_count integer DEFAULT 1 NOT NULL,
    last_read_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: article_tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_tags (
    article_id uuid NOT NULL,
    tag_id uuid NOT NULL
);


--
-- Name: article_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.article_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    article_id uuid NOT NULL,
    version integer NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    content_html text NOT NULL,
    content_text text NOT NULL,
    category_id uuid,
    system_id uuid,
    keywords text[] NOT NULL,
    tags text[] NOT NULL,
    status text NOT NULL,
    visibility text NOT NULL,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.articles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    title text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    content_html text DEFAULT ''::text NOT NULL,
    content_text text DEFAULT ''::text NOT NULL,
    category_id uuid,
    system_id uuid,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    visibility text NOT NULL,
    author_id uuid NOT NULL,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    published_at timestamp with time zone,
    published_by uuid,
    version integer DEFAULT 1 NOT NULL,
    view_count bigint DEFAULT 0 NOT NULL,
    search_vector tsvector,
    CONSTRAINT articles_published_complete CHECK (((status <> 'published'::text) OR ((category_id IS NOT NULL) AND (system_id IS NOT NULL) AND (length(TRIM(BOTH FROM summary)) > 0) AND (length(TRIM(BOTH FROM content_text)) > 0) AND (published_at IS NOT NULL) AND (published_by IS NOT NULL)))),
    CONSTRAINT articles_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text, 'unpublished'::text, 'archived'::text]))),
    CONSTRAINT articles_title_check CHECK ((length(TRIM(BOTH FROM title)) > 0)),
    CONSTRAINT articles_version_check CHECK ((version >= 1)),
    CONSTRAINT articles_visibility_check CHECK ((visibility = ANY (ARRAY['internal'::text, 'external'::text])))
);


--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_logs (
    id bigint NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    entity_type text,
    entity_id text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    ip text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.audit_logs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: audit_logs_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.audit_logs_id_seq OWNED BY public.audit_logs.id;


--
-- Name: categories; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.categories (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    icon text,
    sort_order integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT categories_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0))
);


--
-- Name: companies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.companies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    document text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT companies_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0))
);


--
-- Name: company_systems; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.company_systems (
    company_id uuid NOT NULL,
    system_id uuid NOT NULL
);


--
-- Name: content_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.content_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_type text NOT NULL,
    source_id uuid NOT NULL,
    chunk_index integer NOT NULL,
    heading text,
    content text NOT NULL,
    visibility text NOT NULL,
    available boolean DEFAULT false NOT NULL,
    embedding real[],
    embedding_model text,
    search_vector tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('public.pt_unaccent'::regconfig, COALESCE(heading, ''::text)), 'B'::"char") || setweight(to_tsvector('public.pt_unaccent'::regconfig, content), 'D'::"char"))) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT content_chunks_source_type_check CHECK ((source_type = ANY (ARRAY['article'::text, 'document'::text]))),
    CONSTRAINT content_chunks_visibility_check CHECK ((visibility = ANY (ARRAY['internal'::text, 'external'::text])))
);


--
-- Name: customer_integrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.customer_integrations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    company_id uuid NOT NULL,
    system_id uuid NOT NULL,
    objective text NOT NULL,
    description text NOT NULL,
    cs_gc_id uuid NOT NULL,
    operator_id uuid,
    status text DEFAULT 'inicio'::text NOT NULL,
    started_on date,
    expected_end_on date,
    finished_on date,
    next_action text,
    next_action_owner_id uuid,
    next_action_due date,
    next_action_notes text,
    notes text,
    result_summary text,
    final_notes text,
    remaining_pending text,
    finished_by uuid,
    archived_at timestamp with time zone,
    archived_by uuid,
    created_by uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    create_token uuid,
    CONSTRAINT customer_integrations_description_check CHECK ((length(TRIM(BOTH FROM description)) > 0)),
    CONSTRAINT customer_integrations_objective_check CHECK ((length(TRIM(BOTH FROM objective)) > 0)),
    CONSTRAINT customer_integrations_status_check CHECK ((status = ANY (ARRAY['inicio'::text, 'acompanhamento'::text, 'finalizado'::text])))
);


--
-- Name: document_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_articles (
    document_id uuid NOT NULL,
    article_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    file_id uuid NOT NULL,
    sha256 text NOT NULL,
    title text NOT NULL,
    category_id uuid,
    system_id uuid,
    keywords text[] DEFAULT '{}'::text[] NOT NULL,
    visibility text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    review_status text DEFAULT 'pending_review'::text NOT NULL,
    extracted_text text,
    page_count integer,
    warnings jsonb DEFAULT '[]'::jsonb NOT NULL,
    error_message text,
    attempts integer DEFAULT 0 NOT NULL,
    uploaded_by uuid NOT NULL,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    processed_at timestamp with time zone,
    removed_at timestamp with time zone,
    removed_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT documents_review_status_check CHECK ((review_status = ANY (ARRAY['pending_review'::text, 'approved'::text, 'rejected'::text]))),
    CONSTRAINT documents_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'processed'::text, 'processed_with_warnings'::text, 'failed'::text]))),
    CONSTRAINT documents_title_check CHECK ((length(TRIM(BOTH FROM title)) > 0)),
    CONSTRAINT documents_visibility_check CHECK ((visibility = ANY (ARRAY['internal'::text, 'external'::text])))
);


--
-- Name: files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    storage_key text NOT NULL,
    original_name text NOT NULL,
    mime_type text NOT NULL,
    size_bytes bigint NOT NULL,
    sha256 text NOT NULL,
    kind text NOT NULL,
    owner_type text,
    owner_id uuid,
    parent_file_id uuid,
    width integer,
    height integer,
    thumbnail_id uuid,
    uploaded_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    CONSTRAINT files_kind_check CHECK ((kind = ANY (ARRAY['image'::text, 'video'::text, 'attachment'::text, 'document'::text, 'thumbnail'::text]))),
    CONSTRAINT files_owner_type_check CHECK ((owner_type = ANY (ARRAY['article'::text, 'announcement'::text, 'ticket'::text, 'ticket_note'::text, 'document'::text, 'support_document'::text]))),
    CONSTRAINT files_size_bytes_check CHECK ((size_bytes >= 0))
);


--
-- Name: integration_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    integration_id uuid NOT NULL,
    type_id uuid NOT NULL,
    type_name text NOT NULL,
    description text NOT NULL,
    outcome text,
    next_action text,
    next_action_due date,
    author_id uuid NOT NULL,
    author_name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    edited_at timestamp with time zone,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT integration_activities_description_check CHECK ((length(TRIM(BOTH FROM description)) > 0))
);


--
-- Name: integration_activity_types; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_activity_types (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    CONSTRAINT integration_activity_types_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0))
);


--
-- Name: integration_changes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.integration_changes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    integration_id uuid NOT NULL,
    operation_id uuid NOT NULL,
    operation_type text NOT NULL,
    user_id uuid,
    user_name text NOT NULL,
    field_name text NOT NULL,
    old_value text,
    new_value text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: jira_card_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jira_card_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    card_id uuid NOT NULL,
    event_key text NOT NULL,
    jira_event_id text,
    event_type text NOT NULL,
    field_name text,
    from_value text,
    to_value text,
    comment_text text,
    comment_restricted boolean DEFAULT false NOT NULL,
    author_name text,
    author_account_id text,
    occurred_at timestamp with time zone NOT NULL,
    synced_at timestamp with time zone DEFAULT now() NOT NULL,
    summary text NOT NULL,
    source text DEFAULT 'sync'::text NOT NULL
);


--
-- Name: jira_cards; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jira_cards (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    jira_id text NOT NULL,
    card_key text NOT NULL,
    project_key text NOT NULL,
    project_name text,
    board_name text,
    title text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    status text,
    status_category text,
    priority text,
    issue_type text,
    assignee_name text,
    assignee_account_id text,
    reporter_name text,
    jira_created_at timestamp with time zone,
    jira_updated_at timestamp with time zone,
    url text,
    last_event_type text,
    last_event_author text,
    last_event_at timestamp with time zone,
    last_synced_at timestamp with time zone DEFAULT now() NOT NULL,
    history_complete boolean DEFAULT false NOT NULL,
    history_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: jira_sync_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jira_sync_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    finished_at timestamp with time zone,
    status text DEFAULT 'running'::text NOT NULL,
    cards_seen integer DEFAULT 0 NOT NULL,
    events_added integer DEFAULT 0 NOT NULL,
    error text,
    triggered_by uuid
);


--
-- Name: jira_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.jira_webhook_events (
    delivery_key text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    webhook_event text,
    card_key text,
    status text DEFAULT 'received'::text NOT NULL,
    error text
);


--
-- Name: permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.permissions (
    key text NOT NULL,
    label text NOT NULL,
    description text NOT NULL,
    internal_only boolean NOT NULL
);


--
-- Name: role_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.role_permissions (
    role_id uuid NOT NULL,
    permission_key text NOT NULL
);


--
-- Name: roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    name text NOT NULL,
    description text,
    user_type text NOT NULL,
    CONSTRAINT roles_user_type_check CHECK ((user_type = ANY (ARRAY['internal'::text, 'external'::text])))
);


--
-- Name: schema_migrations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.schema_migrations (
    name text NOT NULL,
    applied_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: search_synonyms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.search_synonyms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    term text NOT NULL,
    synonyms text[] DEFAULT '{}'::text[] NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    user_id uuid NOT NULL,
    csrf_token text NOT NULL,
    ip text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);


--
-- Name: support_documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    doc_type text NOT NULL,
    system_id uuid NOT NULL,
    visibility text NOT NULL,
    description text,
    external_url text,
    file_id uuid,
    author_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    deleted_by uuid,
    CONSTRAINT support_documents_check CHECK (((file_id IS NOT NULL) OR (external_url IS NOT NULL))),
    CONSTRAINT support_documents_doc_type_check CHECK ((doc_type = ANY (ARRAY['requisicao'::text, 'api'::text, 'pdf'::text, 'planilha'::text, 'outro'::text]))),
    CONSTRAINT support_documents_title_check CHECK ((length(TRIM(BOTH FROM title)) > 0)),
    CONSTRAINT support_documents_visibility_check CHECK ((visibility = ANY (ARRAY['internal'::text, 'external'::text])))
);


--
-- Name: systems; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.systems (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    description text,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT systems_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0))
);


--
-- Name: tags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tags_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0))
);


--
-- Name: ticket_articles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_articles (
    ticket_id uuid NOT NULL,
    article_id uuid NOT NULL,
    linked_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_attachments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_attachments (
    ticket_id uuid NOT NULL,
    file_id uuid NOT NULL,
    message_id uuid,
    note_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_events (
    id bigint NOT NULL,
    ticket_id uuid NOT NULL,
    actor_id uuid,
    type text NOT NULL,
    from_status text,
    to_status text,
    data jsonb DEFAULT '{}'::jsonb NOT NULL,
    public boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_events_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ticket_events_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: ticket_events_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.ticket_events_id_seq OWNED BY public.ticket_events.id;


--
-- Name: ticket_internal_notes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_internal_notes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    author_id uuid NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_internal_notes_body_check CHECK ((length(TRIM(BOTH FROM body)) > 0))
);


--
-- Name: ticket_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    author_id uuid NOT NULL,
    kind text NOT NULL,
    body text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ticket_messages_body_check CHECK ((length(TRIM(BOTH FROM body)) > 0)),
    CONSTRAINT ticket_messages_kind_check CHECK ((kind = ANY (ARRAY['customer_message'::text, 'support_reply'::text, 'info_request'::text, 'solution'::text])))
);


--
-- Name: ticket_protocol_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.ticket_protocol_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    protocol text NOT NULL,
    title text NOT NULL,
    description text NOT NULL,
    request_type text NOT NULL,
    category_id uuid,
    priority text DEFAULT 'medium'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    system_id uuid NOT NULL,
    company_id uuid NOT NULL,
    requester_id uuid NOT NULL,
    assignee_id uuid,
    analysis_result text,
    procedures text,
    solution text,
    guidance text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone,
    closed_at timestamp with time zone,
    search_vector tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('public.pt_unaccent'::regconfig, ((COALESCE(protocol, ''::text) || ' '::text) || COALESCE(title, ''::text))), 'A'::"char") || setweight(to_tsvector('public.pt_unaccent'::regconfig, COALESCE(description, ''::text)), 'D'::"char"))) STORED,
    CONSTRAINT tickets_description_check CHECK ((length(TRIM(BOTH FROM description)) > 0)),
    CONSTRAINT tickets_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'medium'::text, 'high'::text, 'critical'::text]))),
    CONSTRAINT tickets_request_type_check CHECK ((request_type = ANY (ARRAY['incident'::text, 'question'::text, 'request'::text, 'improvement'::text]))),
    CONSTRAINT tickets_status_check CHECK ((status = ANY (ARRAY['open'::text, 'triage'::text, 'in_progress'::text, 'waiting_user'::text, 'waiting_technical'::text, 'resolved'::text, 'closed'::text]))),
    CONSTRAINT tickets_title_check CHECK ((length(TRIM(BOTH FROM title)) > 0))
);


--
-- Name: updates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.updates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    jira_key text NOT NULL,
    jira_url text,
    title text NOT NULL,
    description_text text DEFAULT ''::text NOT NULL,
    release text NOT NULL,
    audience_raw text,
    visibility text NOT NULL,
    system_id uuid,
    jira_status text,
    completed_at timestamp with time zone,
    status text DEFAULT 'published'::text NOT NULL,
    manual_override boolean DEFAULT false NOT NULL,
    published_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    search_vector tsvector GENERATED ALWAYS AS ((setweight(to_tsvector('public.pt_unaccent'::regconfig, ((((COALESCE(jira_key, ''::text) || ' '::text) || COALESCE(title, ''::text)) || ' '::text) || COALESCE(release, ''::text))), 'A'::"char") || setweight(to_tsvector('public.pt_unaccent'::regconfig, COALESCE(description_text, ''::text)), 'D'::"char"))) STORED,
    CONSTRAINT updates_release_check CHECK ((length(TRIM(BOTH FROM release)) > 0)),
    CONSTRAINT updates_status_check CHECK ((status = ANY (ARRAY['published'::text, 'hidden'::text]))),
    CONSTRAINT updates_title_check CHECK ((length(TRIM(BOTH FROM title)) > 0)),
    CONSTRAINT updates_visibility_check CHECK ((visibility = ANY (ARRAY['internal'::text, 'external'::text])))
);


--
-- Name: user_company_access; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_company_access (
    user_id uuid NOT NULL,
    company_id uuid NOT NULL,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_permissions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_permissions (
    user_id uuid NOT NULL,
    permission_key text NOT NULL,
    effect text NOT NULL,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT user_permissions_effect_check CHECK ((effect = ANY (ARRAY['grant'::text, 'deny'::text])))
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    user_id uuid NOT NULL,
    role_id uuid NOT NULL,
    granted_by uuid,
    granted_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: users; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.users (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    user_type text NOT NULL,
    company_id uuid,
    active boolean DEFAULT true NOT NULL,
    anonymized_at timestamp with time zone,
    failed_logins integer DEFAULT 0 NOT NULL,
    locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_login_at timestamp with time zone,
    CONSTRAINT users_name_check CHECK ((length(TRIM(BOTH FROM name)) > 0)),
    CONSTRAINT users_user_type_check CHECK ((user_type = ANY (ARRAY['internal'::text, 'external'::text])))
);


--
-- Name: article_history id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_history ALTER COLUMN id SET DEFAULT nextval('public.article_history_id_seq'::regclass);


--
-- Name: audit_logs id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs ALTER COLUMN id SET DEFAULT nextval('public.audit_logs_id_seq'::regclass);


--
-- Name: ticket_events id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_events ALTER COLUMN id SET DEFAULT nextval('public.ticket_events_id_seq'::regclass);


--
-- Data for Name: ai_conversations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_message_sources; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ai_messages; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: announcement_articles; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: announcement_systems; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: announcements; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: article_history; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: article_locks; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: article_reads; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: article_tags; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: article_versions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: articles; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: audit_logs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: categories; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: companies; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.companies VALUES ('ca115447-00c7-48a2-b65a-a1e84eaa832e', 'Empresa de Teste', NULL, true, '2026-10-13 18:04:01.840785+00', '2026-10-13 18:04:01.840785+00');


--
-- Data for Name: company_systems; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: content_chunks; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: customer_integrations; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: document_articles; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: documents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: files; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: integration_activities; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: integration_activity_types; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.integration_activity_types VALUES ('69dc0b11-65e5-4bb0-9591-6f07c5952913', 'Reunião', true, 10);
INSERT INTO public.integration_activity_types VALUES ('c0c6a2d0-540e-4e63-854f-c1495595c3d3', 'Contato com o cliente', true, 20);
INSERT INTO public.integration_activity_types VALUES ('cf4e4acf-1d7a-4403-857a-9b60bfa50dbf', 'Atividade técnica', true, 30);
INSERT INTO public.integration_activity_types VALUES ('2aa76fc2-ee43-4c2b-8e6d-1f2ac6470cef', 'Configuração de sistema', true, 40);
INSERT INTO public.integration_activity_types VALUES ('2ba773e3-7efe-4b41-9525-ebc6fb6bc182', 'Teste de integração', true, 50);
INSERT INTO public.integration_activity_types VALUES ('1fb7c5d8-7276-4443-b04a-b14dee63f5db', 'Validação de dados', true, 60);
INSERT INTO public.integration_activity_types VALUES ('8f7d0135-0eca-4b4c-90d6-e7e7a1684778', 'Pendência identificada', true, 70);
INSERT INTO public.integration_activity_types VALUES ('6671f740-084c-4495-a331-db9b707aa589', 'Ação executada', true, 80);
INSERT INTO public.integration_activity_types VALUES ('1a476424-9ce0-4e37-aef3-7092373c7d3e', 'Decisão tomada', true, 90);
INSERT INTO public.integration_activity_types VALUES ('6aef34ec-7bc3-4951-8538-a595a53e4146', 'Próxima etapa', true, 100);
INSERT INTO public.integration_activity_types VALUES ('d9e0fc54-9dcd-4b53-a1e0-41578fa0aad7', 'Observação', true, 110);


--
-- Data for Name: integration_changes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: jira_card_events; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: jira_cards; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: jira_sync_runs; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: jira_webhook_events; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: permissions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.permissions VALUES ('articles.view_internal', 'Visualizar artigos internos', 'Consultar artigos e documentos classificados como internos.', true);
INSERT INTO public.permissions VALUES ('articles.create', 'Criar artigos', 'Criar novos artigos e salvar rascunhos.', true);
INSERT INTO public.permissions VALUES ('articles.edit', 'Editar artigos', 'Editar os próprios artigos.', true);
INSERT INTO public.permissions VALUES ('articles.edit_others', 'Editar artigos de outros autores', 'Editar artigos criados por outros usuários.', true);
INSERT INTO public.permissions VALUES ('articles.publish', 'Publicar artigos', 'Publicar artigos e alterar artigos já publicados.', true);
INSERT INTO public.permissions VALUES ('articles.unpublish', 'Despublicar artigos', 'Retirar artigos de publicação.', true);
INSERT INTO public.permissions VALUES ('articles.archive', 'Arquivar artigos', 'Arquivar e restaurar artigos arquivados.', true);
INSERT INTO public.permissions VALUES ('articles.history', 'Consultar histórico de artigos', 'Visualizar o histórico de alterações e versões dos artigos.', true);
INSERT INTO public.permissions VALUES ('categories.manage', 'Gerenciar categorias', 'Gerenciar categorias, sistemas, tags e sinônimos de pesquisa.', true);
INSERT INTO public.permissions VALUES ('announcements.manage', 'Gerenciar comunicados', 'Cadastrar e publicar atualizações e comunicados.', true);
INSERT INTO public.permissions VALUES ('updates.manage', 'Gerenciar atualizações', 'Ocultar/exibir atualizações vindas do Jira, ajustar o público e sincronizar com o Jira.', true);
INSERT INTO public.permissions VALUES ('cards.view', 'Consultar atualizações dos cards', 'Consultar os cards do Jira monitorados e o histórico de alterações (somente leitura).', true);
INSERT INTO public.permissions VALUES ('cards.sync', 'Sincronizar cards do Jira', 'Solicitar a sincronização manual dos cards com o Jira.', true);
INSERT INTO public.permissions VALUES ('integrations.view', 'Consultar integrações', 'Consultar os cards de integração de clientes e as atividades.', true);
INSERT INTO public.permissions VALUES ('integrations.create', 'Criar integrações', 'Cadastrar novos cards de integração.', true);
INSERT INTO public.permissions VALUES ('integrations.edit', 'Editar integrações', 'Alterar os dados cadastrais dos cards.', true);
INSERT INTO public.permissions VALUES ('integrations.log', 'Registrar atividades', 'Adicionar registros ao histórico do acompanhamento.', true);
INSERT INTO public.permissions VALUES ('integrations.status', 'Alterar status', 'Alterar o status entre Início e Acompanhamento.', true);
INSERT INTO public.permissions VALUES ('integrations.finish', 'Finalizar integrações', 'Finalizar integrações e editar dados de finalização.', true);
INSERT INTO public.permissions VALUES ('integrations.reopen', 'Reabrir integrações', 'Reabrir integrações finalizadas.', true);
INSERT INTO public.permissions VALUES ('integrations.history', 'Consultar histórico de alterações', 'Consultar o histórico de alterações cadastrais.', true);
INSERT INTO public.permissions VALUES ('integrations.archive', 'Arquivar integrações', 'Arquivar e restaurar cards de integração.', true);
INSERT INTO public.permissions VALUES ('integrations.admin', 'Administrar integrações', 'Gerenciar tipos de atividade e corrigir/remover atividades de outros usuários.', true);
INSERT INTO public.permissions VALUES ('documents.manage', 'Gerenciar documentos', 'Importar, aprovar, reprocessar e remover documentos.', true);
INSERT INTO public.permissions VALUES ('users.manage', 'Gerenciar usuários', 'Gerenciar usuários, empresas, perfis e permissões.', true);
INSERT INTO public.permissions VALUES ('audit.view', 'Consultar auditoria', 'Consultar os registros de auditoria.', true);
INSERT INTO public.permissions VALUES ('locks.release', 'Liberar bloqueios de edição', 'Liberar bloqueios de edição abandonados.', true);
INSERT INTO public.permissions VALUES ('tickets.support', 'Atender tickets', 'Responder clientes, alterar status e registrar soluções nos tickets autorizados.', true);
INSERT INTO public.permissions VALUES ('tickets.manage', 'Administrar tickets', 'Consultar todos os tickets e atribuí-los a atendentes.', true);
INSERT INTO public.permissions VALUES ('tickets.view_company', 'Consultar tickets da empresa', 'Consultar os tickets abertos por outros usuários da mesma empresa.', false);


--
-- Data for Name: role_permissions; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'articles.view_internal');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'articles.create');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'articles.edit');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'articles.edit_others');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'articles.publish');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'articles.unpublish');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'articles.archive');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'articles.history');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'categories.manage');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'announcements.manage');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'updates.manage');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'cards.view');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'cards.sync');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'integrations.view');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'integrations.create');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'integrations.edit');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'integrations.log');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'integrations.status');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'integrations.finish');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'integrations.reopen');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'integrations.history');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'integrations.archive');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'integrations.admin');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'documents.manage');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'users.manage');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'audit.view');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'locks.release');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'tickets.support');
INSERT INTO public.role_permissions VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'tickets.manage');
INSERT INTO public.role_permissions VALUES ('a4b61bca-b7d3-418e-89cc-508998c481eb', 'articles.view_internal');
INSERT INTO public.role_permissions VALUES ('a4b61bca-b7d3-418e-89cc-508998c481eb', 'articles.create');
INSERT INTO public.role_permissions VALUES ('a4b61bca-b7d3-418e-89cc-508998c481eb', 'articles.edit');
INSERT INTO public.role_permissions VALUES ('a4b61bca-b7d3-418e-89cc-508998c481eb', 'articles.edit_others');
INSERT INTO public.role_permissions VALUES ('a4b61bca-b7d3-418e-89cc-508998c481eb', 'articles.history');
INSERT INTO public.role_permissions VALUES ('4dbb0a9d-7f24-4757-9061-4b14b3d941fb', 'articles.view_internal');
INSERT INTO public.role_permissions VALUES ('4dbb0a9d-7f24-4757-9061-4b14b3d941fb', 'articles.create');
INSERT INTO public.role_permissions VALUES ('4dbb0a9d-7f24-4757-9061-4b14b3d941fb', 'articles.edit');
INSERT INTO public.role_permissions VALUES ('4dbb0a9d-7f24-4757-9061-4b14b3d941fb', 'articles.history');
INSERT INTO public.role_permissions VALUES ('b0fef593-4bf8-4fa1-9965-bc2e8ce0bad3', 'articles.view_internal');
INSERT INTO public.role_permissions VALUES ('b0fef593-4bf8-4fa1-9965-bc2e8ce0bad3', 'tickets.support');
INSERT INTO public.role_permissions VALUES ('b0fef593-4bf8-4fa1-9965-bc2e8ce0bad3', 'cards.view');
INSERT INTO public.role_permissions VALUES ('0a3e84d8-c9fd-411a-9a9d-3179b2e14d29', 'articles.view_internal');
INSERT INTO public.role_permissions VALUES ('0a3e84d8-c9fd-411a-9a9d-3179b2e14d29', 'integrations.view');
INSERT INTO public.role_permissions VALUES ('0a3e84d8-c9fd-411a-9a9d-3179b2e14d29', 'integrations.create');
INSERT INTO public.role_permissions VALUES ('0a3e84d8-c9fd-411a-9a9d-3179b2e14d29', 'integrations.edit');
INSERT INTO public.role_permissions VALUES ('0a3e84d8-c9fd-411a-9a9d-3179b2e14d29', 'integrations.log');
INSERT INTO public.role_permissions VALUES ('0a3e84d8-c9fd-411a-9a9d-3179b2e14d29', 'integrations.status');
INSERT INTO public.role_permissions VALUES ('0a3e84d8-c9fd-411a-9a9d-3179b2e14d29', 'integrations.finish');
INSERT INTO public.role_permissions VALUES ('0a3e84d8-c9fd-411a-9a9d-3179b2e14d29', 'integrations.history');
INSERT INTO public.role_permissions VALUES ('7a00a484-e4ba-44f6-8337-cf9eb41e1fce', 'articles.view_internal');


--
-- Data for Name: roles; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.roles VALUES ('9e1f1df8-c1e8-430b-8529-16fd492f590e', 'admin', 'Administrador', 'Gerencia usuários, permissões, categorias e integrações; consulta auditoria.', 'internal');
INSERT INTO public.roles VALUES ('a4b61bca-b7d3-418e-89cc-508998c481eb', 'editor', 'Editor', 'Cria e edita artigos e mídias. Publica somente com a permissão específica.', 'internal');
INSERT INTO public.roles VALUES ('4dbb0a9d-7f24-4757-9061-4b14b3d941fb', 'author', 'Autor', 'Cria artigos e edita os próprios rascunhos.', 'internal');
INSERT INTO public.roles VALUES ('b0fef593-4bf8-4fa1-9965-bc2e8ce0bad3', 'support', 'Suporte técnico', 'Atende tickets, responde clientes e registra soluções.', 'internal');
INSERT INTO public.roles VALUES ('0a3e84d8-c9fd-411a-9a9d-3179b2e14d29', 'integrations', 'Integração de clientes', 'Acompanha integrações de clientes: cria, edita, registra atividades, altera status e finaliza.', 'internal');
INSERT INTO public.roles VALUES ('7a00a484-e4ba-44f6-8337-cf9eb41e1fce', 'internal_reader', 'Leitor interno', 'Consulta artigos autorizados, pesquisa e utiliza o chat com IA.', 'internal');
INSERT INTO public.roles VALUES ('08661c65-ec4b-44df-bd4c-ba9dda997ca8', 'external', 'Usuário externo', 'Consulta artigos externos, utiliza a IA e acompanha os próprios tickets.', 'external');


--
-- Data for Name: schema_migrations; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.schema_migrations VALUES ('001_initial_schema.sql', '2026-10-13 18:04:00.749011+00');
INSERT INTO public.schema_migrations VALUES ('002_updates_and_announcements.sql', '2026-10-13 18:04:00.920431+00');
INSERT INTO public.schema_migrations VALUES ('003_jira_cards.sql', '2026-10-13 18:04:00.931252+00');
INSERT INTO public.schema_migrations VALUES ('004_customer_integrations.sql', '2026-10-13 18:04:00.948936+00');
INSERT INTO public.schema_migrations VALUES ('005_public_announcements_and_reads.sql', '2026-10-13 18:04:00.976142+00');
INSERT INTO public.schema_migrations VALUES ('006_support_documents.sql', '2026-10-13 18:04:00.982313+00');
INSERT INTO public.schema_migrations VALUES ('007_company_access.sql', '2026-10-13 18:04:00.990658+00');


--
-- Data for Name: search_synonyms; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: sessions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: support_documents; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: systems; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: tags; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ticket_articles; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ticket_attachments; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ticket_events; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ticket_internal_notes; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: ticket_messages; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: tickets; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: updates; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: user_company_access; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: user_permissions; Type: TABLE DATA; Schema: public; Owner: -
--



--
-- Data for Name: user_roles; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.user_roles VALUES ('8abbabdd-6858-4bdd-8f66-7732beb16ec1', '9e1f1df8-c1e8-430b-8529-16fd492f590e', NULL, '2026-10-13 18:04:01.840785+00');
INSERT INTO public.user_roles VALUES ('a1866155-a5be-442a-a677-eeb9d4cec4fa', '9e1f1df8-c1e8-430b-8529-16fd492f590e', NULL, '2026-10-13 18:04:01.840785+00');
INSERT INTO public.user_roles VALUES ('084ed5ee-07cb-444b-9667-5957acb506f4', '08661c65-ec4b-44df-bd4c-ba9dda997ca8', NULL, '2026-10-13 18:04:01.840785+00');


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: -
--

INSERT INTO public.users VALUES ('8abbabdd-6858-4bdd-8f66-7732beb16ec1', 'Administrador', 'admin@exemplo.com', 'scrypt$32768$8$1$NWVRP15SPnSIffJCbtKZ3g==$GMi9P3dwip1Ex67ubvQujXEvsblCY60SYm13UeUPBwE75cjVlFKSka77rXINz30LVSaIh0c2jgmYzURs9RY1Aw==', 'internal', NULL, true, NULL, 0, NULL, '2026-10-13 18:04:01.840785+00', '2026-10-13 18:04:01.840785+00', NULL);
INSERT INTO public.users VALUES ('a1866155-a5be-442a-a677-eeb9d4cec4fa', 'Usuário Interno de Teste', 'interno@teste.com', 'scrypt$32768$8$1$nTLfDpgoGDqHHsElL0IAlw==$4Yoo3wq2tZIpqxPgK3kKc2rqw3PMuYNKqcVbBbX64mJbKY++re3PDqW4NeepW8yl1keQcxpTVqmwHfYCT6SI6w==', 'internal', NULL, true, NULL, 0, NULL, '2026-10-13 18:04:01.840785+00', '2026-10-13 18:04:01.840785+00', NULL);
INSERT INTO public.users VALUES ('084ed5ee-07cb-444b-9667-5957acb506f4', 'Usuário Externo de Teste', 'externo@teste.com', 'scrypt$32768$8$1$bPaiXTu7TJWOduEVjPm8yg==$ml/ZFdG9ZBM6MawTLf7X5KfcwlvZqventHOosxa0dm46ZHL7/NAUYhDEHSnEtN1HkIyR17GLsqcEas67y7rEGg==', 'external', 'ca115447-00c7-48a2-b65a-a1e84eaa832e', true, NULL, 0, NULL, '2026-10-13 18:04:01.840785+00', '2026-10-13 18:04:01.840785+00', NULL);


--
-- Name: article_history_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.article_history_id_seq', 1, false);


--
-- Name: audit_logs_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.audit_logs_id_seq', 1, false);


--
-- Name: ticket_events_id_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ticket_events_id_seq', 1, false);


--
-- Name: ticket_protocol_seq; Type: SEQUENCE SET; Schema: public; Owner: -
--

SELECT pg_catalog.setval('public.ticket_protocol_seq', 1, false);


--
-- Name: ai_conversations ai_conversations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_pkey PRIMARY KEY (id);


--
-- Name: ai_message_sources ai_message_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_message_sources
    ADD CONSTRAINT ai_message_sources_pkey PRIMARY KEY (id);


--
-- Name: ai_messages ai_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_pkey PRIMARY KEY (id);


--
-- Name: announcement_articles announcement_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_articles
    ADD CONSTRAINT announcement_articles_pkey PRIMARY KEY (announcement_id, article_id);


--
-- Name: announcement_systems announcement_systems_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_systems
    ADD CONSTRAINT announcement_systems_pkey PRIMARY KEY (announcement_id, system_id);


--
-- Name: announcements announcements_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_pkey PRIMARY KEY (id);


--
-- Name: article_history article_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_history
    ADD CONSTRAINT article_history_pkey PRIMARY KEY (id);


--
-- Name: article_locks article_locks_lock_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_locks
    ADD CONSTRAINT article_locks_lock_token_key UNIQUE (lock_token);


--
-- Name: article_locks article_locks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_locks
    ADD CONSTRAINT article_locks_pkey PRIMARY KEY (article_id);


--
-- Name: article_reads article_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_reads
    ADD CONSTRAINT article_reads_pkey PRIMARY KEY (user_id, article_id);


--
-- Name: article_tags article_tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_pkey PRIMARY KEY (article_id, tag_id);


--
-- Name: article_versions article_versions_article_id_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_versions
    ADD CONSTRAINT article_versions_article_id_version_key UNIQUE (article_id, version);


--
-- Name: article_versions article_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_versions
    ADD CONSTRAINT article_versions_pkey PRIMARY KEY (id);


--
-- Name: articles articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_pkey PRIMARY KEY (id);


--
-- Name: articles articles_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_slug_key UNIQUE (slug);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: categories categories_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_pkey PRIMARY KEY (id);


--
-- Name: categories categories_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.categories
    ADD CONSTRAINT categories_slug_key UNIQUE (slug);


--
-- Name: companies companies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.companies
    ADD CONSTRAINT companies_pkey PRIMARY KEY (id);


--
-- Name: company_systems company_systems_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_systems
    ADD CONSTRAINT company_systems_pkey PRIMARY KEY (company_id, system_id);


--
-- Name: content_chunks content_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_chunks
    ADD CONSTRAINT content_chunks_pkey PRIMARY KEY (id);


--
-- Name: content_chunks content_chunks_source_type_source_id_chunk_index_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.content_chunks
    ADD CONSTRAINT content_chunks_source_type_source_id_chunk_index_key UNIQUE (source_type, source_id, chunk_index);


--
-- Name: customer_integrations customer_integrations_create_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_integrations
    ADD CONSTRAINT customer_integrations_create_token_key UNIQUE (create_token);


--
-- Name: customer_integrations customer_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_integrations
    ADD CONSTRAINT customer_integrations_pkey PRIMARY KEY (id);


--
-- Name: document_articles document_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_articles
    ADD CONSTRAINT document_articles_pkey PRIMARY KEY (document_id, article_id);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: files files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_pkey PRIMARY KEY (id);


--
-- Name: files files_storage_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_storage_key_key UNIQUE (storage_key);


--
-- Name: integration_activities integration_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_activities
    ADD CONSTRAINT integration_activities_pkey PRIMARY KEY (id);


--
-- Name: integration_activity_types integration_activity_types_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_activity_types
    ADD CONSTRAINT integration_activity_types_pkey PRIMARY KEY (id);


--
-- Name: integration_changes integration_changes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_changes
    ADD CONSTRAINT integration_changes_pkey PRIMARY KEY (id);


--
-- Name: jira_card_events jira_card_events_card_id_event_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_card_events
    ADD CONSTRAINT jira_card_events_card_id_event_key_key UNIQUE (card_id, event_key);


--
-- Name: jira_card_events jira_card_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_card_events
    ADD CONSTRAINT jira_card_events_pkey PRIMARY KEY (id);


--
-- Name: jira_cards jira_cards_card_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_cards
    ADD CONSTRAINT jira_cards_card_key_key UNIQUE (card_key);


--
-- Name: jira_cards jira_cards_jira_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_cards
    ADD CONSTRAINT jira_cards_jira_id_key UNIQUE (jira_id);


--
-- Name: jira_cards jira_cards_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_cards
    ADD CONSTRAINT jira_cards_pkey PRIMARY KEY (id);


--
-- Name: jira_sync_runs jira_sync_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_sync_runs
    ADD CONSTRAINT jira_sync_runs_pkey PRIMARY KEY (id);


--
-- Name: jira_webhook_events jira_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_webhook_events
    ADD CONSTRAINT jira_webhook_events_pkey PRIMARY KEY (delivery_key);


--
-- Name: permissions permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.permissions
    ADD CONSTRAINT permissions_pkey PRIMARY KEY (key);


--
-- Name: role_permissions role_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_pkey PRIMARY KEY (role_id, permission_key);


--
-- Name: roles roles_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_key_key UNIQUE (key);


--
-- Name: roles roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.roles
    ADD CONSTRAINT roles_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (name);


--
-- Name: search_synonyms search_synonyms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.search_synonyms
    ADD CONSTRAINT search_synonyms_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_token_hash_key UNIQUE (token_hash);


--
-- Name: support_documents support_documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_documents
    ADD CONSTRAINT support_documents_pkey PRIMARY KEY (id);


--
-- Name: systems systems_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.systems
    ADD CONSTRAINT systems_pkey PRIMARY KEY (id);


--
-- Name: systems systems_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.systems
    ADD CONSTRAINT systems_slug_key UNIQUE (slug);


--
-- Name: tags tags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_pkey PRIMARY KEY (id);


--
-- Name: tags tags_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tags
    ADD CONSTRAINT tags_slug_key UNIQUE (slug);


--
-- Name: ticket_articles ticket_articles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_articles
    ADD CONSTRAINT ticket_articles_pkey PRIMARY KEY (ticket_id, article_id);


--
-- Name: ticket_attachments ticket_attachments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_pkey PRIMARY KEY (ticket_id, file_id);


--
-- Name: ticket_events ticket_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_events
    ADD CONSTRAINT ticket_events_pkey PRIMARY KEY (id);


--
-- Name: ticket_internal_notes ticket_internal_notes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_internal_notes
    ADD CONSTRAINT ticket_internal_notes_pkey PRIMARY KEY (id);


--
-- Name: ticket_messages ticket_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_messages
    ADD CONSTRAINT ticket_messages_pkey PRIMARY KEY (id);


--
-- Name: tickets tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_pkey PRIMARY KEY (id);


--
-- Name: tickets tickets_protocol_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_protocol_key UNIQUE (protocol);


--
-- Name: updates updates_jira_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.updates
    ADD CONSTRAINT updates_jira_key_key UNIQUE (jira_key);


--
-- Name: updates updates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.updates
    ADD CONSTRAINT updates_pkey PRIMARY KEY (id);


--
-- Name: user_company_access user_company_access_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_company_access
    ADD CONSTRAINT user_company_access_pkey PRIMARY KEY (user_id, company_id);


--
-- Name: user_permissions user_permissions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_pkey PRIMARY KEY (user_id, permission_key);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (user_id, role_id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: ai_conversations_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_conversations_user_idx ON public.ai_conversations USING btree (user_id);


--
-- Name: ai_message_sources_msg_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_message_sources_msg_idx ON public.ai_message_sources USING btree (message_id);


--
-- Name: ai_messages_conv_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_messages_conv_idx ON public.ai_messages USING btree (conversation_id, created_at);


--
-- Name: announcements_pub_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX announcements_pub_idx ON public.announcements USING btree (status, visibility, published_at DESC);


--
-- Name: announcements_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX announcements_search_idx ON public.announcements USING gin (search_vector);


--
-- Name: article_history_article_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX article_history_article_idx ON public.article_history USING btree (article_id, created_at DESC);


--
-- Name: article_history_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX article_history_user_idx ON public.article_history USING btree (user_id);


--
-- Name: article_locks_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX article_locks_expires_idx ON public.article_locks USING btree (expires_at);


--
-- Name: article_reads_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX article_reads_user_idx ON public.article_reads USING btree (user_id, read_count DESC, last_read_at DESC);


--
-- Name: article_tags_tag_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX article_tags_tag_idx ON public.article_tags USING btree (tag_id);


--
-- Name: articles_category_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX articles_category_idx ON public.articles USING btree (category_id);


--
-- Name: articles_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX articles_search_idx ON public.articles USING gin (search_vector);


--
-- Name: articles_status_vis_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX articles_status_vis_idx ON public.articles USING btree (status, visibility);


--
-- Name: articles_system_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX articles_system_idx ON public.articles USING btree (system_id);


--
-- Name: articles_title_trgm_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX articles_title_trgm_idx ON public.articles USING gin (public.immutable_unaccent(lower(title)) public.gin_trgm_ops);


--
-- Name: articles_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX articles_updated_idx ON public.articles USING btree (updated_at DESC);


--
-- Name: audit_logs_action_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_action_idx ON public.audit_logs USING btree (action);


--
-- Name: audit_logs_actor_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_actor_idx ON public.audit_logs USING btree (actor_id);


--
-- Name: audit_logs_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_created_idx ON public.audit_logs USING btree (created_at DESC);


--
-- Name: audit_logs_entity_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_logs_entity_idx ON public.audit_logs USING btree (entity_type, entity_id);


--
-- Name: companies_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX companies_name_uq ON public.companies USING btree (lower(name));


--
-- Name: content_chunks_avail_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_chunks_avail_idx ON public.content_chunks USING btree (available, visibility);


--
-- Name: content_chunks_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_chunks_search_idx ON public.content_chunks USING gin (search_vector);


--
-- Name: content_chunks_source_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX content_chunks_source_idx ON public.content_chunks USING btree (source_type, source_id);


--
-- Name: customer_integrations_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_integrations_company_idx ON public.customer_integrations USING btree (company_id);


--
-- Name: customer_integrations_cs_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_integrations_cs_idx ON public.customer_integrations USING btree (cs_gc_id);


--
-- Name: customer_integrations_next_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_integrations_next_due_idx ON public.customer_integrations USING btree (next_action_due) WHERE (next_action_due IS NOT NULL);


--
-- Name: customer_integrations_operator_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_integrations_operator_idx ON public.customer_integrations USING btree (operator_id);


--
-- Name: customer_integrations_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_integrations_status_idx ON public.customer_integrations USING btree (status);


--
-- Name: customer_integrations_system_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_integrations_system_idx ON public.customer_integrations USING btree (system_id);


--
-- Name: customer_integrations_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX customer_integrations_updated_idx ON public.customer_integrations USING btree (updated_at DESC);


--
-- Name: documents_sha_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX documents_sha_uq ON public.documents USING btree (sha256) WHERE (removed_at IS NULL);


--
-- Name: files_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_owner_idx ON public.files USING btree (owner_type, owner_id);


--
-- Name: files_uploader_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX files_uploader_idx ON public.files USING btree (uploaded_by) WHERE (owner_id IS NULL);


--
-- Name: integration_activities_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_activities_idx ON public.integration_activities USING btree (integration_id, created_at DESC);


--
-- Name: integration_activity_types_name_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX integration_activity_types_name_uq ON public.integration_activity_types USING btree (lower(name));


--
-- Name: integration_changes_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_changes_idx ON public.integration_changes USING btree (integration_id, created_at DESC);


--
-- Name: integration_changes_op_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX integration_changes_op_idx ON public.integration_changes USING btree (operation_id);


--
-- Name: jira_card_events_author_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_card_events_author_idx ON public.jira_card_events USING btree (author_name);


--
-- Name: jira_card_events_card_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_card_events_card_idx ON public.jira_card_events USING btree (card_id, occurred_at DESC);


--
-- Name: jira_card_events_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_card_events_time_idx ON public.jira_card_events USING btree (occurred_at DESC);


--
-- Name: jira_card_events_type_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_card_events_type_idx ON public.jira_card_events USING btree (event_type);


--
-- Name: jira_cards_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_cards_assignee_idx ON public.jira_cards USING btree (assignee_name);


--
-- Name: jira_cards_project_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_cards_project_idx ON public.jira_cards USING btree (project_key);


--
-- Name: jira_cards_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_cards_status_idx ON public.jira_cards USING btree (status);


--
-- Name: jira_cards_title_trgm; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_cards_title_trgm ON public.jira_cards USING gin (title public.gin_trgm_ops);


--
-- Name: jira_cards_updated_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_cards_updated_idx ON public.jira_cards USING btree (jira_updated_at DESC NULLS LAST);


--
-- Name: jira_sync_runs_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_sync_runs_started_idx ON public.jira_sync_runs USING btree (started_at DESC);


--
-- Name: jira_webhook_events_received_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX jira_webhook_events_received_idx ON public.jira_webhook_events USING btree (received_at DESC);


--
-- Name: search_synonyms_term_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX search_synonyms_term_uq ON public.search_synonyms USING btree (lower(public.immutable_unaccent(term)));


--
-- Name: sessions_expires_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_expires_idx ON public.sessions USING btree (expires_at);


--
-- Name: sessions_user_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX sessions_user_idx ON public.sessions USING btree (user_id);


--
-- Name: support_documents_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX support_documents_idx ON public.support_documents USING btree (created_at DESC) WHERE (deleted_at IS NULL);


--
-- Name: ticket_events_ticket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ticket_events_ticket_idx ON public.ticket_events USING btree (ticket_id, created_at);


--
-- Name: ticket_messages_ticket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ticket_messages_ticket_idx ON public.ticket_messages USING btree (ticket_id, created_at);


--
-- Name: ticket_notes_ticket_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ticket_notes_ticket_idx ON public.ticket_internal_notes USING btree (ticket_id, created_at);


--
-- Name: tickets_assignee_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tickets_assignee_idx ON public.tickets USING btree (assignee_id);


--
-- Name: tickets_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tickets_company_idx ON public.tickets USING btree (company_id, updated_at DESC);


--
-- Name: tickets_requester_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tickets_requester_idx ON public.tickets USING btree (requester_id, updated_at DESC);


--
-- Name: tickets_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tickets_search_idx ON public.tickets USING gin (search_vector);


--
-- Name: tickets_status_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX tickets_status_idx ON public.tickets USING btree (status);


--
-- Name: updates_list_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX updates_list_idx ON public.updates USING btree (status, visibility, completed_at DESC);


--
-- Name: updates_search_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX updates_search_idx ON public.updates USING gin (search_vector);


--
-- Name: updates_system_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX updates_system_idx ON public.updates USING btree (system_id);


--
-- Name: user_company_access_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX user_company_access_company_idx ON public.user_company_access USING btree (company_id);


--
-- Name: users_company_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX users_company_idx ON public.users USING btree (company_id);


--
-- Name: users_email_uq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX users_email_uq ON public.users USING btree (lower(email));


--
-- Name: article_history article_history_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER article_history_immutable BEFORE DELETE OR UPDATE ON public.article_history FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_mutation();


--
-- Name: article_versions article_versions_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER article_versions_immutable BEFORE DELETE OR UPDATE ON public.article_versions FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_mutation();


--
-- Name: audit_logs audit_logs_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER audit_logs_immutable BEFORE DELETE OR UPDATE ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_mutation();


--
-- Name: integration_changes integration_changes_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER integration_changes_immutable BEFORE DELETE OR UPDATE ON public.integration_changes FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_mutation();


--
-- Name: ticket_events ticket_events_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ticket_events_immutable BEFORE DELETE OR UPDATE ON public.ticket_events FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_mutation();


--
-- Name: ticket_messages ticket_messages_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ticket_messages_immutable BEFORE DELETE OR UPDATE ON public.ticket_messages FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_mutation();


--
-- Name: ticket_internal_notes ticket_notes_immutable; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER ticket_notes_immutable BEFORE DELETE OR UPDATE ON public.ticket_internal_notes FOR EACH ROW EXECUTE FUNCTION public.prevent_audit_mutation();


--
-- Name: ai_conversations ai_conversations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversations
    ADD CONSTRAINT ai_conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: ai_message_sources ai_message_sources_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_message_sources
    ADD CONSTRAINT ai_message_sources_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.ai_messages(id) ON DELETE CASCADE;


--
-- Name: ai_messages ai_messages_conversation_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_messages
    ADD CONSTRAINT ai_messages_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES public.ai_conversations(id) ON DELETE CASCADE;


--
-- Name: announcement_articles announcement_articles_announcement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_articles
    ADD CONSTRAINT announcement_articles_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES public.announcements(id) ON DELETE CASCADE;


--
-- Name: announcement_articles announcement_articles_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_articles
    ADD CONSTRAINT announcement_articles_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: announcement_systems announcement_systems_announcement_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_systems
    ADD CONSTRAINT announcement_systems_announcement_id_fkey FOREIGN KEY (announcement_id) REFERENCES public.announcements(id) ON DELETE CASCADE;


--
-- Name: announcement_systems announcement_systems_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcement_systems
    ADD CONSTRAINT announcement_systems_system_id_fkey FOREIGN KEY (system_id) REFERENCES public.systems(id) ON DELETE RESTRICT;


--
-- Name: announcements announcements_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: announcements announcements_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.announcements
    ADD CONSTRAINT announcements_system_id_fkey FOREIGN KEY (system_id) REFERENCES public.systems(id) ON DELETE RESTRICT;


--
-- Name: article_history article_history_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_history
    ADD CONSTRAINT article_history_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;


--
-- Name: article_history article_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_history
    ADD CONSTRAINT article_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id);


--
-- Name: article_locks article_locks_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_locks
    ADD CONSTRAINT article_locks_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: article_locks article_locks_session_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_locks
    ADD CONSTRAINT article_locks_session_id_fkey FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE SET NULL;


--
-- Name: article_locks article_locks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_locks
    ADD CONSTRAINT article_locks_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: article_reads article_reads_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_reads
    ADD CONSTRAINT article_reads_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: article_reads article_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_reads
    ADD CONSTRAINT article_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: article_tags article_tags_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: article_tags article_tags_tag_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_tags
    ADD CONSTRAINT article_tags_tag_id_fkey FOREIGN KEY (tag_id) REFERENCES public.tags(id) ON DELETE RESTRICT;


--
-- Name: article_versions article_versions_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_versions
    ADD CONSTRAINT article_versions_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE RESTRICT;


--
-- Name: article_versions article_versions_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.article_versions
    ADD CONSTRAINT article_versions_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: articles articles_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: articles articles_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE RESTRICT;


--
-- Name: articles articles_published_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_published_by_fkey FOREIGN KEY (published_by) REFERENCES public.users(id);


--
-- Name: articles articles_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_system_id_fkey FOREIGN KEY (system_id) REFERENCES public.systems(id) ON DELETE RESTRICT;


--
-- Name: articles articles_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.articles
    ADD CONSTRAINT articles_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES public.users(id);


--
-- Name: audit_logs audit_logs_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: company_systems company_systems_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_systems
    ADD CONSTRAINT company_systems_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: company_systems company_systems_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.company_systems
    ADD CONSTRAINT company_systems_system_id_fkey FOREIGN KEY (system_id) REFERENCES public.systems(id) ON DELETE CASCADE;


--
-- Name: customer_integrations customer_integrations_archived_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_integrations
    ADD CONSTRAINT customer_integrations_archived_by_fkey FOREIGN KEY (archived_by) REFERENCES public.users(id);


--
-- Name: customer_integrations customer_integrations_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_integrations
    ADD CONSTRAINT customer_integrations_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id);


--
-- Name: customer_integrations customer_integrations_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_integrations
    ADD CONSTRAINT customer_integrations_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.users(id);


--
-- Name: customer_integrations customer_integrations_cs_gc_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_integrations
    ADD CONSTRAINT customer_integrations_cs_gc_id_fkey FOREIGN KEY (cs_gc_id) REFERENCES public.users(id);


--
-- Name: customer_integrations customer_integrations_finished_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_integrations
    ADD CONSTRAINT customer_integrations_finished_by_fkey FOREIGN KEY (finished_by) REFERENCES public.users(id);


--
-- Name: customer_integrations customer_integrations_next_action_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_integrations
    ADD CONSTRAINT customer_integrations_next_action_owner_id_fkey FOREIGN KEY (next_action_owner_id) REFERENCES public.users(id);


--
-- Name: customer_integrations customer_integrations_operator_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_integrations
    ADD CONSTRAINT customer_integrations_operator_id_fkey FOREIGN KEY (operator_id) REFERENCES public.users(id);


--
-- Name: customer_integrations customer_integrations_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.customer_integrations
    ADD CONSTRAINT customer_integrations_system_id_fkey FOREIGN KEY (system_id) REFERENCES public.systems(id);


--
-- Name: document_articles document_articles_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_articles
    ADD CONSTRAINT document_articles_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: document_articles document_articles_document_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_articles
    ADD CONSTRAINT document_articles_document_id_fkey FOREIGN KEY (document_id) REFERENCES public.documents(id) ON DELETE CASCADE;


--
-- Name: documents documents_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE RESTRICT;


--
-- Name: documents documents_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE RESTRICT;


--
-- Name: documents documents_removed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_removed_by_fkey FOREIGN KEY (removed_by) REFERENCES public.users(id);


--
-- Name: documents documents_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES public.users(id);


--
-- Name: documents documents_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_system_id_fkey FOREIGN KEY (system_id) REFERENCES public.systems(id) ON DELETE RESTRICT;


--
-- Name: documents documents_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: files files_parent_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_parent_file_id_fkey FOREIGN KEY (parent_file_id) REFERENCES public.files(id) ON DELETE CASCADE;


--
-- Name: files files_thumbnail_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_thumbnail_id_fkey FOREIGN KEY (thumbnail_id) REFERENCES public.files(id) ON DELETE SET NULL;


--
-- Name: files files_uploaded_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.files
    ADD CONSTRAINT files_uploaded_by_fkey FOREIGN KEY (uploaded_by) REFERENCES public.users(id);


--
-- Name: integration_activities integration_activities_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_activities
    ADD CONSTRAINT integration_activities_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: integration_activities integration_activities_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_activities
    ADD CONSTRAINT integration_activities_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id);


--
-- Name: integration_activities integration_activities_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_activities
    ADD CONSTRAINT integration_activities_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.customer_integrations(id) ON DELETE RESTRICT;


--
-- Name: integration_activities integration_activities_type_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_activities
    ADD CONSTRAINT integration_activities_type_id_fkey FOREIGN KEY (type_id) REFERENCES public.integration_activity_types(id);


--
-- Name: integration_changes integration_changes_integration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_changes
    ADD CONSTRAINT integration_changes_integration_id_fkey FOREIGN KEY (integration_id) REFERENCES public.customer_integrations(id) ON DELETE RESTRICT;


--
-- Name: integration_changes integration_changes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.integration_changes
    ADD CONSTRAINT integration_changes_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: jira_card_events jira_card_events_card_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_card_events
    ADD CONSTRAINT jira_card_events_card_id_fkey FOREIGN KEY (card_id) REFERENCES public.jira_cards(id) ON DELETE CASCADE;


--
-- Name: jira_sync_runs jira_sync_runs_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.jira_sync_runs
    ADD CONSTRAINT jira_sync_runs_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: role_permissions role_permissions_permission_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES public.permissions(key) ON DELETE CASCADE;


--
-- Name: role_permissions role_permissions_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.role_permissions
    ADD CONSTRAINT role_permissions_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: support_documents support_documents_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_documents
    ADD CONSTRAINT support_documents_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: support_documents support_documents_deleted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_documents
    ADD CONSTRAINT support_documents_deleted_by_fkey FOREIGN KEY (deleted_by) REFERENCES public.users(id);


--
-- Name: support_documents support_documents_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_documents
    ADD CONSTRAINT support_documents_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id);


--
-- Name: support_documents support_documents_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_documents
    ADD CONSTRAINT support_documents_system_id_fkey FOREIGN KEY (system_id) REFERENCES public.systems(id);


--
-- Name: ticket_articles ticket_articles_article_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_articles
    ADD CONSTRAINT ticket_articles_article_id_fkey FOREIGN KEY (article_id) REFERENCES public.articles(id) ON DELETE CASCADE;


--
-- Name: ticket_articles ticket_articles_linked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_articles
    ADD CONSTRAINT ticket_articles_linked_by_fkey FOREIGN KEY (linked_by) REFERENCES public.users(id);


--
-- Name: ticket_articles ticket_articles_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_articles
    ADD CONSTRAINT ticket_articles_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_attachments ticket_attachments_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_file_id_fkey FOREIGN KEY (file_id) REFERENCES public.files(id) ON DELETE RESTRICT;


--
-- Name: ticket_attachments ticket_attachments_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_message_id_fkey FOREIGN KEY (message_id) REFERENCES public.ticket_messages(id);


--
-- Name: ticket_attachments ticket_attachments_note_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_note_id_fkey FOREIGN KEY (note_id) REFERENCES public.ticket_internal_notes(id);


--
-- Name: ticket_attachments ticket_attachments_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_attachments
    ADD CONSTRAINT ticket_attachments_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE RESTRICT;


--
-- Name: ticket_events ticket_events_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_events
    ADD CONSTRAINT ticket_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES public.users(id);


--
-- Name: ticket_events ticket_events_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_events
    ADD CONSTRAINT ticket_events_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE RESTRICT;


--
-- Name: ticket_internal_notes ticket_internal_notes_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_internal_notes
    ADD CONSTRAINT ticket_internal_notes_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: ticket_internal_notes ticket_internal_notes_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_internal_notes
    ADD CONSTRAINT ticket_internal_notes_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE RESTRICT;


--
-- Name: ticket_messages ticket_messages_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_messages
    ADD CONSTRAINT ticket_messages_author_id_fkey FOREIGN KEY (author_id) REFERENCES public.users(id);


--
-- Name: ticket_messages ticket_messages_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_messages
    ADD CONSTRAINT ticket_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.tickets(id) ON DELETE RESTRICT;


--
-- Name: tickets tickets_assignee_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_assignee_id_fkey FOREIGN KEY (assignee_id) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: tickets tickets_category_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_category_id_fkey FOREIGN KEY (category_id) REFERENCES public.categories(id) ON DELETE RESTRICT;


--
-- Name: tickets tickets_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;


--
-- Name: tickets tickets_requester_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_requester_id_fkey FOREIGN KEY (requester_id) REFERENCES public.users(id) ON DELETE RESTRICT;


--
-- Name: tickets tickets_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tickets
    ADD CONSTRAINT tickets_system_id_fkey FOREIGN KEY (system_id) REFERENCES public.systems(id) ON DELETE RESTRICT;


--
-- Name: updates updates_system_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.updates
    ADD CONSTRAINT updates_system_id_fkey FOREIGN KEY (system_id) REFERENCES public.systems(id) ON DELETE SET NULL;


--
-- Name: user_company_access user_company_access_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_company_access
    ADD CONSTRAINT user_company_access_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE CASCADE;


--
-- Name: user_company_access user_company_access_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_company_access
    ADD CONSTRAINT user_company_access_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id) ON DELETE SET NULL;


--
-- Name: user_company_access user_company_access_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_company_access
    ADD CONSTRAINT user_company_access_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_permissions user_permissions_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id);


--
-- Name: user_permissions user_permissions_permission_key_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_permission_key_fkey FOREIGN KEY (permission_key) REFERENCES public.permissions(key) ON DELETE CASCADE;


--
-- Name: user_permissions user_permissions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_permissions
    ADD CONSTRAINT user_permissions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_granted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES public.users(id);


--
-- Name: user_roles user_roles_role_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_role_id_fkey FOREIGN KEY (role_id) REFERENCES public.roles(id) ON DELETE RESTRICT;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;


--
-- Name: users users_company_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_company_id_fkey FOREIGN KEY (company_id) REFERENCES public.companies(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--


