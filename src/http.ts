import type { User } from "./types";

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function noContent(init: ResponseInit = {}): Response {
  return new Response(null, { ...init, status: init.status ?? 204 });
}

export function httpError(status: number, code: string, message: string): HttpError {
  return new HttpError(status, code, message);
}

export async function parseJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw httpError(415, "unsupported_media_type", "Expected application/json");
  }
  const value = await request.json();
  if (!isRecord(value)) {
    throw httpError(400, "invalid_json", "Expected a JSON object");
  }
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readCookie(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) {
    return null;
  }
  for (const part of cookie.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) {
      return decodeURIComponent(rawValue.join("="));
    }
  }
  return null;
}

export function sessionCookie(
  name: string,
  value: string,
  requestUrl: URL,
  maxAgeSeconds: number,
  sameSite: string,
): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    `SameSite=${normalizeSameSite(sameSite)}`,
  ];
  if (shouldUseSecureCookie(requestUrl, sameSite)) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function clearSessionCookie(name: string, requestUrl: URL, sameSite: string): string {
  return sessionCookie(name, "", requestUrl, 0, sameSite);
}

export function addCors(response: Response, request: Request, env: Env): Response {
  const origin = request.headers.get("origin");
  if (!origin) {
    return response;
  }

  const allowed = parseCsv(env.CORS_ORIGINS);
  const allowOrigin = allowed.includes("*") || allowed.includes(origin) ? origin : null;
  if (!allowOrigin) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", allowOrigin);
  headers.set("access-control-allow-credentials", "true");
  headers.set("vary", appendVary(headers.get("vary"), "Origin"));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function corsPreflight(request: Request, env: Env): Response {
  const origin = request.headers.get("origin");
  const allowed = origin && (parseCsv(env.CORS_ORIGINS).includes("*") || parseCsv(env.CORS_ORIGINS).includes(origin));
  if (!allowed || !origin) {
    return noContent({ status: 204 });
  }
  return noContent({
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "content-type",
      "access-control-max-age": "86400",
      vary: "Origin",
    },
  });
}

export function requireUser(user: User | null): User {
  if (!user) {
    throw httpError(401, "unauthorized", "Authentication is required");
  }
  return user;
}

export function stringField(value: unknown, field: string, options: { min?: number; max?: number } = {}): string {
  if (typeof value !== "string") {
    throw httpError(400, "invalid_field", `${field} must be a string`);
  }
  const trimmed = value.trim();
  if (options.min !== undefined && trimmed.length < options.min) {
    throw httpError(400, "invalid_field", `${field} is too short`);
  }
  if (options.max !== undefined && trimmed.length > options.max) {
    throw httpError(400, "invalid_field", `${field} is too long`);
  }
  return trimmed;
}

export function optionalStringField(value: unknown, field: string, options: { max?: number } = {}): string | null {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  return stringField(value, field, { min: 1, max: options.max });
}

export function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isoFromSeconds(value: number): string {
  return new Date(value * 1000).toISOString();
}

function normalizeSameSite(value: string): string {
  const normalized = value.toLowerCase();
  if (normalized === "none") {
    return "None";
  }
  if (normalized === "strict") {
    return "Strict";
  }
  return "Lax";
}

function shouldUseSecureCookie(url: URL, sameSite: string): boolean {
  if (sameSite.toLowerCase() === "none") {
    return true;
  }
  return url.protocol === "https:" && url.hostname !== "localhost";
}

function appendVary(current: string | null, value: string): string {
  if (!current) {
    return value;
  }
  const parts = current.split(",").map((part) => part.trim().toLowerCase());
  return parts.includes(value.toLowerCase()) ? current : `${current}, ${value}`;
}
