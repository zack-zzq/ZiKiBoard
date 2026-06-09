export type ProviderType = "oidc" | "github";

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  clientId: string;
  clientSecret?: string;
  clientSecretEnv?: string;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  userinfoEndpoint?: string;
  jwksUri?: string;
  scopes?: string[];
}

export interface PublicProvider {
  id: string;
  name: string;
  type: ProviderType;
  configured: boolean;
}

export interface User {
  id: string;
  handle: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface AuthContext {
  user: User | null;
}

export interface CommentRow {
  id: string;
  blog_id: string;
  parent_id: string | null;
  user_id: string;
  content_markdown: string;
  mentions_json: string;
  image_urls_json: string;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}

export interface CommentDto {
  id: string;
  blogId: string;
  parentId: string | null;
  author: User | null;
  contentMarkdown: string;
  mentions: string[];
  imageUrls: string[];
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
  reactions: ReactionDto[];
  replies: CommentDto[];
}

export interface ReactionDto {
  emoji: string;
  count: number;
  reacted: boolean;
}

export interface RuntimeProvider {
  config: ProviderConfig;
  clientSecret: string;
}
