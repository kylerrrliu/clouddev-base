import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { readJson, writeJsonPrivate } from "./config.ts";
import { escapeMarkup as escapeHtml } from "./markup.ts";

export const SCOPE = "clouddev-base";

const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CLIENTS = 500;

interface TokenRecord {
  kind: "access" | "refresh";
  clientId: string;
  /** Unix seconds. */
  expiresAt: number;
  resource: string;
}

interface StoreData {
  clients: Record<string, OAuthClientInformationFull>;
  /** Keyed by SHA-256 of the token; raw tokens are never written to disk. */
  tokens: Record<string, TokenRecord>;
}

interface PendingCode {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

export interface OwnerOAuthOptions {
  /** The current Owner password. Called on every approval, so a new password applies without a restart. */
  ownerPassword: () => string | undefined;
  /** The protected MCP endpoint, e.g. https://example.com/mcp */
  resourceUrl: URL;
  stateDir: string;
  /** Hosts allowed in redirect_uris during client registration. Loopback hosts are always allowed. */
  allowedRedirectHosts: string[];
  /** Told about every submitted approval form, for the activity page. */
  onAuthorization?: (event: AuthorizationEvent) => void;
}

export interface AuthorizationEvent {
  outcome: "approved" | "wrong_password" | "no_password";
  /** The name the client registered with. */
  clientName: string;
}

/**
 * Single-user OAuth 2.1 authorization server. Any MCP host may register
 * itself, but a client only gets tokens after the owner types the Owner
 * password on the approval page.
 */
export class OwnerOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly options: OwnerOAuthOptions;
  private readonly file: string;
  private data: StoreData;
  /** oauth.json exists with our data, so its disappearance means someone deleted it. */
  private onDisk: boolean;
  private readonly codes = new Map<string, PendingCode>();

  constructor(options: OwnerOAuthOptions) {
    this.options = options;
    this.file = join(options.stateDir, "oauth.json");
    this.data = readJson<StoreData>(this.file) ?? { clients: {}, tokens: {} };
    this.data.clients ??= {};
    this.data.tokens ??= {};
    this.onDisk = existsSync(this.file);

    this.clientsStore = {
      getClient: (clientId) => this.store().clients[clientId],
      registerClient: (metadata) => this.registerClient({
        client_id: randomUUID(),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        ...metadata,
      }),
    };
  }

  private registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    for (const uri of client.redirect_uris) {
      if (!this.redirectAllowed(String(uri))) {
        throw new InvalidRequestError(`redirect_uri host is not allowed: ${uri}`);
      }
    }

    const store = this.store();
    store.clients[client.client_id] = client;

    // Registration is unauthenticated; keep the file from growing without bound. The oldest clients go first,
    // but never one that still holds a valid token: a flood of registrations must not sign out the owner's client.
    const ids = Object.keys(store.clients);
    let excess = ids.length - MAX_CLIENTS;

    if (excess > 0) {
      const signedIn = new Set(Object.values(store.tokens).filter((record) => !isExpired(record)).map((record) => record.clientId));

      for (const id of ids) {
        if (excess === 0) break;
        if (id === client.client_id || signedIn.has(id)) continue;

        delete store.clients[id];
        excess--;
      }
    }

    this.save();

    return client;
  }

  /** The name a client registered with, for display. */
  clientName(clientId: string): string | undefined {
    return this.store().clients[clientId]?.client_name;
  }

  /**
   * The clients and tokens in effect. Deleting oauth.json signs every client out at once, without a restart
   * (stopping the background service does not work anyway: launchd starts it again within a second): the copy
   * in memory is dropped instead of being written back on the next save.
   */
  private store(): StoreData {
    if (this.onDisk && !existsSync(this.file)) {
      this.data = { clients: {}, tokens: {} };
      this.codes.clear();
      this.onDisk = false;
      console.error(`${this.file} 已被删除：所有客户端和令牌都已失效，客户端要重新授权。`);
    }

    return this.data;
  }

  private redirectAllowed(uri: string): boolean {
    const url = URL.parse(uri);

    if (!url) return false;

    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return true;

    return url.protocol === "https:" && this.options.allowedRedirectHosts.includes(url.hostname);
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (params.resource && !sameResource(params.resource, this.options.resourceUrl)) {
      throw new InvalidRequestError("Invalid OAuth resource");
    }

    // No form-action directive: browsers apply it to the redirect back to the client too.
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");

    if (res.req.method !== "POST") {
      res.status(200).type("html").send(approvalPage(client, params));

      return;
    }

    const ownerPassword = this.currentOwnerPassword();

    if (!ownerPassword) {
      this.reportAuthorization("no_password", client);
      res.status(503).type("html").send(approvalPage(client, params, "服务器上没有可用的 Owner 密码。请在运行 clouddev-base 的电脑上执行 clouddev-base password，然后重试。"));

      return;
    }

    const password = String(res.req.body?.owner_password ?? "");

    if (!safeEqual(password, ownerPassword)) {
      this.reportAuthorization("wrong_password", client);
      res.status(401).type("html").send(approvalPage(client, params, "密码不正确。"));

      return;
    }

    for (const [key, pending] of this.codes) {
      if (pending.expiresAtMs < Date.now()) this.codes.delete(key);
    }

    const code = randomBytes(32).toString("base64url");
    this.codes.set(code, { clientId: client.client_id, params, expiresAtMs: Date.now() + CODE_TTL_MS });

    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);

    if (params.state !== undefined) redirect.searchParams.set("state", params.state);

    this.reportAuthorization("approved", client);
    res.redirect(302, redirect.href);
  }

  private reportAuthorization(outcome: AuthorizationEvent["outcome"], client: OAuthClientInformationFull): void {
    this.options.onAuthorization?.({ outcome, clientName: client.client_name ?? client.client_id });
  }

  /** Read fresh each time. If it cannot be read (broken auth.json, too-short env value), approval is refused. */
  private currentOwnerPassword(): string | undefined {
    try {
      return this.options.ownerPassword();
    } catch (error) {
      console.error(`Cannot read the Owner password: ${error instanceof Error ? error.message : String(error)}`);

      return undefined;
    }
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    return this.pendingCode(client, code).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const pending = this.pendingCode(client, code);

    if (redirectUri && redirectUri !== pending.params.redirectUri) {
      throw new InvalidGrantError("redirect_uri does not match the authorization request");
    }

    if (resource && !sameResource(resource, this.options.resourceUrl)) throw new InvalidGrantError("Invalid resource");

    this.codes.delete(code);

    return this.issueTokens(client.client_id);
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const key = hashToken(refreshToken);
    const tokens = this.store().tokens;
    const record = tokens[key];

    if (!record || record.kind !== "refresh" || record.clientId !== client.client_id || isExpired(record)) {
      throw new InvalidGrantError("Invalid refresh token");
    }

    if (record.resource !== this.options.resourceUrl.href || (resource && !sameResource(resource, this.options.resourceUrl))) {
      throw new InvalidGrantError("Invalid resource");
    }

    // Refresh tokens are single use: rotate on every refresh.
    delete tokens[key];

    return this.issueTokens(client.client_id);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store().tokens[hashToken(token)];

    if (!record || record.kind !== "access" || isExpired(record)) {
      throw new InvalidTokenError("Invalid or expired access token");
    }

    return {
      token,
      clientId: record.clientId,
      scopes: [SCOPE],
      expiresAt: record.expiresAt,
      resource: new URL(record.resource),
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    delete this.store().tokens[hashToken(request.token)];
    this.save();
  }

  private pendingCode(client: OAuthClientInformationFull, code: string): PendingCode {
    const pending = this.codes.get(code);

    if (!pending || pending.clientId !== client.client_id || pending.expiresAtMs < Date.now()) {
      throw new InvalidGrantError("Invalid authorization code");
    }

    return pending;
  }

  private issueTokens(clientId: string): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomBytes(32).toString("base64url");
    const refreshToken = randomBytes(32).toString("base64url");
    const resource = this.options.resourceUrl.href;
    const tokens = this.store().tokens;

    tokens[hashToken(accessToken)] = { kind: "access", clientId, expiresAt: now + ACCESS_TOKEN_TTL_SECONDS, resource };
    tokens[hashToken(refreshToken)] = { kind: "refresh", clientId, expiresAt: now + REFRESH_TOKEN_TTL_SECONDS, resource };
    this.save();

    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: SCOPE,
    };
  }

  private save(): void {
    const store = this.store();

    for (const [key, record] of Object.entries(store.tokens)) {
      if (isExpired(record)) delete store.tokens[key];
    }

    writeJsonPrivate(this.file, store);
    this.onDisk = true;
  }
}

function isExpired(record: TokenRecord): boolean {
  return record.expiresAt < Math.floor(Date.now() / 1000);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

/** Constant-time comparison; hashing first makes the lengths equal. */
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

function sameResource(a: URL, b: URL): boolean {
  const normalize = (url: URL) => url.href.replace(/#.*$/, "").replace(/\/$/, "");

  return normalize(a) === normalize(b);
}

function approvalPage(client: OAuthClientInformationFull, params: AuthorizationParams, error?: string): string {
  // The SDK re-validates these fields when the form is posted back to /authorize.
  const fields: Record<string, string | undefined> = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" ") || undefined,
    state: params.state,
    resource: params.resource?.href,
  };

  const hidden = Object.entries(fields)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
    .join("\n      ");

  const redirectHost = URL.parse(params.redirectUri)?.host ?? params.redirectUri;

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>授权 clouddev-base</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, "PingFang SC", "Segoe UI", sans-serif; margin: 0; padding: 16px; background: #f4f4f5; color: #18181b; }
    main { max-width: 420px; margin: 10vh auto; padding: 28px; background: #fff; border: 1px solid #e4e4e7; border-radius: 14px; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p { line-height: 1.6; margin: 8px 0; }
    .warn { color: #b45309; }
    .error { color: #fff; background: #b91c1c; border-radius: 8px; padding: 8px 12px; }
    dl { background: #f4f4f5; border-radius: 10px; padding: 12px 14px; margin: 16px 0; }
    dt { font-size: 12px; color: #71717a; }
    dd { margin: 2px 0 10px; word-break: break-all; }
    label { display: block; font-weight: 600; margin-bottom: 6px; }
    input[type=password] { box-sizing: border-box; width: 100%; padding: 10px 12px; font-size: 16px; border-radius: 8px; border: 1px solid #a1a1aa; }
    button { margin-top: 14px; width: 100%; padding: 11px; font-size: 16px; font-weight: 600; border: 0; border-radius: 8px; background: #2563eb; color: #fff; cursor: pointer; }
    @media (prefers-color-scheme: dark) {
      body { background: #09090b; color: #e4e4e7; }
      main { background: #18181b; border-color: #3f3f46; }
      dl { background: #09090b; }
      input[type=password] { background: #09090b; color: #e4e4e7; border-color: #52525b; }
    }
  </style>
</head>
<body>
  <main>
    <h1>授权 clouddev-base</h1>
    <p class="warn">批准后，该客户端可以读写你允许的项目目录，并在本机执行命令。只在你主动连接自己的 AI 客户端时才批准。</p>
    ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
    <dl>
      <dt>客户端</dt><dd>${escapeHtml(client.client_name ?? client.client_id)}</dd>
      <dt>授权后跳转到</dt><dd>${escapeHtml(redirectHost)}</dd>
    </dl>
    <form method="post">
      ${hidden}
      <label for="owner_password">Owner 密码</label>
      <input id="owner_password" name="owner_password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">批准连接</button>
    </form>
  </main>
</body>
</html>`;
}
