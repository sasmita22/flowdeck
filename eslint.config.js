import js from "@eslint/js";
import tseslint from "typescript-eslint";
import boundaries from "eslint-plugin-boundaries";

const layer = (from, allowed) => ({
  from: { element: { type: from } },
  allow: { to: { element: { types: { anyOf: allowed } } } },
});

export default tseslint.config(
  { ignores: ["node_modules", "out", "dist", ".claude", ".plugin-state"] },
  js.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ["src/**/*.ts", "test/**/*.ts"],
    plugins: { boundaries },
    settings: {
      "boundaries/include": ["src/**/*", "test/**/*"],
      "boundaries/elements": [
        { type: "core", pattern: "src/core" },
        { type: "ports", pattern: "src/ports" },
        { type: "adapters", pattern: "src/adapters" },
        { type: "cli", pattern: "src/cli" },
        { type: "app", pattern: "src/app" },
        { type: "test", pattern: "test" },
      ],
      "import/resolver": { typescript: { project: "./tsconfig.json" } },
    },
    rules: {
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          policies: [
            layer("core", ["core"]),
            layer("ports", ["core", "ports"]),
            layer("adapters", ["core", "ports", "adapters"]),
            layer("cli", ["core", "ports", "adapters", "cli"]),
            layer("app", ["core", "ports", "adapters", "app"]),
            layer("test", ["core", "ports", "adapters", "cli", "app", "test"]),
          ],
        },
      ],
    },
  },
);
