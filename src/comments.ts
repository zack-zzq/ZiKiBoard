import { httpError, isoFromSeconds, nowSeconds, optionalStringField, parseJsonObject, requireUser, stringField } from "./http";
import type { CommentDto, CommentRow, ReactionDto, User } from "./types";

interface ReactionRow {
  comment_id: string;
  emoji: string;
  count: number;
  reacted: number;
}

interface MentionRow {
  id: string;
  handle: string;
  display_name: string;
  avatar_url: string | null;
}

const BLOG_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}_.:/-]{0,190}$/u;
const ALLOWED_REACTIONS = new Set(["👍", "❤️", "😂", "🎉", "👀", "🚀"]);

export async function listComments(request: Request, env: Env, user: User | null, blogId: string): Promise<Response> {
  validateBlogId(blogId);
  const url = new URL(request.url);
  const limit = clamp(Number.parseInt(url.searchParams.get("limit") ?? "200", 10), 1, 500);
  const rows = await env.DB.prepare(
    `SELECT c.id, c.blog_id, c.parent_id, c.user_id, c.content_markdown, c.mentions_json,
            c.image_urls_json, c.deleted_at, c.created_at, c.updated_at,
            u.handle, u.display_name, u.avatar_url
     FROM comments c
     INNER JOIN users u ON u.id = c.user_id
     WHERE c.blog_id = ?
     ORDER BY c.created_at ASC
     LIMIT ?`,
  )
    .bind(blogId, limit)
    .all<CommentRow>();

  const reactions = await loadReactions(env, blogId, user?.id ?? "");
  const tree = buildCommentTree(rows.results, reactions);
  return Response.json({ comments: tree });
}

export async function createComment(request: Request, env: Env, currentUser: User | null, blogId: string): Promise<Response> {
  validateBlogId(blogId);
  const user = requireUser(currentUser);
  const body = await parseJsonObject(request);
  const content = stringField(body.contentMarkdown ?? body.content, "contentMarkdown", { min: 1, max: 5000 });
  const parentId = optionalStringField(body.parentId, "parentId", { max: 80 });
  const imageUrls = parseStringArray(body.imageUrls, "imageUrls", 10).filter(isAllowedImageUrl);
  const now = nowSeconds();

  if (parentId) {
    const parent = await env.DB.prepare(
      "SELECT id FROM comments WHERE id = ? AND blog_id = ? AND deleted_at IS NULL LIMIT 1",
    )
      .bind(parentId, blogId)
      .first();
    if (!parent) {
      throw httpError(404, "parent_not_found", "Parent comment was not found in this blog");
    }
  }

  const commentId = crypto.randomUUID();
  const mentions = extractMentions(content);
  await env.DB.prepare(
    `INSERT INTO comments
      (id, blog_id, parent_id, user_id, content_markdown, mentions_json, image_urls_json, deleted_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(commentId, blogId, parentId, user.id, content, JSON.stringify(mentions), JSON.stringify(imageUrls), now, now)
    .run();

  return Response.json({ id: commentId }, { status: 201 });
}

export async function updateComment(request: Request, env: Env, currentUser: User | null, commentId: string): Promise<Response> {
  const user = requireUser(currentUser);
  const body = await parseJsonObject(request);
  const content = stringField(body.contentMarkdown ?? body.content, "contentMarkdown", { min: 1, max: 5000 });
  const imageUrls = parseStringArray(body.imageUrls, "imageUrls", 10).filter(isAllowedImageUrl);
  const existing = await env.DB.prepare("SELECT user_id, deleted_at FROM comments WHERE id = ? LIMIT 1")
    .bind(commentId)
    .first<{ user_id: string; deleted_at: number | null }>();
  if (!existing || existing.deleted_at) {
    throw httpError(404, "comment_not_found", "Comment was not found");
  }
  if (existing.user_id !== user.id) {
    throw httpError(403, "forbidden", "Only the comment author can edit this comment");
  }
  await env.DB.prepare(
    "UPDATE comments SET content_markdown = ?, mentions_json = ?, image_urls_json = ?, updated_at = ? WHERE id = ?",
  )
    .bind(content, JSON.stringify(extractMentions(content)), JSON.stringify(imageUrls), nowSeconds(), commentId)
    .run();
  return Response.json({ ok: true });
}

export async function deleteComment(env: Env, currentUser: User | null, commentId: string): Promise<Response> {
  const user = requireUser(currentUser);
  const existing = await env.DB.prepare("SELECT user_id, deleted_at FROM comments WHERE id = ? LIMIT 1")
    .bind(commentId)
    .first<{ user_id: string; deleted_at: number | null }>();
  if (!existing || existing.deleted_at) {
    throw httpError(404, "comment_not_found", "Comment was not found");
  }
  if (existing.user_id !== user.id) {
    throw httpError(403, "forbidden", "Only the comment author can delete this comment");
  }
  await env.DB.prepare("UPDATE comments SET deleted_at = ?, updated_at = ? WHERE id = ?")
    .bind(nowSeconds(), nowSeconds(), commentId)
    .run();
  return Response.json({ ok: true });
}

export async function toggleReaction(
  request: Request,
  env: Env,
  currentUser: User | null,
  commentId: string,
): Promise<Response> {
  const user = requireUser(currentUser);
  const body = await parseJsonObject(request);
  const emoji = stringField(body.emoji, "emoji", { min: 1, max: 8 });
  if (!ALLOWED_REACTIONS.has(emoji)) {
    throw httpError(400, "invalid_emoji", "Emoji reaction is not supported");
  }
  const comment = await env.DB.prepare("SELECT id FROM comments WHERE id = ? AND deleted_at IS NULL LIMIT 1")
    .bind(commentId)
    .first();
  if (!comment) {
    throw httpError(404, "comment_not_found", "Comment was not found");
  }
  const existing = await env.DB.prepare(
    "SELECT comment_id FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ? LIMIT 1",
  )
    .bind(commentId, user.id, emoji)
    .first();
  if (existing) {
    await env.DB.prepare("DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?")
      .bind(commentId, user.id, emoji)
      .run();
    return Response.json({ active: false });
  }
  await env.DB.prepare("INSERT INTO comment_reactions (comment_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)")
    .bind(commentId, user.id, emoji, nowSeconds())
    .run();
  return Response.json({ active: true });
}

export async function suggestMentions(request: Request, env: Env, blogId: string): Promise<Response> {
  validateBlogId(blogId);
  const url = new URL(request.url);
  const query = `${(url.searchParams.get("q") ?? "").trim()}%`;
  const rows = await env.DB.prepare(
    `SELECT DISTINCT u.id, u.handle, u.display_name, u.avatar_url
     FROM users u
     INNER JOIN comments c ON c.user_id = u.id
     WHERE c.blog_id = ?
       AND c.deleted_at IS NULL
       AND (u.handle LIKE ? OR u.display_name LIKE ?)
     ORDER BY u.display_name ASC
     LIMIT 8`,
  )
    .bind(blogId, query, query)
    .all<MentionRow>();
  return Response.json({
    users: rows.results.map((row) => ({
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
      avatarUrl: row.avatar_url,
    })),
  });
}

function validateBlogId(blogId: string): void {
  if (!BLOG_ID_PATTERN.test(blogId)) {
    throw httpError(400, "invalid_blog_id", "Invalid blog id");
  }
}

async function loadReactions(env: Env, blogId: string, userId: string): Promise<Map<string, ReactionDto[]>> {
  const rows = await env.DB.prepare(
    `SELECT r.comment_id, r.emoji, COUNT(*) AS count,
            SUM(CASE WHEN r.user_id = ? THEN 1 ELSE 0 END) AS reacted
     FROM comment_reactions r
     INNER JOIN comments c ON c.id = r.comment_id
     WHERE c.blog_id = ?
     GROUP BY r.comment_id, r.emoji`,
  )
    .bind(userId, blogId)
    .all<ReactionRow>();
  const map = new Map<string, ReactionDto[]>();
  for (const row of rows.results) {
    const existing = map.get(row.comment_id) ?? [];
    existing.push({
      emoji: row.emoji,
      count: Number(row.count),
      reacted: Number(row.reacted) > 0,
    });
    map.set(row.comment_id, existing);
  }
  return map;
}

function buildCommentTree(rows: CommentRow[], reactions: Map<string, ReactionDto[]>): CommentDto[] {
  const byId = new Map<string, CommentDto>();
  const roots: CommentDto[] = [];
  for (const row of rows) {
    const deleted = row.deleted_at !== null;
    byId.set(row.id, {
      id: row.id,
      blogId: row.blog_id,
      parentId: row.parent_id,
      author: deleted
        ? null
        : {
            id: row.user_id,
            handle: row.handle,
            displayName: row.display_name,
            email: null,
            avatarUrl: row.avatar_url,
          },
      contentMarkdown: deleted ? "" : row.content_markdown,
      mentions: deleted ? [] : parseJsonArray(row.mentions_json),
      imageUrls: deleted ? [] : parseJsonArray(row.image_urls_json),
      deleted,
      createdAt: isoFromSeconds(row.created_at),
      updatedAt: isoFromSeconds(row.updated_at),
      reactions: reactions.get(row.id) ?? [],
      replies: [],
    });
  }
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)?.replies.push(node);
    } else {
      roots.push(node);
    }
  }
  return roots;
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseStringArray(value: unknown, field: string, maxItems: number): string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw httpError(400, "invalid_field", `${field} must be an array`);
  }
  if (value.length > maxItems) {
    throw httpError(400, "invalid_field", `${field} has too many items`);
  }
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function extractMentions(markdown: string): string[] {
  const matches = markdown.matchAll(/(^|\s)@([a-zA-Z0-9_-]{3,32})/g);
  return Array.from(new Set(Array.from(matches, (match) => match[2])));
}

function isAllowedImageUrl(value: string): boolean {
  try {
    const url = new URL(value, "https://example.invalid");
    return url.pathname.startsWith("/media/") || url.protocol === "https:";
  } catch {
    return false;
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return max;
  }
  return Math.min(Math.max(value, min), max);
}
