import { expect, test } from "vitest";
import { fromLine } from "./email.ts";

test("the From line quotes the page's name, and encodes one outside ASCII", () => {
  expect(fromLine("Acme", "status@mail.example.com")).toBe(
    '"Acme status" <status@mail.example.com>',
  );
  expect(fromLine('Say "hi"', "s@x.io")).toBe('"Say \\"hi\\" status" <s@x.io>');
  expect(fromLine("Café", "s@x.io")).toBe(
    `=?utf-8?B?${Buffer.from("Café status").toString("base64")}?= <s@x.io>`,
  );
});
