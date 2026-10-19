import { type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
export interface SandboxPluginConfig {
    disabled?: boolean;
    mode?: "permissive" | "enforce";
    filesystem?: {
        denyRead?: string[];
        allowRead?: string[];
        allowWrite?: string[];
        denyWrite?: string[];
    };
    network?: {
        allowedDomains?: string[];
        deniedDomains?: string[];
        allowUnixSockets?: string[];
        allowAllUnixSockets?: boolean;
        allowLocalBinding?: boolean;
    };
}
export declare function resolveConfig(projectDir: string, worktree: string, user?: SandboxPluginConfig): SandboxRuntimeConfig;
export declare function getConfigDir(): string;
export declare function loadConfig(projectDir: string, strict?: boolean): Promise<SandboxPluginConfig>;
