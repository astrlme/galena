// Test helper: a client that keeps cookies between requests, like a browser.
import { problemDetails } from "@galena/contracts";
import { expect } from "vitest";
import type { createApp } from "./app.ts";
import { TEST_BASE_URL } from "./test-deps.ts";

type App = ReturnType<typeof createApp>;

export class Session {
  #cookies = new Map<string, string>();
  readonly #app: App;

  constructor(app: App) {
    this.#app = app;
  }

  async call(path: string, body?: unknown, method = body === undefined ? "GET" : "POST") {
    const response = await this.#app.request(path, {
      method,
      headers: {
        origin: TEST_BASE_URL,
        "content-type": "application/json",
        cookie: [...this.#cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const header of response.headers.getSetCookie()) {
      const [pair = ""] = header.split(";");
      const at = pair.indexOf("=");
      const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
      if (value === "" || /max-age=0/i.test(header)) this.#cookies.delete(name);
      else this.#cookies.set(name, value);
    }
    return response;
  }
}

export async function expectProblem(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expect(problemDetails.parse(await response.json())).toMatchObject({ status, code });
}
