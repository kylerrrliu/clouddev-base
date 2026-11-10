// 端到端测试的冒烟测试（见 e2e/README.md）：在 A 上运行，经 SSH 隧道走完 OAuth 授权，再调用全部 7 个工具。
//
// 用法（在 A 上，仓库根目录）: node e2e/smoke.mjs [--tunnel-port 7676] [--workspace ~/clouddev-e2e/work/demo-app]
//   --tunnel-port  隧道在 A 上的那一头（client/.mcp.json 里的端口）
//   --workspace    B 上 e2e/demo-app 的副本，必须在 B 允许访问的目录里；~ 指的是 B 上的家目录
//
// B 的 Owner 密码：在终端里运行时会提示输入（不显示）；也可以从标准输入传进来，比如只有一台 Mac 时
//   ~/clouddev-e2e/bin/clouddev-base password --show | node e2e/smoke.mjs --tunnel-port 17676
// 不打印 Owner 密码和令牌。每次运行都在 B 上注册一个叫 e2e-smoke 的客户端，它和这些调用都会出现在 B 的 WebUI 里。
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const { values: options } = parseArgs({
  options: {
    "tunnel-port": { type: "string", default: "7676" },
    workspace: { type: "string", default: "~/clouddev-e2e/work/demo-app" },
  },
});

const port = options["tunnel-port"];
const base = `http://127.0.0.1:${port}`;
const mcpUrl = `${base}/mcp`;
const redirectUri = "http://127.0.0.1:65530/callback";
let failures = 0;

function check(ok, label, detail = "") {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? `: ${detail}` : ""}`);
  if (!ok) failures++;
}

async function json(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 300) };
  }
}

/** Commands listening on a TCP port of this computer; undefined when lsof is not available. */
function listeners(tcpPort) {
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${tcpPort}`, "-sTCP:LISTEN", "-Fc"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

    return [...new Set(out.split("\n").filter((line) => line.startsWith("c")).map((line) => line.slice(1)))];
  } catch (error) {
    // lsof exits with 1 when nothing listens.
    return error.code === "ENOENT" ? undefined : [];
  }
}

/** The Owner password: the first line of stdin when it is piped, otherwise typed in without echo. */
async function ownerPassword() {
  if (!process.stdin.isTTY) {
    let data = "";
    for await (const chunk of process.stdin) data += chunk;

    return data.split(/\r?\n/)[0].trim();
  }

  process.stdout.write("B 的 Owner 密码（在 B 的终端里运行 clouddev-base password --show 查看；输入时不显示）: ");
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.setEncoding("utf8");
  stdin.resume();

  return new Promise((resolvePassword) => {
    let typed = "";
    const finish = (value) => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolvePassword(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(typed.trim());

        if (char === "\u0003") {
          finish("");
          process.exit(130);
        }

        typed = char === "\u007f" || char === "\b" ? typed.slice(0, -1) : typed + char;
      }
    };
    stdin.on("data", onData);
  });
}

// 1. A 上隧道那一头：监听的必须是隧道的 ssh。A 上自己跑着的 clouddev-base 也会回答 /healthz，那样测的就不是 B 了
const who = listeners(port);

if (who === undefined) {
  console.log(`－ A 上 ${port} 端口是隧道的 ssh 在监听: 没有 lsof，跳过（用 client/tunnel/status.sh 确认）`);
} else {
  check(who.length > 0 && who.every((command) => command === "ssh"), `A 上 ${port} 端口是隧道的 ssh 在监听`, who.join(", ") || "没有程序在监听");
}

// 2. 经隧道能访问到 B 上的 clouddev-base
let health;

try {
  health = await json(await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(5000) }));
} catch (error) {
  check(false, "经隧道访问 B 上的 /healthz", `${error.cause?.code ?? error.message}。隧道没连通？在 A 上运行 ~/clouddev-e2e/client/tunnel/status.sh 看看`);
  process.exit(1);
}

check(health.ok === true && health.name === "clouddev-base", "经隧道访问 B 上的 /healthz", `pid ${health.pid}（在 B 上运行 curl --noproxy '*' http://127.0.0.1:7676/healthz，pid 应该相同）`);

// 3. 不带令牌访问 /mcp 被拒绝，并指向资源元数据
const anonymous = await fetch(mcpUrl, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
check(anonymous.status === 401 && /resource_metadata/.test(anonymous.headers.get("www-authenticate") ?? ""), "不带令牌访问 /mcp 返回 401", `${anonymous.status}`);

// 4. OAuth：元数据 → 注册 → 授权页 → 输入 Owner 密码 → 换令牌
const meta = await json(await fetch(`${base}/.well-known/oauth-authorization-server`));
check(Boolean(meta.issuer?.startsWith(base) && meta.authorization_endpoint && meta.token_endpoint && meta.registration_endpoint), "授权服务器元数据", meta.issuer);

const registered = await json(await fetch(meta.registration_endpoint, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    client_name: "e2e-smoke",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  }),
}));
check(Boolean(registered.client_id), "动态注册客户端", registered.client_id ? "e2e-smoke" : JSON.stringify(registered));

const verifier = randomBytes(32).toString("base64url");
const state = randomBytes(8).toString("hex");
const params = {
  response_type: "code",
  client_id: registered.client_id,
  redirect_uri: redirectUri,
  code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  code_challenge_method: "S256",
  scope: "clouddev-base",
  state,
  resource: mcpUrl,
};

const page = await fetch(`${meta.authorization_endpoint}?${new URLSearchParams(params)}`);
check(page.status === 200 && (await page.text()).includes("owner_password"), "授权页（GET /authorize）", `${page.status}`);

const password = await ownerPassword();

if (!password) {
  console.error("没有拿到 Owner 密码。");
  process.exit(1);
}

const approve = (value) => fetch(meta.authorization_endpoint, {
  method: "POST",
  redirect: "manual",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ ...params, owner_password: value }),
});

const wrong = await approve("definitely-not-the-password");
check(wrong.status === 401, "输错 Owner 密码被拒绝", `${wrong.status}`);

const approved = await approve(password);
const location = new URL(approved.headers.get("location") ?? "about:blank");
check(approved.status === 302 && location.searchParams.get("state") === state && Boolean(location.searchParams.get("code")), "输入正确的 Owner 密码后拿到授权码", approved.status === 401 ? "401：密码不对" : `${approved.status}`);

const tokens = await json(await fetch(meta.token_endpoint, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code: location.searchParams.get("code") ?? "",
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: registered.client_id,
    resource: mcpUrl,
  }),
}));
check(Boolean(tokens.access_token && tokens.refresh_token), "授权码换到访问令牌和刷新令牌", tokens.access_token ? `expires_in ${tokens.expires_in}` : JSON.stringify(tokens));

if (!tokens.access_token) {
  console.log(`\n${failures} 项失败，没有令牌，后面的工具调用不再测试`);
  process.exit(1);
}

// 5. MCP：经隧道调用工具
const client = new Client({ name: "e2e-smoke", version: "0.0.1" });
await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl), {
  requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } },
}));
check(client.getServerVersion()?.name === "clouddev-base", "MCP initialize", JSON.stringify(client.getServerVersion()));

const { tools } = await client.listTools();
const names = tools.map((tool) => tool.name).sort().join(", ");
check(names === "bash, edit, glob, grep, open_workspace, read, write", "tools/list", names);

const text = (result) => result.content.map((item) => item.text ?? "").join("\n");
const call = (name, args) => client.callTool({ name, arguments: args });

const opened = await call("open_workspace", { path: options.workspace });
const workspace_id = /workspace_id: (\S+)/.exec(text(opened))?.[1];
check(!opened.isError && Boolean(workspace_id), `open_workspace ${options.workspace}`, workspace_id ?? text(opened));

const read = await call("read", { workspace_id, path: "package.json" });
check(!read.isError && text(read).includes("demo-app"), "read package.json");

const glob = await call("glob", { workspace_id, pattern: "**/*.js" });
check(!glob.isError && text(glob).includes("src/stats.js") && text(glob).includes("test/stats.test.js"), "glob **/*.js", text(glob).split("\n").filter(Boolean).join(" "));

const grep = await call("grep", { workspace_id, pattern: "export function" });
check(!grep.isError && (text(grep).match(/src\/stats\.js:\d+:/g) ?? []).length === 2, "grep export function");

// ~ 在 B 上展开：B 的 Owner 密码文件在工作区以外，必须读不到
const outside = await call("read", { workspace_id, path: "~/.clouddev-base/auth.json" });
check(outside.isError === true, "读工作区以外的文件（B 上的 ~/.clouddev-base/auth.json）被拒绝", text(outside).split("\n")[0]);

const env = await call("bash", { workspace_id, command: "echo \"service=$CLOUDDEV_BASE_SERVICE\"; command -v node npm git" });
check(!env.isError && text(env).includes("service=com.clouddev-base.serve") && /\/node\b/.test(text(env)), "bash 在 B 的后台服务里运行，PATH 里有 node、npm、git", text(env).split("\n")[0]);

// demo-app 原本有 2 个失败用例；被修好之后再跑也能通过这一项：只要求退出码和测试结果一致
const tests = await call("bash", { workspace_id, command: "npm test", timeout: 120 });
const failed = /(?:ℹ|#) fail (\d+)/.exec(text(tests))?.[1];
check(failed !== undefined && Boolean(tests.isError) === Number(failed) > 0, "bash npm test：有失败用例时标为出错，全部通过时不标", failed === undefined ? "没找到测试结果的汇总" : `失败 ${failed} 个`);

await client.close();

console.log(failures ? `\n${failures} 项失败` : "\n全部通过");
process.exit(failures ? 1 : 0);
