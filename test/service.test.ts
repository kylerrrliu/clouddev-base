import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  defineService,
  guardedRoots,
  guardedServiceFiles,
  insideService,
  renderPlist,
  SERVICE_ENV_MARKER,
  SERVICE_LABEL,
  servicePath,
  stableNodePath,
} from "../src/service.ts";
import { tempDir } from "./helpers.ts";

test("node is named by a path that survives upgrades when the version manager keeps one", () => {
  // process.execPath is always the real binary; `links` maps each existing link to what it resolves to.
  const fs = (links: Record<string, string>) => ({
    existsSync: (path: string) => path in links,
    realpathSync: (path: string) => links[path] ?? path,
  });
  const fnmNode = "/Users/u/.local/share/fnm/node-versions/v24.16.0/installation/bin/node";
  const fnmAlias = "/Users/u/.local/share/fnm/aliases/default/bin/node";
  const brewNode = "/opt/homebrew/Cellar/node/24.1.0/bin/node";
  const brewOpt = "/opt/homebrew/opt/node/bin/node";

  assert.equal(stableNodePath(fnmNode, {}, fs({ [fnmAlias]: fnmNode })), fnmAlias, "fnm: the default alias");
  assert.equal(stableNodePath(fnmNode, {}, fs({ [fnmAlias]: "/Users/u/.local/share/fnm/node-versions/v22.1.0/installation/bin/node" })), fnmNode, "the alias is another version: keep this one");
  assert.equal(stableNodePath(fnmNode, {}, fs({})), fnmNode);
  assert.equal(stableNodePath("/Users/u/.local/state/fnm_multishells/1_2/bin/node", {}, fs({ "/Users/u/.local/state/fnm_multishells/1_2/bin/node": fnmNode, [fnmAlias]: fnmNode })), fnmAlias, "a shell's temporary link is resolved first");
  assert.equal(stableNodePath(brewNode, {}, fs({ [brewOpt]: brewNode })), brewOpt, "Homebrew: the opt link");
  assert.equal(stableNodePath("/opt/homebrew/Cellar/node@22/22.11.0/bin/node", {}, fs({ "/opt/homebrew/opt/node@22/bin/node": "/opt/homebrew/Cellar/node@22/22.11.0/bin/node" })), "/opt/homebrew/opt/node@22/bin/node");
  assert.equal(stableNodePath("/Users/u/.nvm/versions/node/v22.1.0/bin/node", {}, fs({})), "/Users/u/.nvm/versions/node/v22.1.0/bin/node", "no stable link: the real binary");
});

test("the service PATH starts with node's folder, keeps the shell's PATH and drops temporary entries", () => {
  const path = servicePath("/n/bin/node", "/Users/u/.local/state/fnm_multishells/1_2/bin:/opt/homebrew/bin::relative:/usr/bin:/opt/homebrew/bin");

  assert.equal(path, "/n/bin:/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin");
});

test("roots in or around folders guarded by macOS privacy prompts are flagged", () => {
  const roots = ["/Users/u/work", "/Users/u/Documents/app", "/Users/u", "/Volumes/ext/code", "/Users/u/Library/Mobile Documents/x", "/Users/u/Documentsx"];

  assert.deepEqual(guardedRoots(roots, "/Users/u"), ["/Users/u/Documents/app", "/Users/u", "/Volumes/ext/code", "/Users/u/Library/Mobile Documents/x"]);
});

test("the service carries the variables builds need and marks its environment, but never the Owner password", () => {
  const service = defineService({
    home: "/Users/u",
    nodePath: "/nonexistent/node/bin/node",
    cliPath: "/Users/u/clouddev-base/dist/cli.js",
    env: {
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      JAVA_HOME: "/Library/Java/jdk",
      HTTPS_PROXY: "http://proxy:3128",
      DATABASE_URL: "postgres://localhost/app",
      CLOUDDEV_BASE_PASSWORD: "secret-secret-secret",
      TERM_PROGRAM: "iTerm.app",
    },
  }, ["DATABASE_URL", "CLOUDDEV_BASE_PASSWORD", "not a name"]);

  assert.equal(service.environment.JAVA_HOME, "/Library/Java/jdk");
  assert.equal(service.environment.HTTPS_PROXY, "http://proxy:3128");
  assert.equal(service.environment.DATABASE_URL, "postgres://localhost/app", "names from serviceEnv carry over too");
  assert.equal(service.environment.CLOUDDEV_BASE_PASSWORD, undefined);
  assert.equal(service.environment.TERM_PROGRAM, undefined, "only known or listed variables");
  assert.equal(service.environment[SERVICE_ENV_MARKER], SERVICE_LABEL);

  // Commands Claude runs through the service inherit its environment, so `service install` run there notices.
  assert.equal(insideService(service.environment), true);
  assert.equal(insideService({ PATH: "/usr/bin" }), false);
  assert.equal(insideService({ ...service.environment, CLOUDDEV_BASE_SERVICE_HANDOFF: "1" }), false, "the process it hands over to does the work");
});

test("the service's own code, config or node in a guarded folder is flagged", () => {
  const define = (cliPath: string) => defineService({ home: "/Users/u", nodePath: "/nonexistent/node/bin/node", cliPath, env: {} });

  assert.deepEqual(guardedServiceFiles(define("/Users/u/Documents/mcpdev/dist/cli.js"), "/Users/u/.clouddev-base", "/Users/u").map(({ what }) => what), ["clouddev-base 的代码"]);
  assert.deepEqual(guardedServiceFiles(define("/Users/u/work/clouddev-base/dist/cli.js"), "/Users/u/Desktop/cfg", "/Users/u").map(({ what }) => what), ["配置目录"]);
  assert.deepEqual(guardedServiceFiles(define("/Users/u/work/clouddev-base/dist/cli.js"), "/Users/u/.clouddev-base", "/Users/u"), []);
});

test("the launchd plist runs serve with a full PATH, restarts it, and never contains the Owner password", async () => {
  const service = defineService({
    home: "/Users/u",
    nodePath: "/nonexistent/node/bin/node",
    cliPath: "/Users/u/clouddev-base/dist/cli.js",
    env: {
      PATH: "/opt/homebrew/bin:/usr/bin",
      LANG: "C",
      CLOUDDEV_BASE_PASSWORD: "secret-secret-secret",
      CLOUDDEV_BASE_LOG_COMMANDS: "1",
      CLOUDDEV_BASE_HOME: "/Users/u/cfg & <more>",
    },
  });

  assert.deepEqual(service.programArguments, ["/nonexistent/node/bin/node", "/Users/u/clouddev-base/dist/cli.js", "serve"]);
  assert.equal(service.plistPath, "/Users/u/Library/LaunchAgents/com.clouddev-base.serve.plist");
  assert.equal(service.logPath, "/Users/u/Library/Logs/clouddev-base.log");
  assert.equal(service.environment.PATH, "/nonexistent/node/bin:/opt/homebrew/bin:/usr/bin:/usr/local/bin:/bin:/usr/sbin:/sbin");
  assert.equal(service.environment.LANG, "en_US.UTF-8", "a non-UTF-8 locale is replaced");
  assert.equal(service.environment.CLOUDDEV_BASE_LOG_COMMANDS, "1");
  assert.equal(service.environment.CLOUDDEV_BASE_PASSWORD, undefined);

  const plist = renderPlist(service);
  assert.doesNotMatch(plist, /secret-secret/);
  assert.match(plist, /<string>\/Users\/u\/cfg &amp; &lt;more&gt;<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>10<\/integer>/);

  if (process.platform === "darwin") {
    // launchd's own parser has to accept it.
    const file = join(await tempDir(), "service.plist");
    await writeFile(file, plist);
    execFileSync("plutil", ["-lint", file]);
    const parsed = JSON.parse(execFileSync("plutil", ["-convert", "json", "-o", "-", file], { encoding: "utf8" })) as Record<string, unknown>;
    assert.equal(parsed.Label, "com.clouddev-base.serve");
    assert.deepEqual(parsed.ProgramArguments, service.programArguments);
    assert.deepEqual(parsed.EnvironmentVariables, service.environment);
  }
});
