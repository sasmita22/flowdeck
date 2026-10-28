import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

export default {
  packagerConfig: { asar: true },
  makers: [],
  plugins: [
    new VitePlugin({
      build: [
        { entry: "src/app/main/main.ts", config: "vite.node.config.ts", target: "main" },
        { entry: "src/app/engine/engine.ts", config: "vite.engine.config.ts", target: "main" },
        { entry: "src/app/preload/preload.ts", config: "vite.node.config.ts", target: "preload" },
      ],
      renderer: [{ name: "main_window", config: "vite.renderer.config.ts" }],
    }),
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
