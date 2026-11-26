import { z } from "zod";
import { createStore, type StoreApi } from "zustand/vanilla";
import type { FlowdeckBridge } from "../preload/bridge.js";

type BranchBridge = Pick<FlowdeckBridge, "listBranches" | "pickFolder">;

export type RepoBranches = { branches: string[] | null; error: string | null };

export type BranchState = {
  byRepo: Readonly<Record<string, RepoBranches>>;
  load(repo: string): Promise<void>;
  browse(commit: (repo: string) => void): Promise<void>;
};

const branchesSchema = z.array(z.string());

const pickedSchema = z.string().nullable();

const remotePrefix = /^Error invoking remote method '[^']*': (?:Error: )?/;

const messageOf = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).replace(remotePrefix, "");

export const createBranchStore = ({ bridge }: { bridge: BranchBridge }): StoreApi<BranchState> =>
  createStore<BranchState>()((set, get) => {
    const file = (repo: string, entry: RepoBranches) =>
      set(({ byRepo }) => ({ byRepo: { ...byRepo, [repo]: entry } }));
    return {
      byRepo: {},
      load: async (repo) => {
        const wanted = repo.trim();
        const known = get().byRepo[wanted];
        if (wanted === "" || (known !== undefined && known.error === null)) return;
        file(wanted, { branches: null, error: null });
        try {
          file(wanted, {
            branches: branchesSchema.parse(await bridge.listBranches({ repo: wanted })),
            error: null,
          });
        } catch (error) {
          file(wanted, { branches: null, error: messageOf(error) });
        }
      },
      browse: async (commit) => {
        const picked = pickedSchema.parse(await bridge.pickFolder());
        if (picked === null) return;
        commit(picked);
        await get().load(picked);
      },
    };
  });
