import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { appOrigin, resolveProvider, sessionTtlSeconds } from "./config";
import { pkceChallenge, randomToken, sha256Hex } from "./crypto";
import {
  clearSessionCookie,
  httpError,
  isRecord,
  json,
  nowSeconds,
  readCookie,
  sessionCookie,
} from "./http";
import type { AuthContext, ProviderConfig, RuntimeProvider, User } from "./types";

interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
}

interface AuthState {
  providerId: string;
  redirectTo: string;
  nonce: string;
  codeVerifier: string;
  createdAt: number;
}

interface TokenResponse {
  access_token?: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface IdentityProfile {
  providerSubject: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
  preferredHandle: string;
  rawProfile: Record<string, unknown>;
}

interface AccountRow {
  user_id: string;
}

interface UserRow {
  id: string;
  handle: string;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
}

export async function handleLogin(request: Request, env: Env, providerId: string): Promise<Response> {
  const provider = resolveProvider(env, providerId);
  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken(48);
  const url = new URL(request.url);
  const redirectTo = safeRedirect(url.searchParams.get("redirect"), appOrigin(env, request));
  const stateValue: AuthState = {
    providerId,
    redirectTo,
    nonce,
    codeVerifier,
    createdAt: nowSeconds(),
  };

  await env.AUTH_CACHE.put(`auth_state:${state}`, JSON.stringify(stateValue), { expirationTtl: 600 });

  const redirectUri = `${appOrigin(env, request)}/api/auth/callback/${providerId}`;
  const authorizationUrl =
    provider.config.type === "github"
      ? await githubAuthorizationUrl(provider, redirectUri, state)
      : await oidcAuthorizationUrl(env, provider, redirectUri, state, nonce, codeVerifier);

  return Response.redirect(authorizationUrl.toString(), 302);
}

export async function handleCallback(request: Request, env: Env, providerId: string): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    throw httpError(400, "invalid_callback", "Missing OAuth callback code or state");
  }

  const stateRaw = await env.AUTH_CACHE.get(`auth_state:${state}`);
  await env.AUTH_CACHE.delete(`auth_state:${state}`);
  if (!stateRaw) {
    throw httpError(400, "invalid_state", "Login state is expired or invalid");
  }

  const authState = parseAuthState(stateRaw);
  if (authState.providerId !== providerId) {
    throw httpError(400, "invalid_state", "Login state provider mismatch");
  }

  const provider = resolveProvider(env, providerId);
  const redirectUri = `${appOrigin(env, request)}/api/auth/callback/${providerId}`;
  const profile =
    provider.config.type === "github"
      ? await resolveGithubProfile(provider, code, redirectUri)
      : await resolveOidcProfile(env, provider, code, redirectUri, authState);

  const user = await upsertUser(env, providerId, profile);
  const sessionToken = await createSession(env, user.id);
  const headers = new Headers({
    location: authState.redirectTo,
    "set-cookie": sessionCookie(
      env.SESSION_COOKIE_NAME,
      sessionToken,
      new URL(request.url),
      sessionTtlSeconds(env),
      env.COOKIE_SAME_SITE,
    ),
  });

  return new Response(null, { status: 302, headers });
}

export async function handleLogout(request: Request, env: Env): Promise<Response> {
  const token = readCookie(request, env.SESSION_COOKIE_NAME);
  if (token) {
    const sessionId = await sha256Hex(token);
    await env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
  }
  return json(
    { ok: true },
    {
      headers: {
        "set-cookie": clearSessionCookie(env.SESSION_COOKIE_NAME, new URL(request.url), env.COOKIE_SAME_SITE),
      },
    },
  );
}

export async function getAuthContext(request: Request, env: Env, ctx: ExecutionContext): Promise<AuthContext> {
  const token = readCookie(request, env.SESSION_COOKIE_NAME);
  if (!token) {
    return { user: null };
  }
  const sessionId = await sha256Hex(token);
  const now = nowSeconds();
  const row = await env.DB.prepare(
    `SELECT users.id, users.handle, users.display_name, users.email, users.avatar_url, sessions.expires_at
     FROM sessions
     INNER JOIN users ON users.id = sessions.user_id
     WHERE sessions.id = ?
     LIMIT 1`,
  )
    .bind(sessionId)
    .first<UserRow & { expires_at: number }>();

  if (!row) {
    return { user: null };
  }
  if (row.expires_at <= now) {
    ctx.waitUntil(env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run());
    return { user: null };
  }
  return {
    user: {
      id: row.id,
      handle: row.handle,
      displayName: row.display_name,
      email: row.email,
      avatarUrl: row.avatar_url,
    },
  };
}

async function oidcAuthorizationUrl(
  env: Env,
  provider: RuntimeProvider,
  redirectUri: string,
  state: string,
  nonce: string,
  codeVerifier: string,
): Promise<URL> {
  const discovery = await getOidcDiscovery(env, provider.config);
  const authorizationUrl = new URL(provider.config.authorizationEndpoint ?? discovery.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", provider.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", (provider.config.scopes ?? ["openid", "profile", "email"]).join(" "));
  authorizationUrl.searchParams.set("state", state);
  authorizationUrl.searchParams.set("nonce", nonce);
  authorizationUrl.searchParams.set("code_challenge", await pkceChallenge(codeVerifier));
  authorizationUrl.searchParams.set("code_challenge_method", "S256");
  return authorizationUrl;
}

async function githubAuthorizationUrl(provider: RuntimeProvider, redirectUri: string, state: string): Promise<URL> {
  const authorizationUrl = new URL("https://github.com/login/oauth/authorize");
  authorizationUrl.searchParams.set("client_id", provider.clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("scope", (provider.config.scopes ?? ["read:user", "user:email"]).join(" "));
  authorizationUrl.searchParams.set("state", state);
  return authorizationUrl;
}

async function resolveOidcProfile(
  env: Env,
  provider: RuntimeProvider,
  code: string,
  redirectUri: string,
  authState: AuthState,
): Promise<IdentityProfile> {
  const discovery = await getOidcDiscovery(env, provider.config);
  const token = await exchangeCode(provider, provider.config.tokenEndpoint ?? discovery.token_endpoint, code, redirectUri, {
    code_verifier: authState.codeVerifier,
  });
  if (!token.id_token) {
    throw httpError(502, "oidc_missing_id_token", "OIDC provider did not return an id_token");
  }

  const jwks = createRemoteJWKSet(new URL(provider.config.jwksUri ?? discovery.jwks_uri));
  const verified = await jwtVerify(token.id_token, jwks, {
    issuer: provider.config.issuer ?? discovery.issuer,
    audience: provider.clientId,
  });

  const claims = verified.payload;
  if (claims.nonce !== authState.nonce) {
    throw httpError(400, "invalid_nonce", "OIDC nonce mismatch");
  }
  if (!claims.sub) {
    throw httpError(502, "oidc_missing_subject", "OIDC id_token is missing sub");
  }

  const userinfo = token.access_token && (provider.config.userinfoEndpoint ?? discovery.userinfo_endpoint)
    ? await fetchUserinfo(provider.config.userinfoEndpoint ?? discovery.userinfo_endpoint ?? "", token.access_token)
    : {};
  const merged = { ...claims, ...userinfo };

  return {
    providerSubject: claims.sub,
    displayName: firstString(merged, ["name", "preferred_username", "email"]) ?? "OIDC User",
    email: firstString(merged, ["email"]) ?? null,
    avatarUrl: firstString(merged, ["picture", "avatar_url"]) ?? null,
    preferredHandle: firstString(merged, ["preferred_username", "email", "name"]) ?? claims.sub,
    rawProfile: normalizeProfile(merged),
  };
}

async function resolveGithubProfile(
  provider: RuntimeProvider,
  code: string,
  redirectUri: string,
): Promise<IdentityProfile> {
  const token = await exchangeCode(provider, "https://github.com/login/oauth/access_token", code, redirectUri, {});
  if (!token.access_token) {
    throw httpError(502, "github_missing_access_token", "GitHub did not return an access token");
  }

  const userResponse = await fetch("https://api.github.com/user", {
    headers: githubHeaders(token.access_token),
  });
  if (!userResponse.ok) {
    throw httpError(502, "github_userinfo_failed", "Failed to fetch GitHub user profile");
  }
  const userProfile = await userResponse.json();
  if (!isRecord(userProfile)) {
    throw httpError(502, "github_userinfo_invalid", "GitHub user profile response was invalid");
  }

  const email = firstString(userProfile, ["email"]) ?? (await fetchPrimaryGithubEmail(token.access_token));
  const login = firstString(userProfile, ["login"]);
  const id = userProfile.id;
  const subject = typeof id === "number" || typeof id === "string" ? String(id) : login;
  if (!subject) {
    throw httpError(502, "github_subject_missing", "GitHub user profile did not include an id");
  }

  return {
    providerSubject: subject,
    displayName: firstString(userProfile, ["name", "login"]) ?? "GitHub User",
    email,
    avatarUrl: firstString(userProfile, ["avatar_url"]) ?? null,
    preferredHandle: login ?? email ?? subject,
    rawProfile: normalizeProfile(userProfile),
  };
}

async function getOidcDiscovery(env: Env, provider: ProviderConfig): Promise<OidcDiscovery> {
  if (!provider.issuer && (!provider.authorizationEndpoint || !provider.tokenEndpoint || !provider.jwksUri)) {
    throw httpError(500, "invalid_auth_config", `OIDC provider ${provider.id} needs issuer or explicit endpoints`);
  }

  const cacheKey = `oidc_discovery:${provider.id}`;
  const cached = await env.AUTH_CACHE.get(cacheKey);
  if (cached) {
    return parseDiscovery(cached);
  }

  const discoveryUrl = provider.issuer
    ? `${provider.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`
    : "";
  const response = discoveryUrl ? await fetch(discoveryUrl) : null;
  if (!response?.ok) {
    if (provider.authorizationEndpoint && provider.tokenEndpoint && provider.jwksUri) {
      return {
        issuer: provider.issuer ?? "",
        authorization_endpoint: provider.authorizationEndpoint,
        token_endpoint: provider.tokenEndpoint,
        userinfo_endpoint: provider.userinfoEndpoint,
        jwks_uri: provider.jwksUri,
      };
    }
    throw httpError(502, "oidc_discovery_failed", "Failed to load OIDC discovery document");
  }

  const discovery = parseDiscovery(JSON.stringify(await response.json()));
  await env.AUTH_CACHE.put(cacheKey, JSON.stringify(discovery), { expirationTtl: 60 * 60 * 6 });
  return discovery;
}

async function exchangeCode(
  provider: RuntimeProvider,
  tokenEndpoint: string,
  code: string,
  redirectUri: string,
  extra: Record<string, string>,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    ...extra,
  });

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!response.ok) {
    throw httpError(502, "token_exchange_failed", "OAuth token exchange failed");
  }
  const value = await response.json();
  if (!isRecord(value)) {
    throw httpError(502, "token_response_invalid", "OAuth token response was invalid");
  }
  return {
    access_token: firstString(value, ["access_token"]) ?? undefined,
    id_token: firstString(value, ["id_token"]) ?? undefined,
    token_type: firstString(value, ["token_type"]) ?? undefined,
    expires_in: typeof value.expires_in === "number" ? value.expires_in : undefined,
  };
}

async function fetchUserinfo(endpoint: string, accessToken: string): Promise<Record<string, unknown>> {
  const response = await fetch(endpoint, {
    headers: {
      accept: "application/json",
      authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    return {};
  }
  const value = await response.json();
  return isRecord(value) ? value : {};
}

async function fetchPrimaryGithubEmail(accessToken: string): Promise<string | null> {
  const response = await fetch("https://api.github.com/user/emails", {
    headers: githubHeaders(accessToken),
  });
  if (!response.ok) {
    return null;
  }
  const value = await response.json();
  if (!Array.isArray(value)) {
    return null;
  }
  const primary = value.find((item) => isRecord(item) && item.primary === true && typeof item.email === "string");
  return isRecord(primary) && typeof primary.email === "string" ? primary.email : null;
}

async function upsertUser(env: Env, providerId: string, profile: IdentityProfile): Promise<User> {
  const now = nowSeconds();
  const existing = await env.DB.prepare(
    "SELECT user_id FROM auth_accounts WHERE provider_id = ? AND provider_subject = ? LIMIT 1",
  )
    .bind(providerId, profile.providerSubject)
    .first<AccountRow>();

  if (existing) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE users SET display_name = ?, email = ?, avatar_url = ?, updated_at = ? WHERE id = ?",
      ).bind(profile.displayName, profile.email, profile.avatarUrl, now, existing.user_id),
      env.DB.prepare(
        "UPDATE auth_accounts SET profile_json = ?, updated_at = ? WHERE provider_id = ? AND provider_subject = ?",
      ).bind(JSON.stringify(profile.rawProfile), now, providerId, profile.providerSubject),
    ]);
    const user = await readUser(env, existing.user_id);
    if (!user) {
      throw httpError(500, "user_missing", "Auth account points to a missing user");
    }
    return user;
  }

  const userId = crypto.randomUUID();
  const handle = await allocateHandle(env, profile.preferredHandle);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, handle, display_name, email, avatar_url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(userId, handle, profile.displayName, profile.email, profile.avatarUrl, now, now),
    env.DB.prepare(
      "INSERT INTO auth_accounts (provider_id, provider_subject, user_id, profile_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(providerId, profile.providerSubject, userId, JSON.stringify(profile.rawProfile), now, now),
  ]);

  return {
    id: userId,
    handle,
    displayName: profile.displayName,
    email: profile.email,
    avatarUrl: profile.avatarUrl,
  };
}

async function readUser(env: Env, userId: string): Promise<User | null> {
  const row = await env.DB.prepare(
    "SELECT id, handle, display_name, email, avatar_url FROM users WHERE id = ? LIMIT 1",
  )
    .bind(userId)
    .first<UserRow>();
  return row
    ? {
        id: row.id,
        handle: row.handle,
        displayName: row.display_name,
        email: row.email,
        avatarUrl: row.avatar_url,
      }
    : null;
}

async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken();
  const sessionId = await sha256Hex(token);
  const now = nowSeconds();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .bind(sessionId, userId, now + sessionTtlSeconds(env), now)
    .run();
  return token;
}

async function allocateHandle(env: Env, preferred: string): Promise<string> {
  const base = slugHandle(preferred);
  for (let index = 0; index < 5; index += 1) {
    const candidate = index === 0 ? base : `${base}-${randomToken(3).slice(0, 5)}`;
    const existing = await env.DB.prepare("SELECT id FROM users WHERE handle = ? LIMIT 1").bind(candidate).first();
    if (!existing) {
      return candidate;
    }
  }
  return `${base}-${crypto.randomUUID().slice(0, 8)}`;
}

function parseAuthState(value: string): AuthState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw httpError(400, "invalid_state", "Login state is invalid");
  }
  if (!isRecord(parsed)) {
    throw httpError(400, "invalid_state", "Login state is invalid");
  }
  const providerId = firstString(parsed, ["providerId"]);
  const redirectTo = firstString(parsed, ["redirectTo"]);
  const nonce = firstString(parsed, ["nonce"]);
  const codeVerifier = firstString(parsed, ["codeVerifier"]);
  const createdAt = typeof parsed.createdAt === "number" ? parsed.createdAt : 0;
  if (!providerId || !redirectTo || !nonce || !codeVerifier || !createdAt) {
    throw httpError(400, "invalid_state", "Login state is invalid");
  }
  return { providerId, redirectTo, nonce, codeVerifier, createdAt };
}

function parseDiscovery(value: string): OidcDiscovery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw httpError(502, "oidc_discovery_invalid", "OIDC discovery document was invalid");
  }
  if (!isRecord(parsed)) {
    throw httpError(502, "oidc_discovery_invalid", "OIDC discovery document was invalid");
  }
  const issuer = firstString(parsed, ["issuer"]);
  const authorizationEndpoint = firstString(parsed, ["authorization_endpoint"]);
  const tokenEndpoint = firstString(parsed, ["token_endpoint"]);
  const jwksUri = firstString(parsed, ["jwks_uri"]);
  if (!issuer || !authorizationEndpoint || !tokenEndpoint || !jwksUri) {
    throw httpError(502, "oidc_discovery_invalid", "OIDC discovery document is missing required fields");
  }
  return {
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    userinfo_endpoint: firstString(parsed, ["userinfo_endpoint"]) ?? undefined,
    jwks_uri: jwksUri,
  };
}

function firstString(value: Record<string, unknown> | JWTPayload, keys: string[]): string | null {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) {
      return field.trim();
    }
  }
  return null;
}

function normalizeProfile(value: Record<string, unknown> | JWTPayload): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, field]) => {
      const type = typeof field;
      return field === null || type === "string" || type === "number" || type === "boolean";
    }),
  );
}

function slugHandle(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return normalized.length >= 3 ? normalized : `user-${randomToken(3).slice(0, 5)}`;
}

function safeRedirect(value: string | null, fallbackOrigin: string): string {
  if (!value) {
    return fallbackOrigin;
  }
  try {
    const target = new URL(value, fallbackOrigin);
    return target.toString();
  } catch {
    return fallbackOrigin;
  }
}

function githubHeaders(accessToken: string): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${accessToken}`,
    "user-agent": "ZiKiBoard",
    "x-github-api-version": "2022-11-28",
  };
}
