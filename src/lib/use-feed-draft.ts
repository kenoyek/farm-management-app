"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "./client";
import { DraftController, INITIAL_DRAFT_STATE } from "./draft-controller";
import type { DraftContent, DraftResponse, SavedDraft } from "./draft-schema";
export function useFeedDraft(
  org: string,
  enabled: boolean,
  content: DraftContent,
  restore: (content: DraftContent) => void,
) {
  const [controller] = useState(
    () =>
      new DraftController({
        organizationId: org,
        restore,
        storage: () => window.sessionStorage,
        read: () =>
          api<DraftResponse>(`formulation-draft?organizationId=${org}`),
        write: (expectedRevision, content, actorId) =>
          api<SavedDraft>(
            "formulation-draft",
            { organizationId: org, actorId, expectedRevision, content },
            { keepalive: true },
          ),
      }),
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.snapshot,
    () => INITIAL_DRAFT_STATE,
  );
  useEffect(() => {
    if (!enabled) return;
    void controller.load();
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (controller.snapshot().dirty) {
        void controller.flush();
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      controller.dispose();
    };
  }, [controller, enabled]);
  useEffect(() => {
    if (enabled) controller.update(content);
  }, [controller, content, enabled]);
  return {
    state,
    flush: controller.flush,
    load: () => controller.load(true),
    current: controller.current,
  };
}
