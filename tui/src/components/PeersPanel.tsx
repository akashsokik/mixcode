import type { Session } from "../../../shared/events.ts";
import { pendingDelegations } from "../util/blocks";

export type PeersPanelProps = {
  session: Session | null;
  width: number;
  streamingMessageId: string | null;
};

export function PeersPanel({ session, streamingMessageId }: PeersPanelProps) {
  const pending = pendingDelegations(session, streamingMessageId);
  if (pending.length === 0) return null;
  // Visible rendering arrives in Task 4 — for now just emit a placeholder so
  // we can verify mount/unmount behaviour in isolation.
  return null;
}
