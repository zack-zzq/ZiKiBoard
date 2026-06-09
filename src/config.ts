import authProvidersConfig from "../config/auth-providers.json";
import { httpError, isRecord } from "./http";
import type { ProviderConfig, PublicProvider, RuntimeProvider } from "./types";

export function appOrigin(env: Env, request: Request): string {
  const configured = env.APP_ORIGIN.trim();
  if (configured) {
    return configured.replace(/\/$/, "");
  }
  const url = new URL(request.url);
  return url.origin;
}

export function sessionTtlSeconds(env: Env): number {
  const parsed = Number.parseInt(env.SESSION_TTL_SECONDS, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 60 * 60 * 24 * 30;
}

export function maxImageBytes(env: Env): number {
  const parsed = Number.parseInt(env.MAX_IMAGE_BYTES, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5 * 1024 * 1024;
}

export function publicProviders(env: Env): PublicProvider[] {
  return readProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    type: provider.type,
    configured: Boolean(resolveClientId(env, provider) && resolveClientSecret(env, provider)),
  }));
}

export function resolveProvider(env: Env, providerId: string): RuntimeProvider {
  const provider = readProviders().find((candidate) => candidate.id === providerId);
  if (!provider) {
    throw httpError(404, "provider_not_found", "Unknown auth provider");
  }
  const clientId = resolveClientId(env, provider);
  if (!clientId) {
    throw httpError(400, "provider_not_configured", "Provider clientId is not configured");
  }

  const clientSecret = resolveClientSecret(env, provider);
  if (!clientSecret) {
    throw httpError(400, "provider_not_configured", "Provider client secret is not configured");
  }

  return { config: provider, clientId, clientSecret };
}

function readProviders(): ProviderConfig[] {
  const raw: unknown = authProvidersConfig;
  if (!Array.isArray(raw)) {
    throw httpError(500, "invalid_auth_config", "config/auth-providers.json must be an array");
  }
  return raw.map(parseProvider);
}

function parseProvider(value: unknown): ProviderConfig {
  if (!isRecord(value)) {
    throw httpError(500, "invalid_auth_config", "Provider config must be an object");
  }

  const id = readRequiredString(value, "id");
  const name = readRequiredString(value, "name");
  const typeValue = value.type === undefined ? "oidc" : readRequiredString(value, "type");
  const type = typeValue === "github" ? "github" : "oidc";
  const scopes = Array.isArray(value.scopes)
    ? value.scopes.filter((scope): scope is string => typeof scope === "string")
    : undefined;

  return {
    id,
    name,
    type,
    clientId: readOptionalString(value, "clientId"),
    clientIdEnv: readOptionalString(value, "clientIdEnv"),
    clientSecret: readOptionalString(value, "clientSecret"),
    clientSecretEnv: readOptionalString(value, "clientSecretEnv"),
    issuer: readOptionalString(value, "issuer"),
    authorizationEndpoint: readOptionalString(value, "authorizationEndpoint"),
    tokenEndpoint: readOptionalString(value, "tokenEndpoint"),
    userinfoEndpoint: readOptionalString(value, "userinfoEndpoint"),
    jwksUri: readOptionalString(value, "jwksUri"),
    scopes,
  };
}

function readRequiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") {
    throw httpError(500, "invalid_auth_config", `${key} must be a string`);
  }
  return field.trim();
}

function readOptionalString(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.trim() ? field.trim() : undefined;
}

function resolveClientId(env: Env, provider: ProviderConfig): string | undefined {
  return provider.clientId ?? readDynamicEnv(env, provider.clientIdEnv);
}

function resolveClientSecret(env: Env, provider: ProviderConfig): string | undefined {
  return provider.clientSecret ?? readDynamicEnv(env, provider.clientSecretEnv);
}

function readDynamicEnv(env: Env, name: string | undefined): string | undefined {
  if (!name) {
    return undefined;
  }
  const dynamicEnv = env as unknown as Record<string, string | undefined>;
  return dynamicEnv[name];
}
