import type {PersistedState, StateStore} from "./types.js";

export interface HostKeyValueStorage {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
}

export class HostStateStore implements StateStore {
  constructor(
    private readonly storage: HostKeyValueStorage,
    private readonly key = "dsh-longtask-notice/state/v1",
  ) {}

  async load(): Promise<PersistedState | null> {
    const value = await this.storage.get(this.key);
    if (!value || typeof value !== "object") {
      return null;
    }
    return value as PersistedState;
  }

  async save(state: PersistedState): Promise<void> {
    await this.storage.set(this.key, state);
  }
}

export class MemoryStateStore implements StateStore {
  private value: PersistedState | null = null;

  async load(): Promise<PersistedState | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  async save(state: PersistedState): Promise<void> {
    this.value = structuredClone(state);
  }
}
