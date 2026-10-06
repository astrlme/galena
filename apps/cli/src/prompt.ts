import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export type Check = (answer: string) => string | undefined;

/**
 * Questions on `output`, answers read line by line from `input`, so they can be typed or piped.
 * Hidden answers aren't echoed when `input` is a terminal.
 */
export function prompter(input: Readable = process.stdin, output: Writable = process.stdout) {
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })[
    Symbol.asyncIterator
  ]();
  const say = (text: string) => output.write(`${text}\n`);
  const next = async () => {
    const line = await lines.next();
    if (line.done) throw new Error("The answers ended before every question was asked.");
    return line.value as string;
  };
  const tty = input as Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => void };

  /** A line typed without echo: raw mode hands over keys, so apply backspace and Ctrl+C here. */
  const hidden = async () => {
    if (!tty.isTTY || !tty.setRawMode) return next();
    tty.setRawMode(true);
    try {
      let typed = "";
      for (const key of await next()) {
        if (key === "\u0003") throw new Error("Stopped.");
        typed = key === "\u007f" || key === "\b" ? typed.slice(0, -1) : typed + key;
      }
      return typed;
    } finally {
      tty.setRawMode(false);
      output.write("\n");
    }
  };

  const ask = async (question: string, check: Check, fallback = "", secret = false) => {
    for (;;) {
      output.write(fallback ? `${question} [${fallback}]: ` : `${question}: `);
      const answer = (secret ? await hidden() : await next()).trim() || fallback;
      const problem = check(answer);
      if (problem === undefined) return answer;
      say(problem);
    }
  };

  return {
    say,
    ask: (question: string, check: Check = () => undefined, fallback = "") =>
      ask(question, check, fallback),
    askHidden: (question: string, check: Check = () => undefined) => ask(question, check, "", true),
  };
}
