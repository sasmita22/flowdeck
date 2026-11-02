import { z } from "zod";
import type { McpServer } from "../compiler/connectors.js";

const settingSchema = z.object({ name: z.string(), set: z.boolean() });

const installedSchema = z.object({
  name: z.string(),
  status: z.enum(["ok", "missing-setting"]),
  settings: z.array(settingSchema),
});

const neededSchema = z.object({
  name: z.string(),
  status: z.enum(["ok", "missing", "missing-setting"]),
  settings: z.array(settingSchema),
  fix: z.string().nullable(),
});

export const doctorReportSchema = z.object({
  installed: z.array(installedSchema),
  needed: z.array(neededSchema),
});

export type ConnectorSetting = z.infer<typeof settingSchema>;
export type InstalledConnector = z.infer<typeof installedSchema>;
export type NeededConnector = z.infer<typeof neededSchema>;
export type DoctorReport = z.infer<typeof doctorReportSchema>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const filled = (value: unknown): boolean =>
  value !== undefined && value !== null && String(value).trim() !== "";

const settingsOf = (server: McpServer): ConnectorSetting[] => {
  if (!filled(server["command"]) && !filled(server["url"])) {
    return [{ name: "command or url", set: false }];
  }
  return ["env", "headers"].flatMap((key) => {
    const values = server[key];
    return isRecord(values)
      ? Object.entries(values).map(([name, value]) => ({ name, set: filled(value) }))
      : [];
  });
};

const describeServer = (name: string, server: McpServer): InstalledConnector => {
  const settings = settingsOf(server);
  return {
    name,
    status: settings.every((setting) => setting.set) ? "ok" : "missing-setting",
    settings,
  };
};

const fixFor = (connector: InstalledConnector): string | null => {
  const empty = connector.settings.filter((setting) => !setting.set).map(({ name }) => name);
  if (empty.length === 0) return null;
  return `Fill in ${empty.join(", ")} for "${connector.name}" under "mcpServers" in ~/.claude.json, then build again.`;
};

export function diagnoseConnectors(
  installed: Readonly<Record<string, McpServer>>,
  needed: readonly string[],
): DoctorReport {
  const described = Object.keys(installed)
    .sort()
    .flatMap((name) => {
      const server = installed[name];
      return server === undefined ? [] : [describeServer(name, server)];
    });
  return {
    installed: described,
    needed: needed.map((name): NeededConnector => {
      const found = described.find((connector) => connector.name === name);
      if (found === undefined) {
        return {
          name,
          status: "missing",
          settings: [],
          fix: `Add it for your user with \`claude mcp add --scope user ${name} …\`, then build again.`,
        };
      }
      return { ...found, fix: fixFor(found) };
    }),
  };
}
