import { Step, Steps } from "fumadocs-ui/components/steps";
import { Tab, Tabs } from "fumadocs-ui/components/tabs";
import defaultMdxComponents from "fumadocs-ui/mdx";
import type { MDXComponents } from "mdx/types";
import type { ComponentProps } from "react";
import { Diagram } from "./diagram.tsx";

/** A wide table scrolls sideways on a phone; taking focus lets keyboard users scroll it too. */
function Table(props: ComponentProps<"table">) {
  return (
    // A named section is a region, so a screen reader says what the stop is.
    <section
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
      tabIndex={0}
      aria-label="Table"
      className="relative my-6 overflow-auto prose-no-margin"
    >
      <table {...props} />
    </section>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    table: Table,
    Diagram,
    Step,
    Steps,
    Tab,
    Tabs,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
