export type StoryParts = { context: string; goal: string; result: string };

const threeParts = /^\s*Context:([\s\S]*?)\nGoal:([\s\S]*?)\nResult:([\s\S]*)$/;

export function storyPartsOf(text: string): StoryParts | undefined {
  const match = threeParts.exec(text);
  if (!match) return undefined;
  const [, context = "", goal = "", result = ""] = match;
  return { context: context.trim(), goal: goal.trim(), result: result.trim() };
}
