// Lets plain Node load .tsx (the email templates); .ts runs on Node's own type stripping.
// Use as `node --import ./scripts/register-tsx.mjs …`.
import { register } from "node:module";

register("./tsx-loader.mjs", import.meta.url);
