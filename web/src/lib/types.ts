import type { PermissionKey } from '@shared/permissions';

export interface Me {
  id: string;
  name: string;
  email: string;
  userType: 'internal' | 'external';
  company: { id: string; name: string } | null;
  roles: string[];
  permissions: PermissionKey[];
  csrfToken: string;
}

export interface AppConfig {
  appName: string;
  timezone: string;
  anonymousAccess: boolean;
  lock: { ttlSeconds: number; heartbeatSeconds: number };
  uploads: { maxImageMb: number; maxVideoMb: number; maxAttachmentMb: number; maxDocumentMb: number };
  docConversion: boolean;
  ai: { generative: boolean; semantic: boolean };
  ticketReopenWindowDays: number;
}

export interface Named {
  id: string;
  name: string;
}

export interface Taxonomy {
  categories: Array<Named & { slug: string; description: string | null; icon: string | null; sortOrder: number }>;
  systems: Array<Named & { slug: string; description: string | null; active: boolean }>;
  tags: Array<Named & { slug: string }>;
}

export interface Article {
  id: string;
  slug: string;
  title: string;
  summary: string;
  contentHtml: string;
  category: { id: string; name: string; slug: string } | null;
  system: { id: string; name: string } | null;
  keywords: string[];
  tags: Array<{ id: string; name: string; slug: string }>;
  status: 'draft' | 'published' | 'unpublished' | 'archived';
  visibility: 'internal' | 'external';
  author: Named;
  updatedBy: Named | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  publishedBy: Named | null;
  version: number;
  viewCount: number;
}

export interface LockState {
  locked: boolean;
  mine?: boolean;
  sameSession?: boolean;
  holder?: Named;
  acquiredAt?: string;
  expiresAt?: string;
}

export interface ArticleCapabilities {
  canEdit: boolean;
  canPublish: boolean;
  canUnpublish: boolean;
  canArchive: boolean;
  canUnarchive: boolean;
  canViewHistory: boolean;
  editBlockedReason: string | null;
}

export interface ArticleResponse {
  article: Article;
  related: Array<{ id: string; slug: string; title: string; summary: string; updatedAt: string }>;
  lock: LockState | null;
  capabilities: ArticleCapabilities;
  publicationErrors?: Record<string, string>;
}

export interface UploadedFile {
  id: string;
  url: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'video' | 'attachment' | 'document' | 'thumbnail';
  width: number | null;
  height: number | null;
  thumbnailUrl: string | null;
  thumbnailId: string | null;
}

export interface TicketSummary {
  id: string;
  protocol: string;
  title: string;
  status: string;
  statusLabel: string;
  priority: string;
  requestType: string;
  system: string;
  company: string;
  requester: string;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TimelineEntry {
  type: 'opened' | 'message' | 'event' | 'internal_note';
  id: string;
  kind?: string;
  eventType?: string;
  createdAt: string;
  author: { name: string; role?: string };
  body?: string;
  files?: UploadedFile[];
  from?: string | null;
  to?: string | null;
  data?: Record<string, unknown>;
  internal?: boolean;
}

export interface TicketDetail {
  id: string;
  protocol: string;
  title: string;
  description: string;
  requestType: string;
  category: Named | null;
  priority: string;
  status: string;
  statusLabel: string;
  system: Named;
  company: Named;
  requester: Named & { email?: string };
  assignee: Named | null;
  analysisResult: string | null;
  procedures: string | null;
  solution: string | null;
  guidance: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
  relatedArticles: Array<{ id: string; slug: string; title: string }>;
  timeline: TimelineEntry[];
  mode: 'customer' | 'support';
  permissions: { canSupport: boolean; isCustomer: boolean };
}

export interface ChatSource {
  type: 'article' | 'document';
  id: string;
  title: string;
  url: string;
  excerpt: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  steps?: string[];
  foundSolution?: boolean | null;
  mode?: string | null;
  followUpQuestion?: string | null;
  sources?: ChatSource[];
  createdAt?: string;
}
