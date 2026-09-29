import { describe, expect, test } from "vitest";
import { checkUpdateBody } from "./body.ts";

const code = (body: string) => {
  const result = checkUpdateBody(body);
  return result.ok ? "ok" : result.error.code;
};

describe("checkUpdateBody", () => {
  test("accepts Markdown with web and mail links, and a lone < in prose", () => {
    expect(
      checkUpdateBody(
        "**API** errors are below 1% and latency < 200 ms. See [the notes](https://example.com/x) or [mail us](mailto:ops@example.com).",
      ),
    ).toEqual({
      ok: true,
      value:
        "**API** errors are below 1% and latency < 200 ms. See [the notes](https://example.com/x) or [mail us](mailto:ops@example.com).",
    });
  });

  test.each([
    ["<script>alert(1)</script>", "html_not_allowed"],
    ['Hello <img src=x onerror="alert(1)">', "html_not_allowed"],
    ["<javascript:alert(1)>", "html_not_allowed"],
    ["[click](javascript:alert(1))", "unsafe_link"],
    ["[click]( JavaScript:alert(1))", "unsafe_link"],
    ["[click](data:text/html;base64,PHNjcmlwdD4=)", "unsafe_link"],
    ["See [the doc][1].\n\n[1]: vbscript:msgbox(1)", "unsafe_link"],
  ])("refuses %j", (body, expected) => {
    expect(code(body)).toBe(expected);
  });

  test("names the first placeholder a template left unfilled", () => {
    expect(checkUpdateBody("We're seeing {symptom} on API from {regions}.")).toEqual({
      ok: false,
      error: {
        code: "unfilled_placeholder",
        message: "Replace {symptom} with the details before posting.",
      },
    });
  });
});
