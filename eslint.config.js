import js from "@eslint/js";
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";
import { builtinModules } from "node:module";

const rendererNoNode = "The renderer has no Node access; go through the preload bridge.";

const layer = (from, allowed) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: allowed } } } },
});

export default tseslint.config(
  {
    ignores: [
      "node_modules",
      "out",
      "dist",
      ".claude",
      ".plugin-state",
      ".vite",
      "test-results",
      "playwright-report",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["src/**/*.{ts,tsx}", "test/**/*.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/include": ["src/**/*", "test/**/*"],
      "boundaries/elements": [
        { type: "core", pattern: "src/core" },
        { type: "ports", pattern: "src/ports" },
        { type: "adapters", pattern: "src/adapters" },
        { type: "cli", pattern: "src/cli" },
        { type: "app-main", pattern: "src/app/main" },
        { type: "app-engine", pattern: "src/app/engine" },
        { type: "app-preload", pattern: "src/app/preload" },
        { type: "app-renderer", pattern: "src/app/renderer" },
        { type: "test", pattern: "test" },
      ],
      "import/resolver": {
        typescript: { project: ["./tsconfig.json", "./tsconfig.renderer.json"] },
      },
    },
    rules: {
      "boundaries/no-unknown-files": "error",
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          policies: [
            layer("core", ["core"]),
            layer("ports", ["core", "ports"]),
            layer("adapters", ["core", "ports", "adapters"]),
            layer("cli", ["core", "ports", "adapters", "cli"]),
            layer("app-main", [
              "core",
              "ports",
              "adapters",
              "app-main",
              "app-engine",
              "app-preload",
            ]),
            layer("app-engine", ["core", "ports", "adapters", "app-engine"]),
            layer("app-preload", ["app-preload"]),
            {
              from: { element: { type: "app-renderer" } },
              allow: [
                { to: { element: { type: "app-renderer" } } },
                { to: { element: { type: "core" } } },
                { to: { element: { type: "app-preload" } }, dependency: { kind: "type" } },
              ],
            },
            layer("test", [
              "core",
              "ports",
              "adapters",
              "cli",
              "app-main",
              "app-engine",
              "app-preload",
              "app-renderer",
              "test",
            ]),
          ],
        },
      ],
    },
  },
  {
    files: ["src/app/renderer/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["electron", ...builtinModules.filter((name) => !name.startsWith("node:"))].map(
            (name) => ({ name, message: rendererNoNode }),
          ),
          patterns: [{ group: ["node:*", "electron/*"], message: rendererNoNode }],
        },
      ],
    },
  },
);
