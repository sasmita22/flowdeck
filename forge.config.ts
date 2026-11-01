import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import { VitePlugin } from "@electron-forge/plugin-vite";
import { FuseV1Options, FuseVersion } from "@electron/fuses";
import { nativeModules } from "./native-modules.js";

const shippedModules = [...nativeModules, "node-addon-api"];
const keep = (file: string) =>
  !file ||
  file === "/package.json" ||
  file.startsWith("/.vite") ||
  file === "/node_modules" ||
  shippedModules.some(
    (m) => file === `/node_modules/${m}` || file.startsWith(`/node_modules/${m}/`),
  );

export default {
  packagerConfig: {
    name: "Flowdeck",
    prune: false,
    asar: { unpack: "**/{*.node,spawn-helper}" },
    ignore: (file: string) => !keep(file),
  },
  makers: [new MakerZIP({}, ["darwin"]), new MakerDMG({})],
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
