<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BrandMark from '../components/ui/BrandMark.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppModal from '../components/ui/AppModal.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import AppAvatar from '../components/ui/AppAvatar.vue';
import ErrorState from '../components/ui/ErrorState.vue';
import ThemeToggle from '../components/ui/ThemeToggle.vue';
import AmbientGlow from '../components/ui/AmbientGlow.vue';
import ModelTable from '../components/admin/ModelTable.vue';
import AdminModelPanel, { type PanelFormValues } from '../components/admin/AdminModelPanel.vue';
import { api } from '../api/client';
import type { AiModel, CreateModelPayload, UpdateModelPayload } from '../api/types';
import { useAuth } from '../composables/useAuth';
import { useToast } from '../composables/useToast';

const router = useRouter();
const auth = useAuth();
const toast = useToast();

const models = ref<AiModel[]>([]);
const loading = ref(true);
const loadError = ref(false);
const pendingDelete = ref<AiModel | null>(null);
const actionBusy = ref(false);

/** 'create' | editing model — controls the configuration panel. */
const panelState = ref<null | { mode: 'create' } | { mode: 'edit'; model: AiModel }>(null);
const panelModel = computed(() =>
  panelState.value?.mode === 'edit' ? panelState.value.model : null,
);

// ---- search + filters (client-side; the list endpoint has no query params) ----
const search = ref('');
const filter = ref<AdminFilter>('all');
type AdminFilter = 'all' | 'active' | 'inactive' | 'free' | 'premium';

const filters: { value: AdminFilter; label: string }[] = [
  { value: 'all', label: 'همه' },
  { value: 'active', label: 'فعال' },
  { value: 'inactive', label: 'غیرفعال' },
  { value: 'free', label: 'رایگان' },
  { value: 'premium', label: 'پریمیوم' },
];

const counts = computed<Record<AdminFilter, number>>(() => ({
  all: models.value.length,
  active: models.value.filter((m) => m.isActive).length,
  inactive: models.value.filter((m) => !m.isActive).length,
  free: models.value.filter((m) => m.isFree).length,
  premium: models.value.filter((m) => !m.isFree).length,
}));

const filteredModels = computed(() => {
  const query = search.value.trim().toLowerCase();
  return models.value.filter((model) => {
    if (filter.value === 'active' && !model.isActive) return false;
    if (filter.value === 'inactive' && model.isActive) return false;
    if (filter.value === 'free' && !model.isFree) return false;
    if (filter.value === 'premium' && model.isFree) return false;
    if (!query) return true;
    return (
      model.name.toLowerCase().includes(query) ||
      model.externalModelId.toLowerCase().includes(query)
    );
  });
});

onMounted(load);

async function load() {
  loading.value = true;
  loadError.value = false;
  try {
    models.value = await api<AiModel[]>('/admin/models');
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

function openCreate() {
  panelState.value = { mode: 'create' };
}

function openEdit(model: AiModel) {
  panelState.value = { mode: 'edit', model };
}

async function submitPanel(values: PanelFormValues) {
  if (!panelState.value || actionBusy.value) return;
  actionBusy.value = true;
  try {
    if (panelState.value.mode === 'create') {
      const payload: CreateModelPayload = {
        name: values.name,
        provider: values.provider,
        externalModelId: values.externalModelId,
        baseUrl: values.baseUrl || undefined,
        apiKey: values.apiKey || undefined,
        isActive: values.isActive,
        isFree: values.isFree,
      };
      await api('/admin/models', { method: 'POST', body: payload });
      toast.success('مدل با موفقیت ساخته شد.');
    } else {
      const model = panelState.value.model;
      // An empty key field means "keep the stored key" — only send a new one.
      const payload: UpdateModelPayload = {
        name: values.name,
        provider: values.provider,
        externalModelId: values.externalModelId,
        baseUrl: values.baseUrl || null,
        ...(values.apiKey ? { apiKey: values.apiKey } : {}),
        isActive: values.isActive,
        isFree: values.isFree,
      };
      await api(`/admin/models/${model.id}`, { method: 'PATCH', body: payload });
      toast.success('تغییرات مدل ذخیره شد.');
    }
    panelState.value = null;
    await load();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'ذخیره مدل ناموفق بود.');
  } finally {
    actionBusy.value = false;
  }
}

async function setDefault(model: AiModel) {
  actionBusy.value = true;
  try {
    await api(`/admin/models/${model.id}/default`, { method: 'POST' });
    await load();
    toast.success(`«${model.name}» پیش‌فرض شد.`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'عملیات ناموفق بود.');
  } finally {
    actionBusy.value = false;
  }
}

async function setDefaultFromPanel(model: AiModel) {
  panelState.value = null;
  await setDefault(model);
}

async function toggleActive(model: AiModel) {
  actionBusy.value = true;
  try {
    await api(`/admin/models/${model.id}`, {
      method: 'PATCH',
      body: { isActive: !model.isActive },
    });
    await load();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'عملیات ناموفق بود.');
  } finally {
    actionBusy.value = false;
  }
}

async function toggleFree(model: AiModel) {
  actionBusy.value = true;
  try {
    await api(`/admin/models/${model.id}`, {
      method: 'PATCH',
      body: { isFree: !model.isFree },
    });
    await load();
  } catch (e) {
    // The backend refuses to un-free the default model (400) — surface it.
    toast.error(e instanceof Error ? e.message : 'عملیات ناموفق بود.');
  } finally {
    actionBusy.value = false;
  }
}

async function removeModel() {
  const model = pendingDelete.value;
  if (!model) return;
  actionBusy.value = true;
  try {
    await api(`/admin/models/${model.id}`, { method: 'DELETE' });
    pendingDelete.value = null;
    await load();
    toast.success(`«${model.name}» حذف شد.`);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'حذف ناموفق بود.');
  } finally {
    actionBusy.value = false;
  }
}

function goBack() {
  void router.push({ name: 'chat' });
}

function logout() {
  auth.logout();
  void router.push({ name: 'login' });
}
</script>

<template>
  <div class="admin-shell">
    <AmbientGlow />

    <!-- Navigation panel (desktop) — mirrors the reference admin sidebar. -->
    <aside class="admin-shell__nav-wrap">
      <div class="admin-shell__nav">
        <header class="admin-shell__brand">
          <BrandMark :size="30" />
          <div class="admin-shell__brand-text">
            <strong>هوش‌یار</strong>
            <span class="admin-shell__brand-chip">پنل مدیریت</span>
          </div>
        </header>

        <nav class="admin-shell__menu" aria-label="ناوبری مدیریت">
          <button
            type="button"
            class="admin-shell__menu-item admin-shell__menu-item--active"
            aria-current="page"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
            مدل‌های هوش مصنوعی
          </button>
          <button type="button" class="admin-shell__menu-item" @click="goBack">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
            </svg>
            بازگشت به چت
          </button>
        </nav>

        <footer class="admin-shell__nav-footer">
          <div class="admin-shell__user">
            <AppAvatar :name="auth.state.user?.email ?? '?'" :size="30" />
            <span class="admin-shell__user-email ltr">{{ auth.state.user?.email }}</span>
          </div>
          <div class="admin-shell__nav-footer-row">
            <ThemeToggle />
            <button
              type="button"
              class="admin-shell__logout"
              aria-label="خروج از حساب"
              title="خروج از حساب"
              @click="logout"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9" />
              </svg>
            </button>
          </div>
        </footer>
      </div>
    </aside>

    <!-- Compact top bar (mobile) -->
    <header class="admin-shell__topbar">
      <BrandMark :size="26" />
      <strong class="admin-shell__topbar-title">پنل مدیریت</strong>
      <span class="admin-shell__topbar-spacer"></span>
      <AppButton variant="ghost" size="sm" @click="goBack">بازگشت به چت</AppButton>
      <button
        type="button"
        class="admin-shell__logout"
        aria-label="خروج از حساب"
        @click="logout"
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
          <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9" />
        </svg>
      </button>
    </header>

    <!-- Main content -->
    <main class="admin-main">
      <header class="admin-main__head">
        <div class="admin-main__head-text">
          <h1 class="admin-main__title">مدل‌های هوش مصنوعی</h1>
          <p class="admin-main__subtitle">
            مدیریت مدل‌های فعال، غیرفعال و تنظیمات آن‌ها در سیستم
          </p>
        </div>
        <AppButton :loading="actionBusy && Boolean(panelState)" @click="openCreate">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          افزودن مدل
        </AppButton>
      </header>

      <ErrorState
        v-if="loadError"
        title="بارگذاری مدل‌ها ناموفق بود"
        description="ارتباط با سرور برقرار نشد. اتصال خود را بررسی کنید."
        action-label="تلاش دوباره"
        icon="offline"
        @action="load"
      />

      <template v-else>
        <div class="admin-main__toolbar">
          <div class="admin-main__search">
            <svg class="admin-main__search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.2-3.2" />
            </svg>
            <input
              v-model="search"
              type="search"
              class="admin-main__search-input"
              placeholder="جستجو در مدل‌ها…"
              aria-label="جستجو در مدل‌ها"
            />
          </div>
          <div class="admin-main__filters" role="group" aria-label="فیلتر مدل‌ها">
            <button
              v-for="item in filters"
              :key="item.value"
              type="button"
              class="admin-main__filter"
              :class="{ 'admin-main__filter--active': filter === item.value }"
              :aria-pressed="filter === item.value"
              @click="filter = item.value"
            >
              {{ item.label }}
              <span class="admin-main__filter-count">{{ counts[item.value].toLocaleString('fa-IR') }}</span>
            </button>
          </div>
        </div>

        <div v-if="loading" class="admin-main__loading">
          <AppSkeleton :lines="1" width="30%" />
          <AppSkeleton :lines="6" width="100%" />
        </div>

        <template v-else-if="models.length === 0">
          <div class="admin-main__empty">
            <div class="admin-main__empty-art" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
            </div>
            <h2 class="admin-main__empty-title">هنوز مدلی ثبت نشده است</h2>
            <p class="admin-main__empty-text">
              اولین مدل را اضافه کنید تا گفتگو برای کاربران شروع شود.
            </p>
            <AppButton variant="secondary" size="sm" @click="openCreate">افزودن اولین مدل</AppButton>
          </div>
        </template>

        <template v-else-if="filteredModels.length === 0">
          <div class="admin-main__empty admin-main__empty--filtered">
            <p>موردی مطابق جستجو یا فیلتر پیدا نشد.</p>
            <AppButton variant="ghost" size="sm" @click="search = ''; filter = 'all'">
              پاک کردن فیلترها
            </AppButton>
          </div>
        </template>

        <ModelTable
          v-else
          :models="filteredModels"
          :selected-id="panelModel?.id ?? null"
          @edit="openEdit"
          @set-default="setDefault"
          @toggle-active="toggleActive"
          @toggle-free="toggleFree"
          @remove="pendingDelete = $event"
        />
      </template>
    </main>

    <AdminModelPanel
      v-if="panelState"
      :model="panelModel"
      :saving="actionBusy"
      @submit="submitPanel"
      @close="panelState = null"
      @set-default="setDefaultFromPanel"
    />

    <AppModal
      v-if="pendingDelete"
      title="حذف مدل"
      @close="pendingDelete = null"
    >
      <p class="admin-main__confirm-text">
        آیا از حذف «{{ pendingDelete.name }}» مطمئن هستید؟ این عملیات قابل بازگشت نیست.
      </p>
      <template #footer>
        <AppButton variant="secondary" @click="pendingDelete = null">انصراف</AppButton>
        <AppButton
          variant="danger"
          :loading="actionBusy"
          @click="removeModel"
        >
          حذف مدل
        </AppButton>
      </template>
    </AppModal>
  </div>
</template>

<style scoped>
.admin-shell {
  position: relative;
  display: flex;
  align-items: stretch;
  min-height: 100dvh;
  background: var(--bg);
}

.admin-shell > * {
  position: relative;
  z-index: 1;
}

.admin-shell > .ambient-glow {
  position: absolute;
  inset: 0;
  z-index: 0;
}

/* ---- navigation panel ---- */
.admin-shell__nav-wrap {
  flex-shrink: 0;
  padding: 0.9rem;
  width: 17.5rem;
}

.admin-shell__nav {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 1rem 0.85rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.admin-shell__brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.2rem 0.3rem 1rem;
}

.admin-shell__brand-text {
  display: grid;
  gap: 0.05rem;
  line-height: 1.35;
}

.admin-shell__brand-text strong {
  font-size: 0.95rem;
}

.admin-shell__brand-chip {
  justify-self: start;
  padding: 0.02rem 0.5rem;
  border-radius: var(--radius-full);
  font-size: 0.64rem;
  color: var(--text-on-accent-soft);
  background: var(--accent-soft);
  border: 1px solid var(--accent-soft-border);
}

.admin-shell__menu {
  display: grid;
  gap: 0.25rem;
}

.admin-shell__menu-item {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.6rem 0.7rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  color: var(--text-2);
  text-align: right;
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out);
}

.admin-shell__menu-item:hover {
  background: var(--surface-2);
  color: var(--text-1);
}

.admin-shell__menu-item--active,
.admin-shell__menu-item--active:hover {
  background: var(--accent-soft);
  border-color: var(--accent-soft-border);
  color: var(--text-on-accent-soft);
  font-weight: 500;
  box-shadow: 0 2px 14px color-mix(in srgb, var(--accent) 16%, transparent);
}

.admin-shell__nav-footer {
  margin-top: auto;
  display: grid;
  gap: 0.6rem;
  border-top: 1px solid var(--border-subtle);
  padding-top: 0.8rem;
}

.admin-shell__user {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
}

.admin-shell__user-email {
  font-size: 0.76rem;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin-shell__nav-footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.admin-shell__logout {
  display: grid;
  place-items: center;
  width: 2.2rem;
  height: 2.2rem;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.admin-shell__logout:hover {
  background: var(--danger-soft);
  color: var(--danger);
}

/* ---- mobile top bar ---- */
.admin-shell__topbar {
  display: none;
  align-items: center;
  gap: 0.6rem;
  padding: 0.7rem 1rem;
  background: var(--surface-glass);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border-subtle);
}

.admin-shell__topbar-title {
  font-size: 0.9rem;
}

.admin-shell__topbar-spacer {
  flex: 1;
}

/* ---- main content ---- */
.admin-main {
  flex: 1;
  min-width: 0;
  max-width: 78rem;
  padding: 2rem 2rem 3.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.2rem;
}

.admin-main__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.admin-main__head-text {
  display: grid;
  gap: 0.25rem;
}

.admin-main__title {
  font-size: 1.35rem;
  font-weight: 700;
}

.admin-main__subtitle {
  font-size: 0.84rem;
  color: var(--text-2);
}

.admin-main__toolbar {
  display: flex;
  align-items: center;
  gap: 0.6rem 1rem;
  flex-wrap: wrap;
}

.admin-main__search {
  position: relative;
  flex: 1;
  min-width: 12rem;
  max-width: 20rem;
}

.admin-main__search-icon {
  position: absolute;
  inset-inline-start: 0.7rem;
  top: 50%;
  translate: 0 -50%;
  color: var(--text-3);
  pointer-events: none;
}

.admin-main__search-input {
  width: 100%;
  height: 2.3rem;
  padding: 0 2.1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
  outline: none;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.admin-main__search-input::-webkit-search-cancel-button {
  display: none;
}

.admin-main__search-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
}

.admin-main__filters {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
}

.admin-main__filter {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  height: 2.3rem;
  padding: 0 0.85rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  font-size: 0.8rem;
  color: var(--text-2);
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.admin-main__filter:hover {
  border-color: var(--border-strong);
  color: var(--text-1);
}

.admin-main__filter--active,
.admin-main__filter--active:hover {
  background: var(--accent-soft);
  border-color: var(--accent-soft-border);
  color: var(--text-on-accent-soft);
  font-weight: 500;
}

.admin-main__filter-count {
  font-size: 0.68rem;
  color: var(--text-3);
  background: var(--surface-2);
  padding: 0 0.4rem;
  border-radius: var(--radius-full);
  min-width: 1.3rem;
  text-align: center;
}

.admin-main__filter--active .admin-main__filter-count {
  background: color-mix(in srgb, var(--accent) 22%, transparent);
  color: var(--text-on-accent-soft);
}

.admin-main__loading {
  display: grid;
  gap: 1rem;
  padding: 1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

.admin-main__empty {
  display: grid;
  justify-items: center;
  gap: 0.5rem;
  text-align: center;
  padding: 3rem 1.5rem;
  background: var(--surface);
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-lg);
}

.admin-main__empty--filtered {
  border-style: solid;
}

.admin-main__empty-art {
  display: grid;
  place-items: center;
  width: 3rem;
  height: 3rem;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--text-on-accent-soft);
  margin-bottom: 0.3rem;
}

.admin-main__empty-title {
  font-size: 0.98rem;
}

.admin-main__empty-text {
  font-size: 0.84rem;
  color: var(--text-2);
  margin-bottom: 0.5rem;
}

.admin-main__empty--filtered p {
  font-size: 0.86rem;
  color: var(--text-2);
}

.admin-main__confirm-text {
  font-size: 0.88rem;
  color: var(--text-1);
}

@media (max-width: 1023px) {
  .admin-shell {
    flex-direction: column;
  }

  .admin-shell__nav-wrap {
    display: none;
  }

  .admin-shell__topbar {
    display: flex;
  }

  .admin-main {
    padding: 1.3rem 0.9rem 3rem;
  }

  .admin-main__title {
    font-size: 1.15rem;
  }
}
</style>
