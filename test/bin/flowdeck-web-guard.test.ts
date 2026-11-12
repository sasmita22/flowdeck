import { describe, expect, it } from "vitest";
import { webGuardDecision } from "../../bin/flowdeck-web-guard.js";

const fetchOf = (url: string) => ({ tool_name: "WebFetch", tool_input: { url, prompt: "x" } });

describe("webGuardDecision", () => {
  it.each([
    "https://github.com/sasmita22/flowdeck/blob/main/README.md",
    "https://raw.githubusercontent.com/sasmita22/flowdeck/main/README.md",
    "https://GITHUB.COM/x",
  ])("makes no decision for %s, so the allow list decides", (url) => {
    expect(webGuardDecision(fetchOf(url))).toBeUndefined();
  });

  it.each([
    ["https://docs.python.org/3/", "docs.python.org"],
    ["https://example.com", "example.com"],
    ["https://gist.github.com/x", "gist.github.com"],
    ["https://gist.githubusercontent.com/x", "gist.githubusercontent.com"],
    ["https://api.github.com/repos/x/y", "api.github.com"],
    ["https://codeload.github.com/x", "codeload.github.com"],
    ["https://objects.githubusercontent.com/x", "objects.githubusercontent.com"],
    ["https://github.com.evil.example/x", "github.com.evil.example"],
  ])("denies %s and names %s in the reason", (url, host) => {
    const decision = webGuardDecision(fetchOf(url));

    expect(decision).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: expect.any(String),
      },
    });
    const reason = decision?.hookSpecificOutput.permissionDecisionReason;
    expect(reason).toContain("github.com");
    expect(reason).toContain("raw.githubusercontent.com");
    expect(reason).toContain("files on this machine");
    expect(reason).toContain(`${host} is not allowed`);
  });

  const readable =
    "Only github.com and raw.githubusercontent.com links or files on this machine can be read";

  it.each([
    ["https://github.com@evil.com/x", `${readable}; evil.com is not allowed.`],
    ["https://github.com./x", `${readable}; github.com. is not allowed.`],
    ["https://gіthub.com/x", `${readable}; xn--gthub-n2e.com is not allowed.`],
    ["https://evil.com@github.com/x", `${readable}.`],
    ["https://github.com:8443/x", `${readable}.`],
    ["ftp://github.com/x", `${readable}.`],
    ["file://github.com/etc/passwd", `${readable}.`],
    ["ws://github.com/x", `${readable}.`],
    ["https://github.com\\@evil.com/", `${readable}.`],
    ["javascript:alert(1)", `${readable}.`],
    ["data:text/plain,x", `${readable}.`],
    ["blob:https://github.com/x", `${readable}.`],
    ["ftp://evil.com/", `${readable}.`],
  ])("denies %s with the reason %s", (url, reason) => {
    const decision = webGuardDecision(fetchOf(url));

    expect(decision).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
    expect(decision?.hookSpecificOutput.permissionDecisionReason).not.toContain(
      "github.com is not allowed",
    );
  });

  it.each([
    ["a malformed url", fetchOf("not a url")],
    ["no url", { tool_name: "WebFetch", tool_input: { prompt: "x" } }],
    ["no tool input", { tool_name: "WebFetch" }],
  ])("denies %s with the GitHub-and-local-files reason", (_case, input) => {
    expect(webGuardDecision(input)).toStrictEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "Only github.com and raw.githubusercontent.com links or files on this machine can be read.",
      },
    });
  });
});
