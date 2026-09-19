<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BrandMark from '../components/ui/BrandMark.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppModal from '../components/ui/AppModal.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import AppAvatar from '../components/ui/AppAvatar.vue';
import AppSwitch from '../components/ui/AppSwitch.vue';
import ErrorState from '../components/ui/ErrorState.vue';
import ThemeToggle from '../components/ui/ThemeToggle.vue';
import AmbientGlow from '../components/ui/AmbientGlow.vue';
import ThemePreviewCard from '../components/admin/ThemePreviewCard.vue';
import {
  fetchAdminThemes,
  reorderAdminThemes,
  setAdminThemeDefault,
  setAdminThemeStatus,
} from '../api/client';
import type { AdminTheme } from '../api/types';
import { isThemeId, type ThemeId } from '../themes/registry';
import { useAuth } from '../composables/useAuth';
import { useTheme } from '../composables/useTheme';
import { useToast } from '../composables/useToast';

const router = useRouter();
const auth = useAuth();
const toast = useToast();
const themeComposable = useTheme();

const themes = ref<AdminTheme[]>([]);
const loading = ref(true);
const loadError = ref(false);
const actionBusy = ref(false);

// ---- search + filters (client-side; the list endpoint has no query params) ----
const search = ref('');
const filter = ref<ThemeFilter>('all');
type ThemeFilter = 'all' | 'active' | 'inactive';

const filters: { value: ThemeFilter; label: string }[] = [
  { value: 'all', label: 'همه' },
  { value: 'active', label: 'فعال' },
  { value: 'inactive', label: 'غیرفعال' },
];

const counts = computed<Record<ThemeFilter, number>>(() => ({
  all: themes.value.length,
  active: themes.value.filter((theme) => theme.enabled).length,
  inactive: themes.value.filter((theme) => !theme.enabled).length,
}));

const filteredThemes = computed(() => {
  const query = search.value.trim().toLowerCase();
  return themes.value.filter((theme) => {
    if (filter.value === 'active' && !theme.enabled) return false;
    if (filter.value === 'inactive' && theme.enabled) return false;
    if (!query) return true;
    return (
      theme.name.toLowerCase().includes(query) ||
      (theme.description ?? '').toLowerCase().includes(query)
    );
  });
});

onMounted(load);

async function load() {
  loading.value = true;
  loadError.value = false;
  try {
    themes.value = await fetchAdminThemes();
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

/** Persists a change, reloads the list and syncs the app-wide availability. */
async function runAction(action: () => Promise<unknown>, successMessage?: string) {
  if (actionBusy.value) return;
  actionBusy.value = true;
  try {
    await action();
    await load();
    await themeComposable.refreshAvailability();
    if (successMessage) toast.success(successMessage);
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'عملیات ناموفق بود.');
  } finally {
    actionBusy.value = false;
  }
}

function toggleStatus(theme: AdminTheme, next: boolean) {
  // Disabling the current default moves the default automatically (server
  // side) — confirm first, it changes what every NEW visitor sees.
  if (!next && theme.isDefault) {
    pendingDisableDefault.value = theme;
    return;
  }
  void runAction(
    () => setAdminThemeStatus(theme.id, next),
    next ? `پوسته «${theme.name}» فعال شد.` : `پوسته «${theme.name}» غیرفعال شد.`,
  );
}

async function disableDefaultConfirmed() {
  const theme = pendingDisableDefault.value;
  if (!theme) return;
  pendingDisableDefault.value = null;
  await runAction(
    () => setAdminThemeStatus(theme.id, false),
    `پوسته «${theme.name}» غیرفعال شد و پیش‌فرض به اولین پوسته فعال منتقل شد.`,
  );
}

function setDefault(theme: AdminTheme) {
  void runAction(() => setAdminThemeDefault(theme.id), `پوسته «${theme.name}» پیش‌فرض شد.`);
}

/** Moves a theme one step up/down and persists the full new order. */
function move(theme: AdminTheme, direction: -1 | 1) {
  const ids = themes.value.map((item) => item.id);
  const index = ids.indexOf(theme.id);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= ids.length) return;
  const reordered = [...ids];
  reordered[index] = reordered[target];
  reordered[target] = theme.id;
  void runAction(
    () => reorderAdminThemes(reordered),
    'ترتیب پوسته‌ها ذخیره شد.',
  );
}

/** Reorder always operates on the FULL list, even while a filter is active. */
function canMove(theme: AdminTheme, direction: -1 | 1): boolean {
  const index = themes.value.findIndex((item) => item.id === theme.id);
  const target = index + direction;
  return index !== -1 && target >= 0 && target < themes.value.length;
}

// ---- preview modal (with an opt-in live application on the real page) ----
const previewTheme = ref<AdminTheme | null>(null);
const livePreview = ref(false);
const pendingDisableDefault = ref<AdminTheme | null>(null);

function openPreview(theme: AdminTheme) {
  previewTheme.value = theme;
  livePreview.value = false;
}

function closePreview() {
  if (livePreview.value) {
    // Undo the temporary application — the composable repaints the real one.
    document.documentElement.dataset.theme = themeComposable.resolved.value;
  }
  previewTheme.value = null;
  livePreview.value = false;
}

function toggleLivePreview() {
  const theme = previewTheme.value;
  if (!theme) return;
  livePreview.value = !livePreview.value;
  document.documentElement.dataset.theme = livePreview.value
    ? theme.id
    : themeComposable.resolved.value;
}

onBeforeUnmount(() => {
  if (livePreview.value) {
    document.documentElement.dataset.theme = themeComposable.resolved.value;
  }
});

/** Visual metadata for the preview card; unknown server ids fall back gracefully. */
function previewIdOf(theme: AdminTheme): ThemeId | null {
  return isThemeId(theme.id) ? theme.id : null;
}

/** Rows for the template: theme + a narrowed preview id the card can render. */
const rows = computed(() =>
  filteredThemes.value.map((theme) => ({ theme, previewId: previewIdOf(theme) })),
);

function statusLabel(theme: AdminTheme): string {
  return theme.enabled ? 'فعال' : 'غیرفعال';
}

function goBack() {
  void router.push({ name: 'chat' });
}

function goModels() {
  void router.push({ name: 'admin-models' });
}

function goBilling() {
  void router.push({ name: 'admin-billing' });
}

function logout() {
  auth.logout();
  void router.push({ name: 'login' });
}
</script>

<template>
  <div class="admin-shell">
    <AmbientGlow />

    <!-- Navigation panel (desktop) — same shell as the other admin pages. -->
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
          <button type="button" class="admin-shell__menu-item" @click="goModels">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
            مدل‌های هوش مصنوعی
          </button>
          <button type="button" class="admin-shell__menu-item" @click="goBilling">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="2" y="5" width="20" height="14" rx="2" />
              <path d="M2 10h20" />
            </svg>
            مدیریت پرداخت‌ها
          </button>
          <button
            type="button"
            class="admin-shell__menu-item admin-shell__menu-item--active"
            aria-current="page"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9" />
              <path d="m12 3-2.5 6L3 12l6.5 3L12 21l2.5-6L21 12l-6.5-3Z" />
            </svg>
            مدیریت پوسته‌ها
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
          <h1 class="admin-main__title">مدیریت پوسته‌ها</h1>
          <p class="admin-main__subtitle">
            مدیریت پوسته‌های در دسترس کاربران، پوسته پیش‌فرض و ترتیب نمایش آن‌ها
          </p>
        </div>
      </header>

      <ErrorState
        v-if="loadError"
        title="بارگذاری پوسته‌ها ناموفق بود"
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
              placeholder="جستجو در پوسته‌ها…"
              aria-label="جستجو در پوسته‌ها"
            />
          </div>
          <div class="admin-main__filters" role="group" aria-label="فیلتر پوسته‌ها">
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

        <template v-else-if="filteredThemes.length === 0">
          <div class="admin-main__empty" :class="{ 'admin-main__empty--filtered': themes.length > 0 }">
            <div class="admin-main__empty-art" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="m12 3-2.5 6L3 12l6.5 3L12 21l2.5-6L21 12l-6.5-3Z" />
              </svg>
            </div>
            <h2 class="admin-main__empty-title">پوسته‌ای پیدا نشد</h2>
            <p class="admin-main__empty-text">
              {{ themes.length === 0 ? 'هنوز پوسته‌ای ثبت نشده است.' : 'موردی مطابق جستجو یا فیلتر پیدا نشد.' }}
            </p>
            <AppButton
              v-if="themes.length > 0"
              variant="ghost"
              size="sm"
              @click="search = ''; filter = 'all'"
            >
              پاک کردن فیلترها
            </AppButton>
          </div>
        </template>

        <ul v-else class="theme-list" aria-label="فهرست پوسته‌ها">
          <li
            v-for="row in rows"
            :key="row.theme.id"
            class="theme-card"
            :class="{ 'theme-card--disabled': !row.theme.enabled }"
          >
            <div class="theme-card__preview">
              <ThemePreviewCard v-if="row.previewId" :theme-id="row.previewId" size="sm" />
              <div v-else class="theme-card__preview-missing">پیش‌نمایش موجود نیست</div>
            </div>

            <div class="theme-card__info">
              <div class="theme-card__title-row">
                <h2 class="theme-card__name">{{ row.theme.name }}</h2>
                <span v-if="row.theme.isDefault" class="theme-card__badge theme-card__badge--default">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <path d="m12 2 3 6.5 7 .8-5.2 4.7 1.5 7L12 17.6 5.7 21l1.5-7L2 9.3l7-.8Z" />
                  </svg>
                  پیش‌فرض
                </span>
                <span
                  class="theme-card__badge"
                  :class="row.theme.enabled
                    ? 'theme-card__badge--active'
                    : 'theme-card__badge--inactive'"
                >
                  {{ statusLabel(row.theme) }}
                </span>
              </div>
              <p class="theme-card__description">
                {{ row.theme.description || 'بدون توضیح.' }}
              </p>
              <p class="theme-card__meta">
                شناسه: <span class="ltr">{{ row.theme.id }}</span>
                · ترتیب نمایش: {{ row.theme.sortOrder.toLocaleString('fa-IR') }}
              </p>
            </div>

            <div class="theme-card__actions">
              <label class="theme-card__switch">
                <AppSwitch
                  :model-value="row.theme.enabled"
                  :label="`فعال‌سازی پوسته ${row.theme.name}`"
                  :disabled="actionBusy"
                  @update:model-value="(next: boolean) => toggleStatus(row.theme, next)"
                />
                <span>{{ row.theme.enabled ? 'فعال' : 'غیرفعال' }}</span>
              </label>

              <div class="theme-card__buttons">
                <AppButton variant="secondary" size="sm" @click="openPreview(row.theme)">
                  پیش‌نمایش
                </AppButton>
                <AppButton
                  variant="ghost"
                  size="sm"
                  :disabled="row.theme.isDefault || !row.theme.enabled || actionBusy"
                  :title="row.theme.isDefault
                    ? 'این پوسته پیش‌فرض است'
                    : (!row.theme.enabled ? 'ابتدا پوسته را فعال کنید' : 'تنظیم به‌عنوان پیش‌فرض')"
                  @click="setDefault(row.theme)"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
                    <path d="m12 2 3 6.5 7 .8-5.2 4.7 1.5 7L12 17.6 5.7 21l1.5-7L2 9.3l7-.8Z" />
                  </svg>
                  پیش‌فرض
                </AppButton>
                <div class="theme-card__order" role="group" aria-label="تغییر ترتیب پوسته">
                  <button
                    type="button"
                    class="theme-card__order-btn"
                    :disabled="actionBusy || !canMove(row.theme, -1)"
                    aria-label="انتقال به بالا"
                    @click="move(row.theme, -1)"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="m18 15-6-6-6 6" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    class="theme-card__order-btn"
                    :disabled="actionBusy || !canMove(row.theme, 1)"
                    aria-label="انتقال به پایین"
                    @click="move(row.theme, 1)"
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <path d="m6 9 6 6 6-6" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </li>
        </ul>
      </template>
    </main>

    <!-- Live preview modal -->
    <AppModal
      v-if="previewTheme"
      :title="`پیش‌نمایش پوسته «${previewTheme.name}»`"
      size="md"
      @close="closePreview"
    >
      <div class="theme-preview-modal">
        <ThemePreviewCard
          v-if="previewIdOf(previewTheme)"
          :theme-id="previewIdOf(previewTheme)!"
          size="lg"
        />
        <p class="theme-preview-modal__description">
          {{ previewTheme.description || 'بدون توضیح.' }}
        </p>
        <p v-if="livePreview" class="theme-preview-modal__live-note">
          پیش‌نمایش زنده فعال است؛ با بستن این پنجره پوسته صفحه به حالت قبل برمی‌گردد.
        </p>
      </div>
      <template #footer>
        <AppButton
          :variant="livePreview ? 'primary' : 'secondary'"
          size="sm"
          :disabled="!previewIdOf(previewTheme)"
          @click="toggleLivePreview"
        >
          {{ livePreview ? 'پیش‌نمایش زنده روشن است' : 'پیش‌نمایش زنده روی صفحه' }}
        </AppButton>
        <AppButton variant="ghost" size="sm" @click="closePreview">بستن</AppButton>
      </template>
    </AppModal>

    <!-- Disable-default confirmation (destructive: moves the global default) -->
    <AppModal
      v-if="pendingDisableDefault"
      title="غیرفعال‌سازی پوسته پیش‌فرض"
      @close="pendingDisableDefault = null"
    >
      <p class="admin-main__confirm-text">
        «{{ pendingDisableDefault.name }}» پوسته پیش‌فرض سیستم است. با غیرفعال‌کردن آن،
        پیش‌فرض به‌صورت خودکار به اولین پوسته فعال دیگر منتقل می‌شود و کاربران تازه
        آن پوسته را خواهند دید. ادامه می‌دهید؟
      </p>
      <template #footer>
        <AppButton variant="secondary" @click="pendingDisableDefault = null">انصراف</AppButton>
        <AppButton variant="danger" :loading="actionBusy" @click="disableDefaultConfirmed">
          غیرفعال‌سازی
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
  background: var(--sidebar-bg);
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
  border-color: var(--focus-border);
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

.admin-main__confirm-text {
  font-size: 0.88rem;
  color: var(--text-1);
}

/* ---- theme cards ---- */
.theme-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 0.9rem;
}

.theme-card {
  display: grid;
  grid-template-columns: 10.5rem minmax(0, 1fr) auto;
  gap: 1.1rem;
  align-items: center;
  padding: 1rem 1.1rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  transition:
    border-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.theme-card:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-1);
}

.theme-card--disabled .theme-card__info,
.theme-card--disabled .theme-card__preview {
  opacity: 0.62;
}

.theme-card__preview {
  min-width: 0;
}

.theme-card__preview-missing {
  display: grid;
  place-items: center;
  aspect-ratio: 16 / 10;
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  font-size: 0.74rem;
  color: var(--text-3);
}

.theme-card__info {
  display: grid;
  gap: 0.3rem;
  min-width: 0;
}

.theme-card__title-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
}

.theme-card__name {
  font-size: 0.98rem;
  font-weight: 600;
}

.theme-card__badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.1rem 0.5rem;
  border-radius: var(--radius-full);
  font-size: 0.68rem;
  border: 1px solid transparent;
}

.theme-card__badge--default {
  color: var(--text-on-accent-soft);
  background: var(--accent-soft);
  border-color: var(--accent-soft-border);
}

.theme-card__badge--active {
  color: var(--success);
  background: var(--success-soft);
}

.theme-card__badge--inactive {
  color: var(--text-3);
  background: var(--surface-2);
  border-color: var(--border);
}

.theme-card__description {
  font-size: 0.82rem;
  color: var(--text-2);
  line-height: 1.7;
}

.theme-card__meta {
  font-size: 0.72rem;
  color: var(--text-3);
}

.theme-card__actions {
  display: grid;
  justify-items: end;
  gap: 0.65rem;
}

.theme-card__switch {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.76rem;
  color: var(--text-2);
  cursor: pointer;
}

.theme-card__buttons {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}

.theme-card__order {
  display: inline-flex;
  gap: 0.2rem;
  padding: 2px;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.theme-card__order-btn {
  display: grid;
  place-items: center;
  width: 1.7rem;
  height: 1.7rem;
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--text-2);
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.theme-card__order-btn:hover:not(:disabled) {
  background: var(--surface);
  color: var(--text-1);
}

.theme-card__order-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---- preview modal ---- */
.theme-preview-modal {
  display: grid;
  gap: 0.7rem;
}

.theme-preview-modal__description {
  font-size: 0.84rem;
  color: var(--text-2);
  line-height: 1.7;
}

.theme-preview-modal__live-note {
  font-size: 0.78rem;
  color: var(--accent-text);
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

/* Cards stack on tablets/phones — preview on top, actions below. */
@media (max-width: 767px) {
  .theme-card {
    grid-template-columns: 1fr;
    gap: 0.8rem;
  }

  .theme-card__preview {
    max-width: 18rem;
  }

  .theme-card__actions {
    justify-items: stretch;
  }

  .theme-card__buttons {
    justify-content: flex-start;
  }
}
</style>
