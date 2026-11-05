"use client";

import { useEffect, useState } from "react";

const NAMES = ["ink", "slate", "mist", "ash"] as const;
export type Tokens = Record<(typeof NAMES)[number], string>;

const read = (): Tokens => {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(
    NAMES.map((name) => [name, style.getPropertyValue(`--${name}`).trim()]),
  ) as Tokens;
};

/**
 * The colour tokens as their current values, for drawing on a canvas, which can't use CSS
 * variables. Read again when the theme changes: the system's, or the page's `data-theme`.
 * Undefined until mounted.
 */
export function useTokens(): Tokens | undefined {
  const [tokens, setTokens] = useState<Tokens>();
  useEffect(() => {
    const update = () => setTokens(read());
    update();
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", update);
    const attributes = new MutationObserver(update);
    attributes.observe(document.documentElement, { attributeFilter: ["data-theme"] });
    return () => {
      media.removeEventListener("change", update);
      attributes.disconnect();
    };
  }, []);
  return tokens;
}
