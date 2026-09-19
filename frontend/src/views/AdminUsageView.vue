<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BrandMark from '../components/ui/BrandMark.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import ErrorState from '../components/ui/ErrorState.vue';
import ProviderMark from '../components/ui/ProviderMark.vue';
import { fetchAdminUsageSummary, fetchAdminUsers, setAdminUserPlan } from '../api/client';
import type { AdminUsageSummary, AdminUser, UserPlan } from '../api/types';
import { useAuth } from '../composables/useAuth';
import { useToast } from '../composables/useToast';

const router = useRouter();
const auth = useAuth();
const toast = useToast();

const days = ref(7);
const summary = ref<AdminUsageSummary | null>(null);
const users = ref<AdminUser[]>([]);
const loading = ref(true);
const loadError = ref(false);
const planBusyUserId = ref<string | null>(null);

/** Users joined with their consumption (0 for users without any usage). */
const userRows = computed(() => {
  const consumption = new Map(
    (summary.value?.perUser ?? []).map((row) => [row.userId, row]),
  );
  return users.value.map((user) => {
    const usageRow = consumption.get(user.id);
    return {
      ...user,
      turns: usageRow?.turns ?? 0,
      tokens: usageRow?.tokens ?? 0,
      cost: usageRow?.cost ?? 0,
    };
  });
});

const failedShare = computed(() => {
  const totals = summary.value?.totals;
  if (!totals || totals.turns === 0) return 0;
  return Math.round((totals.failedTurns / totals.turns) * 100);
});

onMounted(load);

async function load() {
  loading.value = true;
  loadError.value = false;
  try {
    const [usageSummary, userList] = await Promise.all([
      fetchAdminUsageSummary(days.value),
      fetchAdminUsers(),
    ]);
    summary.value = usageSummary;
    users.value = userList;
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

async function setPlan(user: AdminUser) {
  const next: UserPlan = user.plan === 'premium' ? 'free' : 'premium';
  planBusyUserId.value = user.id;
  try {
    const updated = await setAdminUserPlan(user.id, next);
    const index = users.value.findIndex((row) => row.id === user.id);
    if (index !== -1) users.value[index] = updated;
    toast.success(
      next === 'premium'
        ? `طرح «${user.email}» به پریمیوم تغییر کرد — از درخواست بعدی او اعمال می‌شود.`
        : `طرح «${user.email}» به رایگان تغییر کرد — از درخواست بعدی او اعمال می‌شود.`,
    );
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'تغییر طرح ناموفق بود.');
  } finally {
    planBusyUserId.value = null;
  }
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

function goThemes() {
  void router.push({ name: 'admin-themes' });
}

function logout() {
  auth.logout();
  void router.push({ name: 'login' });
}

const numberFmt = new Intl.NumberFormat('fa-IR');
const costFmt = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 0 });

function n(value: number): string {
  return numberFmt.format(value);
}

function cost(value: number): string {
  return value > 0 ? `${costFmt.format(value)} تومان` : '—';
}
</script>

<template>
  <main class="admin">
    <header class="admin__header">
      <div class="admin__brand">
        <BrandMark :size="26" />
        <div>
          <h1 class="admin__title">مصرف و هزینه‌ها</h1>
          <p class="admin__subtitle">
            مصرف کاربران، وضعیت هر مدل و برآورد هزینه. داده‌ها از رکوردهای مصرف هر پیام تجمیع می‌شوند.
          </p>
        </div>
      </div>
      <div class="admin__header-actions">
        <AppButton variant="ghost" size="sm" @click="goModels">مدیریت مدل‌ها</AppButton>
        <AppButton variant="ghost" size="sm" @click="goBilling">مدیریت پرداخت‌ها</AppButton>
        <AppButton variant="ghost" size="sm" @click="goThemes">مدیریت پوسته‌ها</AppButton>
        <AppButton variant="ghost" size="sm" @click="goBack">بازگشت به چت</AppButton>
        <AppButton variant="ghost" size="sm" @click="logout">خروج</AppButton>
      </div>
    </header>

    <ErrorState
      v-if="loadError"
      title="بارگذاری گزارش مصرف ناموفق بود"
      description="ارتباط با سرور برقرار نشد. اتصال خود را بررسی کنید."
      action-label="تلاش دوباره"
      icon="offline"
      @action="() => load()"
    />

    <template v-else>
      <div class="admin__toolbar">
        <div class="admin__filters" role="group" aria-label="بازه زمانی">
          <button
            v-for="option in [1, 7, 30, 90]"
            :key="option"
            type="button"
            class="admin__filter"
            :class="{ 'admin__filter--active': days === option }"
            :aria-pressed="days === option"
            @click="days = option; load()"
          >
            {{ option === 1 ? 'امروز' : `${n(option)} روز` }}
          </button>
        </div>
        <AppButton variant="ghost" size="sm" :loading="loading" @click="() => load()">
          تازه‌سازی
        </AppButton>
      </div>

      <div v-if="loading" class="admin__loading">
        <AppSkeleton :lines="2" width="100%" />
        <AppSkeleton :lines="8" width="100%" />
      </div>

      <template v-else-if="summary">
        <!-- نمای کلی هزینه -->
        <div class="admin__stats">
          <div class="admin__stat">
            <span class="admin__stat-value">{{ n(summary.totals.turns) }}</span>
            <span class="admin__stat-label">پرسش‌وپاسخ</span>
          </div>
          <div class="admin__stat">
            <span class="admin__stat-value">{{ n(summary.totals.totalTokens) }}</span>
            <span class="admin__stat-label">توکن (ورودی + خروجی)</span>
          </div>
          <div class="admin__stat">
            <span class="admin__stat-value">{{ cost(summary.totals.estimatedCost) }}</span>
            <span class="admin__stat-label">برآورد هزینه</span>
          </div>
          <div class="admin__stat" :class="{ 'admin__stat--danger': summary.totals.failedTurns > 0 }">
            <span class="admin__stat-value">{{ `${n(summary.totals.failedTurns)} (${n(failedShare)}٪)` }}</span>
            <span class="admin__stat-label">ناموفق</span>
          </div>
        </div>

        <!-- روند روزانه -->
        <section class="usage__section">
          <h2 class="usage__section-title">روند روزانه</h2>
          <div class="usage__table-wrap">
            <table class="usage__table">
              <thead>
                <tr>
                  <th scope="col">تاریخ</th>
                  <th scope="col">پرسش‌وپاسخ</th>
                  <th scope="col">توکن</th>
                  <th scope="col">هزینه</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="summary.perDay.length === 0">
                  <td colspan="4" class="usage__empty">در این بازه مصرفی ثبت نشده است.</td>
                </tr>
                <tr v-for="row in summary.perDay" :key="row.date">
                  <td class="ltr">{{ row.date }}</td>
                  <td>{{ n(row.turns) }}</td>
                  <td>{{ n(row.tokens) }}</td>
                  <td>{{ cost(row.cost) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- مصرف مدل‌ها -->
        <section class="usage__section">
          <h2 class="usage__section-title">مصرف مدل‌ها</h2>
          <div class="usage__table-wrap">
            <table class="usage__table">
              <thead>
                <tr>
                  <th scope="col">مدل</th>
                  <th scope="col">ارائه‌دهنده</th>
                  <th scope="col">پرسش‌وپاسخ</th>
                  <th scope="col">توکن</th>
                  <th scope="col">هزینه</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="summary.perModel.length === 0">
                  <td colspan="5" class="usage__empty">در این بازه مصرفی ثبت نشده است.</td>
                </tr>
                <tr v-for="row in summary.perModel" :key="row.modelId ?? 'deleted'">
                  <td>{{ row.modelName ?? 'مدل حذف‌شده' }}</td>
                  <td>
                    <span v-if="row.provider" class="usage__provider">
                      <ProviderMark :provider="row.provider" :size="18" />
                    </span>
                    <span v-else>—</span>
                  </td>
                  <td>{{ n(row.turns) }}</td>
                  <td>{{ n(row.tokens) }}</td>
                  <td>{{ cost(row.cost) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- مصرف کاربران + مدیریت طرح -->
        <section class="usage__section">
          <h2 class="usage__section-title">مصرف کاربران و طرح‌ها</h2>
          <div class="usage__table-wrap">
            <table class="usage__table">
              <thead>
                <tr>
                  <th scope="col">کاربر</th>
                  <th scope="col">طرح</th>
                  <th scope="col">پرسش‌وپاسخ</th>
                  <th scope="col">توکن</th>
                  <th scope="col">هزینه</th>
                  <th scope="col"><span class="visually-hidden">تغییر طرح</span></th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="userRows.length === 0">
                  <td colspan="6" class="usage__empty">کاربری یافت نشد.</td>
                </tr>
                <tr v-for="row in userRows" :key="row.id">
                  <td class="usage__email ltr">{{ row.email }}</td>
                  <td>
                    <span
                      class="usage__plan"
                      :class="row.plan === 'premium' ? 'usage__plan--premium' : 'usage__plan--free'"
                    >
                      {{ row.plan === 'premium' ? 'پریمیوم' : 'رایگان' }}
                    </span>
                  </td>
                  <td>{{ n(row.turns) }}</td>
                  <td>{{ n(row.tokens) }}</td>
                  <td>{{ cost(row.cost) }}</td>
                  <td>
                    <AppButton
                      variant="secondary"
                      size="sm"
                      :loading="planBusyUserId === row.id"
                      :title="row.plan === 'premium' ? 'تغییر به طرح رایگان' : 'تغییر به طرح پریمیوم'"
                      @click="setPlan(row)"
                    >
                      {{ row.plan === 'premium' ? 'تبدیل به رایگان' : 'تبدیل به پریمیوم' }}
                    </AppButton>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="usage__note">
            تغییر طرح از درخواست بعدی کاربر اعمال می‌شود؛ سهمیه روزانه هر طرح از تنظیمات استقرار
            (متغیرهای محیطی QUOTA) خوانده می‌شود.
          </p>
        </section>
      </template>
    </template>
  </main>
</template>

<style scoped>
/* Admin shell — same page pattern as the other admin views (scoped copy). */
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
  font-size: 1.05rem;
}

.admin__subtitle {
  font-size: 0.78rem;
  color: var(--text-2);
}

.admin__header-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.admin__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  flex-wrap: wrap;
}

.admin__filters {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

.admin__filter {
  padding: 0.35rem 0.8rem;
  font-size: 0.78rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text-2);
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.admin__filter:hover {
  border-color: var(--border-strong);
  color: var(--text-1);
}

.admin__filter--active {
  background: var(--accent-soft);
  border-color: var(--accent-soft-border);
  color: var(--text-on-accent-soft);
}

.admin__loading {
  display: grid;
  gap: 0.8rem;
}

.admin__stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  gap: 0.7rem;
}

.admin__stat {
  display: grid;
  gap: 0.15rem;
  padding: 0.85rem 1rem;
  background: var(--surface);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
}

.admin__stat-value {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--text-1);
}

.admin__stat-label {
  font-size: 0.72rem;
  color: var(--text-3);
}

.admin__stat--danger .admin__stat-value {
  color: var(--danger, var(--warning));
}

.usage__section {
  display: grid;
  gap: 0.5rem;
}

.usage__section-title {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--text-1);
  padding-inline-start: 0.55rem;
  border-inline-start: 2px solid var(--accent);
}

.usage__table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface);
}

.usage__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
  min-width: 34rem;
}

.usage__table th {
  text-align: right;
  padding: 0.55rem 0.75rem;
  font-size: 0.72rem;
  font-weight: 500;
  color: var(--text-3);
  border-bottom: 1px solid var(--border-subtle);
  white-space: nowrap;
}

.usage__table td {
  padding: 0.55rem 0.75rem;
  color: var(--text-1);
  border-bottom: 1px solid var(--border-subtle);
}

.usage__table tbody tr:last-child td {
  border-bottom: none;
}

.usage__table tbody tr:hover td {
  background: var(--surface-2);
}

.usage__empty {
  text-align: center;
  color: var(--text-3);
  padding: 1.2rem 0.75rem !important;
}

.usage__provider {
  display: inline-flex;
  vertical-align: middle;
}

.usage__email {
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.usage__plan {
  display: inline-block;
  padding: 0.1rem 0.55rem;
  border-radius: var(--radius-full);
  font-size: 0.68rem;
}

.usage__plan--free {
  background: var(--surface-2);
  color: var(--text-2);
  border: 1px solid var(--border);
}

.usage__plan--premium {
  background: var(--accent-soft);
  color: var(--text-on-accent-soft);
  border: 1px solid var(--accent-soft-border);
}

.usage__note {
  font-size: 0.72rem;
  color: var(--text-3);
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
