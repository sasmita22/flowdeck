import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";

type FetchFullText = (ownerId: string, entryId: number) => Promise<unknown>;

const answerSchema = z.discriminatedUnion("kept", [
  z.object({ kept: z.literal(false) }),
  z.object({
    kept: z.literal(true),
    texts: z
      .object({ input: z.string(), output: z.string(), report: z.string() })
      .partial()
      .strict(),
  }),
]);

type KeptTexts = Extract<z.infer<typeof answerSchema>, { kept: true }>["texts"];

export type FullText =
  | { kind: "loading" }
  | { kind: "kept"; texts: KeptTexts }
  | { kind: "not-kept" }
  | { kind: "failed"; error: string };

export type FullTextState = {
  texts: Record<string, FullText>;
  request(ownerId: string, entryId: number): Promise<void>;
};

export type FullTextStore = StoreApi<FullTextState>;

const keyOf = (ownerId: string, entryId: number) => `${ownerId}:${entryId}`;

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const shownOf = (answer: unknown): FullText => {
  const parsed = answerSchema.safeParse(answer);
  if (!parsed.success) return { kind: "failed", error: "The engine sent an unreadable answer" };
  return parsed.data.kept ? { kind: "kept", texts: parsed.data.texts } : { kind: "not-kept" };
};

export const selectFullText = (
  state: Pick<FullTextState, "texts">,
  ownerId: string,
  entryId: number,
): FullText | undefined => state.texts[keyOf(ownerId, entryId)];

export const createFullTextStore = ({ fetch }: { fetch: FetchFullText }): FullTextStore =>
  createStore<FullTextState>()((set, get) => {
    const show = (key: string, text: FullText) =>
      set((state) => ({ texts: { ...state.texts, [key]: text } }));

    return {
      texts: {},

      request: async (ownerId, entryId) => {
        const key = keyOf(ownerId, entryId);
        if (get().texts[key] !== undefined) return;
        show(key, { kind: "loading" });
        try {
          show(key, shownOf(await fetch(ownerId, entryId)));
        } catch (error) {
          show(key, { kind: "failed", error: messageOf(error) });
        }
      },
    };
  });
