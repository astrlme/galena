import { loader, multiple } from "fumadocs-core/source";
import { defineDocs } from "fumadocs-mdx/macro";
import { openapiPlugin } from "fumadocs-openapi/server";
import { openapi } from "./openapi.ts";

// The docs: MDX in content/docs, plus one API reference page per OpenAPI tag, under /docs.
const docs = defineDocs({ dir: "content/docs" });

export const source = loader(
  multiple({
    docs: docs.toFumadocsSource(),
    openapi: await openapi.staticSource({ per: "tag", baseDir: "reference/api" }),
  }),
  { baseUrl: "/docs", plugins: [openapiPlugin()] },
);
