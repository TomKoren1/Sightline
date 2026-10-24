/**
 * The two outside services a journey through the product touches, stood in
 * for on loopback: GitHub's OAuth app and Anthropic's Messages API.
 *
 * Everything between them is real - the callback, the session, the tenant, the
 * agent loop, its tools and its citation check. Hosted mode accepts these only
 * because PUBLIC_BASE_URL is loopback (`apps/api/src/hostedMode.ts`).
 *
 * The model is scripted rather than clever: asked anything, it calls
 * `find_public_resources`, then answers naming the first ARN that tool
 * returned. That is enough to prove a question travels from the chat box to
 * a tool against the scanned inventory and back as a cited answer.
 */

import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const E2E_USER = { id: 4242, login: "e2e-user", email: "e2e@sightline.test" };

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, value: unknown): void {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}

/**
 * The PKCE challenge each issued code was bound to, so the token exchange is
 * held to it as GitHub holds it: a sign-in that stopped sending the verifier
 * fails the journey rather than passing against a lenient stand-in.
 */
const challenges = new Map<string, string>();

async function github(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
  switch (url.pathname) {
    case "/github/authorize": {
      // No consent screen: straight back with a code, as GitHub does for an
      // app the user has already authorised.
      const challenge = url.searchParams.get("code_challenge");
      if (!challenge || url.searchParams.get("code_challenge_method") !== "S256") {
        res.writeHead(400).end("PKCE challenge missing");
        return;
      }
      const code = `e2e-code-${challenges.size}`;
      challenges.set(code, challenge);
      const back = new URL(url.searchParams.get("redirect_uri") ?? "");
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    case "/github/token": {
      const form = new URLSearchParams(await body(req));
      const challenge = challenges.get(form.get("code") ?? "");
      const verifier = form.get("code_verifier") ?? "";
      if (!challenge || createHash("sha256").update(verifier).digest("base64url") !== challenge) {
        return json(res, { error: "bad_verification_code" });
      }
      challenges.delete(form.get("code") ?? "");
      return json(res, { access_token: "e2e-token", token_type: "bearer" });
    }
    case "/github/user":
      return json(res, { id: E2E_USER.id, login: E2E_USER.login, name: "E2E User" });
    case "/github/emails":
      return json(res, [{ email: E2E_USER.email, primary: true, verified: true }]);
  }
  res.writeHead(404).end();
}

/** One streamed assistant message holding a single content block. */
function streamMessage(
  res: ServerResponse,
  block: { type: "tool_use"; name: string; input: object } | { type: "text"; text: string },
): void {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const send = (type: string, data: object) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const usage = { input_tokens: 10, output_tokens: 10 };

  send("message_start", {
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: "e2e-scripted",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage,
    },
  });
  if (block.type === "tool_use") {
    send("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: `toolu_${Date.now()}`, name: block.name, input: {} },
    });
    send("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
    });
  } else {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: block.text } });
  }
  send("content_block_stop", { index: 0 });
  send("message_delta", {
    delta: {
      stop_reason: block.type === "tool_use" ? "tool_use" : "end_turn",
      stop_sequence: null,
    },
    usage,
  });
  send("message_stop", {});
  res.end();
}

async function anthropic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const request = JSON.parse(await body(req)) as {
    messages: { role: string; content: unknown }[];
  };
  const last = request.messages.at(-1);
  const answered =
    Array.isArray(last?.content) &&
    last.content.some((part: { type?: string }) => part.type === "tool_result");

  if (!answered) {
    streamMessage(res, {
      type: "tool_use",
      name: "find_public_resources",
      input: { kind: "S3Bucket" },
    });
    return;
  }
  const arn = /arn:aws:s3:::[a-z0-9.-]+/.exec(JSON.stringify(last.content))?.[0];
  streamMessage(res, {
    type: "text",
    text: arn
      ? `One bucket is public to the internet: ${arn}.`
      : "No bucket is public to the internet.",
  });
}

export function startStubs(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    if (url.pathname.startsWith("/github/")) {
      github(req, url, res).catch((err: unknown) => {
        res.writeHead(500).end(String(err));
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      anthropic(req, res).catch((err: unknown) => {
        res.writeHead(500).end(String(err));
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
