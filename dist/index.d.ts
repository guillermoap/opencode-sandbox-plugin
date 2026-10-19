import type { Plugin } from "@opencode-ai/plugin";
export type { SandboxPluginConfig } from "./config";
export declare const SandboxPlugin: Plugin;
export declare const server: Plugin;
declare const _default: {
    id: string;
    setup: (context: import("@opencode/plugin/promise/plugin").Context) => Promise<import("@opencode/plugin/promise/plugin").Cleanup | void> | import("@opencode/plugin/promise/plugin").Cleanup | void;
    server: Plugin;
};
export default _default;
