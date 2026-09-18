<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BrandMark from '../components/ui/BrandMark.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import ErrorState from '../components/ui/ErrorState.vue';
import FileTable from '../components/admin/FileTable.vue';
import { api } from '../api/client';
import type { AdminChatFile, AdminFilesResponse, AdminFileStatsResponse, ChatFileStatus } from '../api/types';
import { useAuth } from '../composables/useAuth';
import { useToast } from '../composables/useToast';

const router = useRouter();
const auth = useAuth();
const toast = useToast();

const files = ref<AdminChatFile[]>([]);
const counts = ref<AdminFilesResponse['counts'] | null>(null);
const queue = ref<AdminFileStatsResponse['queue']>(null);
const loading = ref(true);
const loadError = ref(false);
const actionBusy = ref(false);
const statusFilter = ref<ChatFileStatus | ''>('');

/** Rows still being worked on: the view refreshes itself while any exist. */
const hasInFlight = computed(() =>
  files.value.some((file) => file.status === 'UPLOADING' || file.status === 'PROCESSING'),
);
let poller: number | null = null;

onMounted(async () => {
  await load();
  poller = window.setInterval(() => {
    if (hasInFlight.value && !loading.value) void load({ silent: true });
  }, 5000);
});

onBeforeUnmount(() => {
  if (poller !== null) window.clearInterval(poller);
  poller = null;
});

async function load({ silent = false }: { silent?: boolean } = {}) {
  if (!silent) loading.value = true;
  loadError.value = false;
  try {
    const query = statusFilter.value ? `?status=${statusFilter.value}&limit=100` : '?limit=100';
    const [list, stats] = await Promise.all([
      api<AdminFilesResponse>(`/admin/files${query}`),
      api<AdminFileStatsResponse>('/admin/files/stats'),
    ]);
    files.value = list.items;
    counts.value = list.counts;
    queue.value = stats.queue;
  } catch {
    if (!silent) loadError.value = true;
  } finally {
    if (!silent) loading.value = false;
  }
}

async function applyFilter(status: ChatFileStatus | '') {
  statusFilter.value = status;
  await load();
}

async function reprocess(file: AdminChatFile) {
  actionBusy.value = true;
  try {
    await api(`/admin/files/${file.id}/reprocess`, { method: 'POST' });
    await load();
    toast.success(`پردازش «${file.originalName}» دوباره در صف قرار گرفت.`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'عملیات ناموفق بود.');
  } finally {
    actionBusy.value = false;
  }
}

function goBack() {
  void router.push({ name: 'chat' });
}

function goModels() {
  void router.push({ name: 'admin-models' });
}

function logout() {
  auth.logout();
  void router.push({ name: 'login' });
}
</script>

<template>
  <main class="admin">
    <header class="admin__header">
      <div class="admin__brand">
        <BrandMark :size="26" />
        <div>
          <h1 class="admin__title">وضعیت پردازش فایل‌ها</h1>
          <p class="admin__subtitle">
            فایل‌های آپلودشده، وضعیت پردازش و خطاها. فایل‌های ناموفق را می‌توانید دوباره در صف پردازش قرار دهید.
          </p>
        </div>
      </div>
      <div class="admin__header-actions">
        <AppButton variant="ghost" size="sm" @click="goModels">مدیریت مدل‌ها</AppButton>
        <AppButton variant="ghost" size="sm" @click="goBack">بازگشت به چت</AppButton>
        <AppButton variant="ghost" size="sm" @click="logout">خروج</AppButton>
      </div>
    </header>

    <ErrorState
      v-if="loadError"
      title="بارگذاری فایل‌ها ناموفق بود"
      description="ارتباط با سرور برقرار نشد. اتصال خود را بررسی کنید."
      action-label="تلاش دوباره"
      icon="offline"
      @action="() => load()"
    />

    <template v-else>
      <div v-if="counts" class="admin__stats">
        <div class="admin__stat">
          <span class="admin__stat-value">{{ counts.total.toLocaleString('fa-IR') }}</span>
          <span class="admin__stat-label">کل فایل‌ها</span>
        </div>
        <div class="admin__stat">
          <span class="admin__stat-value">{{ counts.READY.toLocaleString('fa-IR') }}</span>
          <span class="admin__stat-label">آماده</span>
        </div>
        <div class="admin__stat" :class="{ 'admin__stat--attention': counts.PROCESSING > 0 }">
          <span class="admin__stat-value">{{ counts.PROCESSING.toLocaleString('fa-IR') }}</span>
          <span class="admin__stat-label">در حال پردازش</span>
        </div>
        <div class="admin__stat" :class="{ 'admin__stat--danger': counts.FAILED > 0 }">
          <span class="admin__stat-value">{{ counts.FAILED.toLocaleString('fa-IR') }}</span>
          <span class="admin__stat-label">ناموفق</span>
        </div>
        <div v-if="queue" class="admin__stat">
          <span class="admin__stat-value">
            {{ (queue.waiting + queue.active).toLocaleString('fa-IR') }}
          </span>
          <span class="admin__stat-label">در صف پردازش</span>
        </div>
      </div>

      <div class="admin__toolbar">
        <div class="admin__filters" role="group" aria-label="فیلتر وضعیت">
          <button
            v-for="option in [
              { value: '', label: 'همه' },
              { value: 'PROCESSING', label: 'در حال پردازش' },
              { value: 'READY', label: 'آماده' },
              { value: 'FAILED', label: 'ناموفق' },
            ]"
            :key="option.label"
            type="button"
            class="admin__filter"
            :class="{ 'admin__filter--active': statusFilter === option.value }"
            :aria-pressed="statusFilter === option.value"
            @click="applyFilter(option.value as ChatFileStatus | '')"
          >
            {{ option.label }}
          </button>
        </div>
        <AppButton variant="ghost" size="sm" :loading="loading" @click="() => load()">
          تازه‌سازی
        </AppButton>
      </div>

      <div v-if="loading" class="admin__loading">
        <AppSkeleton :lines="1" width="30%" />
        <AppSkeleton :lines="6" width="100%" />
      </div>

      <FileTable v-else :files="files" :busy="actionBusy" @reprocess="reprocess" />

      <p v-if="!loading && files.length === 0" class="admin__empty">
        فایلی با این فیلتر یافت نشد.
      </p>
    </template>
  </main>
</template>

<style scoped>
.admin {
  max-width: 76rem;
  margin: 0 auto;
  padding: 2rem 1.4rem 3rem;
  display: grid;
  gap: 1.2rem;
}

.admin__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.admin__brand {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.admin__title {
  font-size: 1.1rem;
}

.admin__subtitle {
  font-size: 0.8rem;
  color: var(--text-2);
}

.admin__header-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.admin__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
  gap: 0.7rem;
}

.admin__stat {
  display: grid;
  gap: 0.15rem;
  padding: 0.7rem 0.9rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}

.admin__stat--attention {
  border-color: color-mix(in srgb, var(--info) 30%, transparent);
  background: color-mix(in srgb, var(--info) 6%, var(--surface));
}

.admin__stat--danger {
  border-color: color-mix(in srgb, var(--danger) 30%, transparent);
  background: var(--danger-soft);
}

.admin__stat-value {
  font-size: 1.15rem;
  font-weight: 600;
  color: var(--text-1);
}

.admin__stat-label {
  font-size: 0.72rem;
  color: var(--text-3);
}

.admin__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.7rem;
  flex-wrap: wrap;
}

.admin__filters {
  display: flex;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.admin__filter {
  padding: 0.28rem 0.8rem;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 0.76rem;
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out);
}

.admin__filter:hover {
  border-color: var(--border-strong);
}

.admin__filter--active {
  background: var(--accent-soft);
  color: var(--text-on-accent-soft);
  border-color: var(--accent-soft-border);
}

.admin__loading {
  display: grid;
  gap: 1rem;
  padding: 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

.admin__empty {
  padding: 2rem;
  text-align: center;
  color: var(--text-2);
  font-size: 0.88rem;
  background: var(--surface);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
}
</style>
