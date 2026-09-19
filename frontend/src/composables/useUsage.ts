import { readonly, ref } from 'vue';
import { fetchUsageSummary } from '../api/client';
import type { UsageSummary } from '../api/types';

/**
 * Shared quota/usage state (module singleton, same pattern as useAuth/useToast):
 * the sidebar renders the plan badge + quota line from it, and ChatView
 * refreshes it after every terminal stream event — cheap one-shot fetches,
 * no live metering. `summary === null` means "not loaded yet" (or a failed
 * load; the UI then simply hides the quota line instead of guessing).
 */
const summary = ref<UsageSummary | null>(null);
const loading = ref(false);

let inflight: Promise<void> | null = null;

async function refresh(): Promise<void> {
  if (loading.value) return inflight ?? Promise.resolve();
  loading.value = true;
  inflight = (async () => {
    try {
      summary.value = await fetchUsageSummary();
    } catch {
      // A failed quota load must never break the chat; keep the last state.
    } finally {
      loading.value = false;
      inflight = null;
    }
  })();
  return inflight;
}

export function useUsage() {
  return {
    summary: readonly(summary),
    loading: readonly(loading),
    refresh,
  };
}
