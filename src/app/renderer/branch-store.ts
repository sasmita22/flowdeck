import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { FlowdeckBridge } from "../preload/bridge.js";

export type BranchBridge = Pick<FlowdeckBridge, "listBranches">;

export type BranchState = {
  repo: string | null;
  branches: string[] | null;
  error: string | null;
  load(repo: string): Promise<void>;
};

const branchesSchema = z.array(z.string());

const remotePrefix = /^Error invoking remote method '[^']*': (?:Error: )?/;

const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(remotePrefix, "");

export const createBranchStore = ({ bridge }: { bridge: BranchBridge }): StoreApi<BranchState> =>
  createStore<BranchState>()((set, get) => {
    let latest = 0;
    return {
      repo: null,
      branches: null,
      error: null,
      load: async (repo) => {
        const wanted = repo.trim();
        if (wanted === "") {
          latest += 1;
          set({ repo: null, branches: null, error: null });
          return;
        }
        if (wanted === get().repo) return;
        const asked = ++latest;
        set({ repo: wanted, branches: null, error: null });
        try {
          const reply = branchesSchema.parse(await bridge.listBranches({ repo: wanted }));
          if (asked === latest) set({ branches: reply });
        } catch (error) {
          if (asked === latest) set({ error: messageOf(error) });
        }
      },
    };
  });
