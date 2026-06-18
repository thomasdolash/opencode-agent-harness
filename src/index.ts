import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createOpenCodeAgentHarness } from "./harness.js";
import { resolveLiveOpenCodeAgentHarnessPluginConfig } from "./config.js";
import { createOpenCodeHarnessLogger } from "./logger.js";

const plugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "opencode-agent-harness",
  name: "OpenCode Agent Harness",
  description: "Registers the native OpenCode agent harness.",
  register(api) {
    const resolveCurrentConfig = () =>
      api.runtime.config?.current ? (api.runtime.config.current() as OpenClawConfig) : undefined;
    api.registerAgentHarness(
      createOpenCodeAgentHarness({
        logger: createOpenCodeHarnessLogger(api.logger),
        resolvePluginConfig: () =>
          resolveLiveOpenCodeAgentHarnessPluginConfig(resolveCurrentConfig, api.pluginConfig),
      }),
    );
  },
});

export default plugin;
