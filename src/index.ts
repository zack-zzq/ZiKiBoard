import { getAuthContext, handleCallback, handleLogin, handleLogout } from "./auth";
import { publicProviders } from "./config";
import {
  createComment,
  deleteComment,
  listComments,
  suggestMentions,
  toggleReaction,
  updateComment,
} from "./comments";
import { addCors, corsPreflight, HttpError, json } from "./http";
import { serveImage, uploadImage } from "./uploads";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return corsPreflight(request, env);
    }

    try {
      const response = await route(request, env, ctx);
      return addCors(response, request, env);
    } catch (error) {
      const response = error instanceof HttpError
        ? json({ error: { code: error.code, message: error.message } }, { status: error.status })
        : json({ error: { code: "internal_error", message: "Internal server error" } }, { status: 500 });
      if (!(error instanceof HttpError)) {
        console.error(JSON.stringify({ event: "unhandled_error", message: String(error) }));
      }
      return addCors(response, request, env);
    }
  },
};

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = normalizePath(url.pathname);

  if (path === "/api/health" && request.method === "GET") {
    return json({ ok: true });
  }

  if (path.startsWith("/media/") && (request.method === "GET" || request.method === "HEAD")) {
    return serveImage(env, decodeURIComponent(path.slice("/media/".length)), request.method === "GET");
  }

  if (path.startsWith("/api/auth/login/") && request.method === "GET") {
    return handleLogin(request, env, path.slice("/api/auth/login/".length));
  }

  if (path.startsWith("/api/auth/callback/") && request.method === "GET") {
    return handleCallback(request, env, path.slice("/api/auth/callback/".length));
  }

  const auth = await getAuthContext(request, env, ctx);

  if (path === "/api/config" && request.method === "GET") {
    return json({
      providers: publicProviders(env),
      user: auth.user,
      reactions: ["👍", "❤️", "😂", "🎉", "👀", "🚀"],
    });
  }

  if (path === "/api/me" && request.method === "GET") {
    return json({ user: auth.user });
  }

  if (path === "/api/auth/logout" && request.method === "POST") {
    return handleLogout(request, env);
  }

  const blogCommentsMatch = path.match(/^\/api\/blogs\/(.+)\/comments$/);
  if (blogCommentsMatch) {
    const blogId = decodeURIComponent(blogCommentsMatch[1]);
    if (request.method === "GET") {
      return listComments(request, env, auth.user, blogId);
    }
    if (request.method === "POST") {
      return createComment(request, env, auth.user, blogId);
    }
  }

  const mentionMatch = path.match(/^\/api\/blogs\/(.+)\/mentions$/);
  if (mentionMatch && request.method === "GET") {
    return suggestMentions(request, env, decodeURIComponent(mentionMatch[1]));
  }

  const commentMatch = path.match(/^\/api\/comments\/([^/]+)$/);
  if (commentMatch) {
    const commentId = decodeURIComponent(commentMatch[1]);
    if (request.method === "PATCH") {
      return updateComment(request, env, auth.user, commentId);
    }
    if (request.method === "DELETE") {
      return deleteComment(env, auth.user, commentId);
    }
  }

  const reactionMatch = path.match(/^\/api\/comments\/([^/]+)\/reactions$/);
  if (reactionMatch && request.method === "POST") {
    return toggleReaction(request, env, auth.user, decodeURIComponent(reactionMatch[1]));
  }

  if (path === "/api/uploads/images" && request.method === "POST") {
    return uploadImage(request, env, auth.user);
  }

  if (path.startsWith("/api/")) {
    return json({ error: { code: "not_found", message: "Route not found" } }, { status: 404 });
  }

  return env.ASSETS.fetch(request);
}

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}
