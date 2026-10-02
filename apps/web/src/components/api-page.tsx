"use client";

import { createOpenAPIPage } from "fumadocs-openapi/ui";

// No playground: on the project site it would send real requests to a live deployment.
export const APIPage = createOpenAPIPage({ playground: { enabled: false } });
