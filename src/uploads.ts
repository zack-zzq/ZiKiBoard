import { appOrigin, maxImageBytes } from "./config";
import { httpError, nowSeconds, parseCsv, requireUser } from "./http";
import type { User } from "./types";

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

export async function uploadImage(request: Request, env: Env, currentUser: User | null): Promise<Response> {
  const user = requireUser(currentUser);
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    throw httpError(400, "missing_file", "Expected multipart field named file");
  }

  const allowedTypes = new Set(parseCsv(env.ALLOWED_IMAGE_TYPES));
  if (!allowedTypes.has(file.type)) {
    throw httpError(400, "unsupported_image_type", "Image type is not allowed");
  }
  const maxBytes = maxImageBytes(env);
  if (file.size <= 0 || file.size > maxBytes) {
    throw httpError(400, "image_too_large", "Image size is outside the allowed range");
  }

  const extension = EXTENSIONS[file.type] ?? "bin";
  const now = new Date();
  const key = [
    "uploads",
    user.id,
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    `${crypto.randomUUID()}.${extension}`,
  ].join("/");

  await env.IMAGES.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type,
      cacheControl: "public, max-age=31536000, immutable",
    },
    customMetadata: {
      userId: user.id,
      originalName: file.name.slice(0, 120),
    },
  });

  const publicUrl = `${appOrigin(env, request)}/media/${key}`;
  await env.DB.prepare(
    "INSERT INTO uploads (id, user_id, r2_key, public_url, content_type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(crypto.randomUUID(), user.id, key, publicUrl, file.type, file.size, nowSeconds())
    .run();

  return Response.json({ url: publicUrl, key, contentType: file.type, size: file.size }, { status: 201 });
}

export async function serveImage(env: Env, key: string, includeBody = true): Promise<Response> {
  if (!key || key.includes("..")) {
    throw httpError(400, "invalid_media_key", "Invalid media key");
  }
  const object = await env.IMAGES.get(key);
  if (!object) {
    throw httpError(404, "media_not_found", "Media object was not found");
  }
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", headers.get("cache-control") ?? "public, max-age=31536000, immutable");
  return new Response(includeBody ? object.body : null, { headers });
}
