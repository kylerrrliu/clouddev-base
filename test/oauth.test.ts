import assert from "node:assert/strict";
import { chmod, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { Response } from "express";
import { OwnerOAuthProvider } from "../src/oauth.ts";
import { captureStderr, tempDir } from "./helpers.ts";

const PASSWORD = "correct-horse-battery-staple";
const REDIRECT_URI = "http://localhost:9999/callback";

function provider(stateDir: string): OwnerOAuthProvider {
  return new OwnerOAuthProvider({
    ownerPassword: () => PASSWORD,
    resourceUrl: new URL("http://127.0.0.1:7676/mcp"),
    stateDir,
    allowedRedirectHosts: [],
  });
}

async function register(oauth: OwnerOAuthProvider, name = "Claude Code"): Promise<OAuthClientInformationFull> {
  const metadata = { client_name: name, redirect_uris: [REDIRECT_URI], token_endpoint_auth_method: "none" };

  return oauth.clientsStore.registerClient!(metadata as Parameters<NonNullable<typeof oauth.clientsStore.registerClient>>[0]);
}

/** The owner approves the client on the approval page, and the client exchanges the code, as Claude Code does. */
async function signIn(oauth: OwnerOAuthProvider, client: OAuthClientInformationFull) {
  let location = "";
  const res = {
    req: { method: "POST", body: { owner_password: PASSWORD } },
    setHeader: () => res,
    status: () => res,
    type: () => res,
    send: () => res,
    redirect: (_status: number, url: string) => {
      location = url;
    },
  };

  await oauth.authorize(client, { redirectUri: REDIRECT_URI, codeChallenge: "x".repeat(43) }, res as unknown as Response);
  const code = location ? new URL(location).searchParams.get("code") : null;
  assert.ok(code, "the approval page accepted the password");

  return oauth.exchangeAuthorizationCode(client, code);
}

test("deleting oauth.json signs every client out at once, and the old data is never written back", async () => {
  const stateDir = await tempDir();
  const oauth = provider(stateDir);
  const client = await register(oauth);
  const tokens = await signIn(oauth, client);
  assert.equal((await oauth.verifyAccessToken(tokens.access_token)).clientId, client.client_id);

  // What the README tells the owner to do, with the server still running.
  await rm(join(stateDir, "oauth.json"));

  await assert.rejects(oauth.verifyAccessToken(tokens.access_token));
  await assert.rejects(oauth.exchangeRefreshToken(client, tokens.refresh_token!));
  assert.equal(await oauth.clientsStore.getClient(client.client_id), undefined);

  // The next save (here a new registration) writes only what is valid now, and a restart agrees.
  const next = await register(oauth, "Another host");
  const saved = JSON.parse(await readFile(join(stateDir, "oauth.json"), "utf8")) as { clients: Record<string, unknown>; tokens: Record<string, unknown> };
  assert.deepEqual(Object.keys(saved.clients), [next.client_id]);
  assert.deepEqual(saved.tokens, {});
  await assert.rejects(provider(stateDir).verifyAccessToken(tokens.access_token));
});

test("a healthy oauth.json survives a restart: clients stay signed in and nothing is moved aside", async () => {
  const stateDir = await tempDir();
  const first = provider(stateDir);
  const client = await register(first);
  const tokens = await signIn(first, client);

  // What the server itself wrote must pass its own checks, or every restart would sign every client out.
  let restarted: OwnerOAuthProvider | undefined;
  assert.deepEqual(await captureStderr(() => (restarted = provider(stateDir))), []);
  assert.deepEqual(await readdir(stateDir), ["oauth.json"]);
  assert.ok(await restarted!.clientsStore.getClient(client.client_id));
  assert.equal((await restarted!.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
  assert.ok((await restarted!.exchangeRefreshToken(client, tokens.refresh_token!)).access_token);
});

test("an oauth.json that may not be read (mode 000) gets 0600 back: clients stay signed in", { skip: process.getuid?.() === 0 ? "root reads any file" : false }, async () => {
  const stateDir = await tempDir();
  const first = provider(stateDir);
  const client = await register(first);
  const tokens = await signIn(first, client);
  await chmod(join(stateDir, "oauth.json"), 0o000);

  let restarted: OwnerOAuthProvider | undefined;
  const logged = await captureStderr(() => (restarted = provider(stateDir)));

  assert.match(logged.join("\n"), /oauth\.json[^\n]*权限改回 600/);
  assert.deepEqual(await readdir(stateDir), ["oauth.json"], "nothing moved aside");
  assert.equal((await stat(join(stateDir, "oauth.json"))).mode & 0o777, 0o600);
  assert.equal((await restarted!.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
});

test("a broken oauth.json is moved aside: the server starts empty and clients sign in again", async () => {
  const broken = [
    "",
    '{"clients":{"a":{"client_id":"a"',
    "null",
    "[]",
    '{"clients": [], "tokens": {}}',
    '{"clients": {"a": {"client_id": "a"}}, "tokens": {}}',
    '{"clients": {}, "tokens": {"hash": {"kind": "access"}}}',
  ];

  for (const content of broken) {
    const stateDir = await tempDir();
    await writeFile(join(stateDir, "oauth.json"), content);

    let oauth: OwnerOAuthProvider | undefined;
    const logged = await captureStderr(() => (oauth = provider(stateDir)));

    assert.match(logged.join("\n"), /oauth\.json[\s\S]*重新授权/, content);
    const names = await readdir(stateDir);
    assert.equal(names.length, 1, content);
    assert.match(names[0]!, /^oauth\.json\.corrupt-/, content);
    assert.equal(await readFile(join(stateDir, names[0]!), "utf8"), content, "the broken file is kept as it was");

    const client = await register(oauth!);
    const tokens = await signIn(oauth!, client);
    assert.equal((await oauth!.verifyAccessToken(tokens.access_token)).clientId, client.client_id);
  }

  // Lists that are merely missing are not damage.
  const stateDir = await tempDir();
  await writeFile(join(stateDir, "oauth.json"), "{}");
  assert.deepEqual(await captureStderr(() => provider(stateDir)), []);
  assert.deepEqual(await readdir(stateDir), ["oauth.json"]);
});

test("a flood of registrations never evicts a client that is signed in", async () => {
  const oauth = provider(await tempDir());
  const owner = await register(oauth);
  const tokens = await signIn(oauth, owner);
  const oldest = await register(oauth, "flood 0");

  for (let i = 1; i < 520; i++) await register(oauth, `flood ${i}`);

  assert.ok(await oauth.clientsStore.getClient(owner.client_id), "the signed-in client stays registered");
  assert.equal(await oauth.clientsStore.getClient(oldest.client_id), undefined, "the oldest of the others go");
  assert.equal((await oauth.verifyAccessToken(tokens.access_token)).clientId, owner.client_id);
  assert.ok((await oauth.exchangeRefreshToken(owner, tokens.refresh_token!)).access_token, "and it can still refresh its token");
});
