import {
  draftContent,
  type DraftContent,
  type DraftResponse,
  type SavedDraft,
} from "./draft-schema";
export const EMPTY_DRAFT: DraftContent = {
  modelVersion: 1,
  name: "My feed recipe",
  batchKg: 1000,
  profileId: null,
  parentId: null,
  lines: [],
};
export type DraftState = {
  ready: boolean;
  dirty: boolean;
  saving: boolean;
  conflict: boolean;
  error: string;
  warning: string;
  savedAt: string | null;
};
export const INITIAL_DRAFT_STATE: DraftState = {
  ready: false,
  dirty: false,
  saving: false,
  conflict: false,
  error: "",
  warning: "",
  savedAt: null,
};
type Recovery = { revision: number; content: DraftContent };
type Dependencies = {
  read: () => Promise<DraftResponse>;
  write: (
    revision: number,
    content: DraftContent,
    actorId: string,
  ) => Promise<SavedDraft>;
  storage: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
  restore: (content: DraftContent) => void;
  organizationId: string;
  delay?: number;
};
const serialize = (value: DraftContent) =>
  JSON.stringify(draftContent.parse(value));
export class DraftController {
  private state: DraftState = INITIAL_DRAFT_STATE;
  private listeners = new Set<() => void>();
  private content = EMPTY_DRAFT;
  private saved = serialize(EMPTY_DRAFT);
  private revision = 0;
  private recoveryBase: number | null = null;
  private key = "";
  private actorId = "";
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: Promise<void> | null = null;
  private generation = 0;
  constructor(private deps: Dependencies) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  snapshot = () => this.state;
  current = () => this.content;
  private emit(patch: Partial<DraftState>) {
    this.state = {
      ...this.state,
      ...patch,
      dirty: serialize(this.content) !== this.saved,
    };
    this.listeners.forEach((listener) => listener());
  }
  private remember() {
    if (!this.key) return;
    try {
      const storage = this.deps.storage();
      if (serialize(this.content) === this.saved) storage.removeItem(this.key);
      else
        storage.setItem(
          this.key,
          JSON.stringify({
            revision: this.recoveryBase ?? this.revision,
            content: this.content,
          }),
        );
    } catch {
      this.emit({
        warning:
          "Browser recovery is unavailable. Keep this page open until changes are saved.",
      });
    }
  }
  async load(discardLocal = false) {
    const generation = ++this.generation;
    this.emit({ ready: false });
    // Explicit reload happens only after a save settles, so a late response cannot
    // replace the newly loaded revision or discard edits behind the user's back.
    if (this.flight) await this.flight;
    try {
      const response = await this.deps.read();
      if (generation !== this.generation) return;
      const server = response.draft
        ? draftContent.parse(response.draft.content)
        : EMPTY_DRAFT;
      this.actorId = response.actorId;
      this.key = `farmstead-draft:${this.deps.organizationId}:${response.actorId}`;
      this.revision = response.draft?.revision ?? 0;
      this.saved = serialize(server);
      let recovery: Recovery | null = null;
      let warning = "";
      if (!discardLocal) {
        try {
          const text = this.deps.storage().getItem(this.key);
          if (text) {
            const parsed = JSON.parse(text);
            if (!Number.isInteger(parsed.revision) || parsed.revision < 0)
              throw Error("invalid recovery revision");
            recovery = {
              revision: parsed.revision,
              content: draftContent.parse(parsed.content),
            };
          }
        } catch {
          warning =
            "Local recovery could not be read. The saved draft was loaded.";
        }
      }
      this.content = recovery?.content ?? server;
      const conflict =
        !!recovery &&
        serialize(recovery.content) !== this.saved &&
        recovery.revision !== this.revision;
      this.recoveryBase = conflict ? recovery!.revision : null;
      this.deps.restore(this.content);
      this.emit({
        ready: true,
        saving: false,
        conflict,
        error: conflict
          ? "The saved draft changed while local edits were pending. Download your local copy before loading the saved draft."
          : "",
        warning,
        savedAt: response.draft?.updated_at ?? null,
      });
      this.remember();
      if (this.state.dirty && !conflict) this.schedule();
    } catch (e) {
      if (generation === this.generation)
        this.emit({
          error: `Draft could not be loaded: ${(e as Error).message}`,
          ready: false,
        });
    }
  }
  update(raw: DraftContent) {
    if (!this.state.ready) return;
    const content = draftContent.parse(raw);
    if (serialize(content) === serialize(this.content)) return;
    this.content = content;
    this.remember();
    this.emit({});
    if (!this.state.conflict) this.schedule();
  }
  private schedule() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.deps.delay ?? 700);
  }
  flush = (): Promise<void> => {
    clearTimeout(this.timer);
    if (this.flight) return this.flight;
    if (!this.state.ready || this.state.conflict || !this.state.dirty)
      return Promise.resolve();
    const sent = this.content;
    const expected = this.revision;
    this.emit({ saving: true, error: "" });
    this.flight = (async () => {
      try {
        let saved: SavedDraft;
        try {
          saved = await Promise.resolve().then(() =>
            this.deps.write(expected, sent, this.actorId),
          );
        } catch (e) {
          // A response can be lost after a successful write. Accept it only if a
          // fresh read proves the server holds precisely the submitted content.
          if ((e as { status?: number }).status !== 409) throw e;
          const response = await this.deps.read();
          if (response.actorId !== this.actorId)
            throw Error(
              "The signed-in account changed. Reload the application before saving.",
            );
          const current = response.draft;
          if (!current || serialize(current.content) !== serialize(sent)) {
            this.emit({
              conflict: true,
              error:
                "This draft changed in another tab. Your local edits are kept. Download a copy or load the saved draft.",
            });
            return;
          }
          saved = current;
        }
        this.recoveryBase = null;
        this.revision = saved.revision;
        this.saved = serialize(saved.content);
        this.remember();
        this.emit({ savedAt: saved.updated_at });
      } catch (e) {
        this.emit({ error: `Draft not saved: ${(e as Error).message}` });
      } finally {
        this.flight = null;
        this.emit({ saving: false });
        if (this.state.dirty && !this.state.error && !this.state.conflict)
          this.schedule();
      }
    })();
    return this.flight;
  };
  dispose() {
    ++this.generation;
    clearTimeout(this.timer);
    void this.flush();
  }
}
