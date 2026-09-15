import "../../../packages/integrations/src/net/ssrf.ts";
import "../../../packages/integrations/src/render/slack.ts"; // hot-path-integrations-net-only
import "../../../packages/db/src/index.ts"; // hot-path-isolated
import "pg"; // hot-path-isolated
import "@trigger.dev/sdk"; // probe-no-trigger-dev
