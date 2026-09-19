<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BrandMark from '../components/ui/BrandMark.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppModal from '../components/ui/AppModal.vue';
import AppDrawer from '../components/ui/AppDrawer.vue';
import AppInput from '../components/ui/AppInput.vue';
import AppSwitch from '../components/ui/AppSwitch.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import ErrorState from '../components/ui/ErrorState.vue';
import {
  createAdminPlan,
  fetchAdminAuditLogs,
  fetchAdminBillingPlans,
  fetchAdminPayments,
  fetchAdminSubscriptions,
  setAdminPlanActive,
  updateAdminPlan,
} from '../api/client';
import type {
  AdminPayment,
  AdminSubscriptionRow,
  AuditLogEntry,
  BillingPeriod,
  Plan,
  PaymentStatus,
} from '../api/types';
import { PAYMENT_STATUS_LABELS, SUBSCRIPTION_STATUS_LABELS } from '../api/types';
import { useAuth } from '../composables/useAuth';
import { useToast } from '../composables/useToast';
import { formatFullDate, formatDateTime } from '../utils/format';

const router = useRouter();
const auth = useAuth();
const toast = useToast();

type Section = 'plans' | 'payments' | 'subscriptions' | 'audit';
const SECTIONS: { value: Section; label: string }[] = [
  { value: 'plans', label: 'طرح‌ها' },
  { value: 'payments', label: 'پرداخت‌ها' },
  { value: 'subscriptions', label: 'اشتراک‌ها' },
  { value: 'audit', label: 'لاگ رویدادها' },
];

const section = ref<Section>('plans');
const loading = ref(true);
const loadError = ref(false);

const plans = ref<Plan[]>([]);
const payments = ref<AdminPayment[]>([]);
const subscriptions = ref<AdminSubscriptionRow[]>([]);
const auditLogs = ref<AuditLogEntry[]>([]);

onMounted(load);

async function load() {
  loading.value = true;
  loadError.value = false;
  try {
    // Payments/subscriptions/audit load with the section switch; plans always.
    plans.value = await fetchAdminBillingPlans();
    await loadSection();
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

async function loadSection() {
  if (section.value === 'payments') {
    payments.value = await fetchAdminPayments();
  } else if (section.value === 'subscriptions') {
    subscriptions.value = await fetchAdminSubscriptions();
  } else if (section.value === 'audit') {
    auditLogs.value = await fetchAdminAuditLogs();
  }
}

async function changeSection(next: Section) {
  if (section.value === next) return;
  section.value = next;
  try {
    await loadSection();
  } catch {
    toast.error('بارگذاری این بخش ناموفق بود.');
  }
}

// ---- plan create / edit ----

const planDrawerOpen = ref(false);
const planEditing = ref<Plan | null>(null);
const planBusy = ref(false);

const planForm = ref({
  slug: '',
  name: '',
  description: '',
  price: '',
  currency: 'IRT',
  billingPeriod: 'monthly' as BillingPeriod,
  dailyMessageQuota: '500',
  dailyTokenQuota: '',
  allowedModelIds: '',
  webSearch: false,
  thinking: false,
  fileProcessing: false,
});

function openCreatePlan() {
  planEditing.value = null;
  planForm.value = {
    slug: '',
    name: '',
    description: '',
    price: '',
    currency: 'IRT',
    billingPeriod: 'monthly',
    dailyMessageQuota: '500',
    dailyTokenQuota: '',
    allowedModelIds: '',
    webSearch: false,
    thinking: false,
    fileProcessing: false,
  };
  planDrawerOpen.value = true;
}

function openEditPlan(plan: Plan) {
  planEditing.value = plan;
  planForm.value = {
    slug: plan.slug,
    name: plan.name,
    description: plan.description ?? '',
    price: plan.price,
    currency: plan.currency,
    billingPeriod: plan.billingPeriod,
    dailyMessageQuota: String(plan.dailyMessageQuota),
    dailyTokenQuota: plan.dailyTokenQuota === null ? '' : String(plan.dailyTokenQuota),
    allowedModelIds: (plan.allowedModelIds ?? []).join(', '),
    webSearch: plan.webSearch,
    thinking: plan.thinking,
    fileProcessing: plan.fileProcessing,
  };
  planDrawerOpen.value = true;
}

function submitPlan() {
  const form = planForm.value;
  if (!form.name.trim() || form.price === '' || Number.isNaN(Number(form.price))) {
    toast.error('نام و قیمت معتبر طرح الزامی است.');
    return;
  }
  if (!planEditing.value && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(form.slug.trim())) {
    toast.error('شناسه طرح باید ترکیبی از حروف کوچک لاتین، عدد و خط تیره باشد.');
    return;
  }
  const modelIds = form.allowedModelIds
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
  const common = {
    name: form.name.trim(),
    description: form.description.trim() || null,
    price: Number(form.price),
    currency: form.currency.trim() || 'IRT',
    billingPeriod: form.billingPeriod,
    dailyMessageQuota: Number(form.dailyMessageQuota),
    dailyTokenQuota: form.dailyTokenQuota === '' ? null : Number(form.dailyTokenQuota),
    allowedModelIds: modelIds.length > 0 ? modelIds : null,
    webSearch: form.webSearch,
    thinking: form.thinking,
    fileProcessing: form.fileProcessing,
  };
  void (async () => {
    planBusy.value = true;
    try {
      if (planEditing.value) {
        await updateAdminPlan(planEditing.value.id, common);
        toast.success('طرح به‌روزرسانی شد.');
      } else {
        await createAdminPlan({ ...common, slug: form.slug.trim() });
        toast.success('طرح جدید ایجاد شد.');
      }
      planDrawerOpen.value = false;
      plans.value = await fetchAdminBillingPlans();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'ذخیره طرح ناموفق بود.');
    } finally {
      planBusy.value = false;
    }
  })();
}

// ---- activate / deactivate ----

const confirmPlan = ref<Plan | null>(null);
const confirmActive = ref(false);
const confirmBusy = ref(false);

function askSetPlanActive(plan: Plan, isActive: boolean) {
  confirmPlan.value = plan;
  confirmActive.value = isActive;
}

async function applyPlanActive() {
  if (!confirmPlan.value) return;
  confirmBusy.value = true;
  try {
    await setAdminPlanActive(confirmPlan.value.id, confirmActive.value);
    toast.success(
      confirmActive.value
        ? 'طرح فعال شد و برای خرید در دسترس است.'
        : 'طرح غیرفعال شد؛ خریدهای جدید ممکن نیست و اشتراک‌های جاری تا پایان دوره باقی می‌مانند.',
    );
    plans.value = await fetchAdminBillingPlans();
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'تغییر وضعیت طرح ناموفق بود.');
  } finally {
    confirmBusy.value = false;
    confirmPlan.value = null;
  }
}

// ---- helpers ----

function goBack() {
  void router.push({ name: 'chat' });
}

function goModels() {
  void router.push({ name: 'admin-models' });
}

function goUsage() {
  void router.push({ name: 'admin-usage' });
}

function logout() {
  auth.logout();
  void router.push({ name: 'login' });
}

const numberFmt = new Intl.NumberFormat('fa-IR');
const CURRENCY_LABELS: Record<string, string> = { IRT: 'تومان', IRR: 'ریال' };

function n(value: number): string {
  return numberFmt.format(value);
}

function money(amount: string, currency: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '—';
  return `${numberFmt.format(value)} ${CURRENCY_LABELS[currency] ?? currency}`;
}

const PERIOD_LABELS: Record<string, string> = { monthly: 'ماهانه', yearly: 'سالانه' };

const FEATURE_LABELS: Record<string, string> = {
  webSearch: 'جستجوی وب',
  thinking: 'تفکر عمیق',
  fileProcessing: 'پردازش فایل',
};

const paymentStatusCount = computed(() => {
  const counts = { pending: 0, success: 0, failed: 0, cancelled: 0 };
  for (const payment of payments.value) counts[payment.status] += 1;
  return counts;
});

const activeSubscriptionCount = computed(
  () => subscriptions.value.filter((row) => row.status === 'active').length,
);

const AUDIT_LABELS: Record<string, string> = {
  'payment.created': 'ایجاد پرداخت',
  'payment.succeeded': 'پرداخت موفق',
  'payment.failed': 'پرداخت ناموفق',
  'payment.cancelled': 'پرداخت لغو شده',
  'webhook.received': 'دریافت وب‌هوک',
  'webhook.duplicate': 'وب‌هوک تکراری',
  'webhook.ignored': 'وب‌هوک نادیده گرفته شد',
  'subscription.activated': 'فعال‌سازی اشتراک',
  'subscription.expired': 'انقضای اشتراک',
  'subscription.cancelled': 'لغو اشتراک',
  'plan.created': 'ایجاد طرح',
  'plan.updated': 'ویرایش طرح',
  'plan.activated': 'فعال‌سازی طرح',
  'plan.deactivated': 'غیرفعال‌سازی طرح',
  'access.granted': 'اعطای دسترسی',
  'access.revoked': 'سلب دسترسی',
};
</script>

<template>
  <main class="abilling">
    <header class="abilling__header">
      <div class="abilling__brand">
        <BrandMark :size="26" />
        <div>
          <h1 class="abilling__title">مدیریت پرداخت‌ها</h1>
          <p class="abilling__subtitle">
            طرح‌های اشتراک، پرداخت‌ها، اشتراک‌های فعال و لاگ رویدادهای حساس سیستم.
          </p>
        </div>
      </div>
      <div class="abilling__header-actions">
        <AppButton variant="ghost" size="sm" @click="goModels">مدیریت مدل‌ها</AppButton>
        <AppButton variant="ghost" size="sm" @click="goUsage">مصرف و هزینه‌ها</AppButton>
        <AppButton variant="ghost" size="sm" @click="goBack">بازگشت به چت</AppButton>
        <AppButton variant="ghost" size="sm" @click="logout">خروج</AppButton>
      </div>
    </header>

    <ErrorState
      v-if="loadError"
      title="بارگذاری پنل پرداخت‌ها ناموفق بود"
      description="ارتباط با سرور برقرار نشد. اتصال خود را بررسی کنید."
      action-label="تلاش دوباره"
      icon="offline"
      @action="() => load()"
    />

    <template v-else>
      <div class="abilling__toolbar">
        <div class="abilling__filters" role="group" aria-label="بخش مدیریت">
          <button
            v-for="item in SECTIONS"
            :key="item.value"
            type="button"
            class="abilling__filter"
            :class="{ 'abilling__filter--active': section === item.value }"
            :aria-pressed="section === item.value"
            @click="() => changeSection(item.value)"
          >
            {{ item.label }}
          </button>
        </div>
        <AppButton
          v-if="section === 'plans'"
          variant="primary"
          size="sm"
          @click="openCreatePlan"
        >
          ایجاد طرح جدید
        </AppButton>
      </div>

      <div v-if="loading" class="abilling__loading">
        <AppSkeleton :lines="2" width="100%" />
        <AppSkeleton :lines="8" width="100%" />
      </div>

      <template v-else>
        <!-- ==== طرح‌ها ==== -->
        <section v-if="section === 'plans'" class="abilling__section">
          <div class="abilling__table-wrap">
            <table class="abilling__table">
              <thead>
                <tr>
                  <th scope="col">نام</th>
                  <th scope="col">قیمت</th>
                  <th scope="col">سهمیه روزانه</th>
                  <th scope="col">امکانات</th>
                  <th scope="col">وضعیت</th>
                  <th scope="col">عملیات</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="plans.length === 0">
                  <td colspan="6" class="abilling__empty">
                    هنوز طرحی تعریف نشده است. با «ایجاد طرح جدید» شروع کنید.
                  </td>
                </tr>
                <tr v-for="plan in plans" :key="plan.id">
                  <td>
                    <strong>{{ plan.name }}</strong>
                    <div class="abilling__cell-note ltr">{{ plan.slug }}</div>
                  </td>
                  <td>
                    {{ money(plan.price, plan.currency) }}
                    <div class="abilling__cell-note">{{ PERIOD_LABELS[plan.billingPeriod] }}</div>
                  </td>
                  <td>
                    {{ n(plan.dailyMessageQuota) }} پیام
                    <div class="abilling__cell-note">
                      {{ plan.dailyTokenQuota !== null ? `${n(plan.dailyTokenQuota)} توکن` : 'توکن نامحدود' }}
                    </div>
                  </td>
                  <td>
                    <div class="abilling__chips">
                      <span
                        v-for="(enabled, key) in { webSearch: plan.webSearch, thinking: plan.thinking, fileProcessing: plan.fileProcessing }"
                        :key="key"
                        class="abilling__chip"
                        :class="{ 'abilling__chip--off': !enabled }"
                      >
                        {{ FEATURE_LABELS[String(key)] }}: {{ enabled ? '✓' : '—' }}
                      </span>
                      <span
                        v-if="plan.allowedModelIds !== null"
                        class="abilling__chip"
                      >
                        {{ n(plan.allowedModelIds.length) }} مدل مجاز
                      </span>
                    </div>
                  </td>
                  <td>
                    <span
                      class="abilling__status"
                      :class="plan.isActive ? 'abilling__status--success' : 'abilling__status--off'"
                    >
                      {{ plan.isActive ? 'فعال' : 'غیرفعال' }}
                    </span>
                  </td>
                  <td>
                    <div class="abilling__actions">
                      <AppButton variant="ghost" size="sm" @click="() => openEditPlan(plan)">ویرایش</AppButton>
                      <AppButton
                        v-if="plan.isActive"
                        variant="ghost"
                        size="sm"
                        @click="() => askSetPlanActive(plan, false)"
                      >
                        غیرفعال‌سازی
                      </AppButton>
                      <AppButton
                        v-else
                        variant="secondary"
                        size="sm"
                        @click="() => askSetPlanActive(plan, true)"
                      >
                        فعال‌سازی
                      </AppButton>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ==== پرداخت‌ها ==== -->
        <section v-else-if="section === 'payments'" class="abilling__section">
          <div class="abilling__chips-row">
            <span class="abilling__chip">در انتظار: {{ n(paymentStatusCount.pending) }}</span>
            <span class="abilling__chip">موفق: {{ n(paymentStatusCount.success) }}</span>
            <span class="abilling__chip">ناموفق: {{ n(paymentStatusCount.failed) }}</span>
            <span class="abilling__chip">لغو شده: {{ n(paymentStatusCount.cancelled) }}</span>
          </div>
          <div class="abilling__table-wrap">
            <table class="abilling__table">
              <thead>
                <tr>
                  <th scope="col">تاریخ</th>
                  <th scope="col">کاربر</th>
                  <th scope="col">طرح</th>
                  <th scope="col">مبلغ</th>
                  <th scope="col">وضعیت</th>
                  <th scope="col">کد پیگیری</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="payments.length === 0">
                  <td colspan="6" class="abilling__empty">هنوز پرداختی ثبت نشده است.</td>
                </tr>
                <tr v-for="payment in payments" :key="payment.id">
                  <td>{{ formatDateTime(payment.createdAt) }}</td>
                  <td class="ltr">{{ payment.userId?.slice(0, 8) ?? '—' }}…</td>
                  <td>
                    {{ payment.planSnapshot?.planName ?? '—' }}
                    <div class="abilling__cell-note ltr">{{ payment.planSnapshot?.planSlug }}</div>
                  </td>
                  <td class="ltr">{{ money(payment.amount, payment.currency) }}</td>
                  <td>
                    <span class="abilling__status" :class="`abilling__status--${payment.status}`">
                      {{ PAYMENT_STATUS_LABELS[payment.status as PaymentStatus] }}
                    </span>
                  </td>
                  <td class="ltr abilling__cell-note">{{ payment.trackingId?.slice(0, 16) ?? '—' }}…</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ==== اشتراک‌ها ==== -->
        <section v-else-if="section === 'subscriptions'" class="abilling__section">
          <div class="abilling__chips-row">
            <span class="abilling__chip">اشتراک فعال: {{ n(activeSubscriptionCount) }}</span>
          </div>
          <div class="abilling__table-wrap">
            <table class="abilling__table">
              <thead>
                <tr>
                  <th scope="col">کاربر</th>
                  <th scope="col">طرح</th>
                  <th scope="col">وضعیت</th>
                  <th scope="col">پایان دوره</th>
                  <th scope="col">پرداخت منشأ</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="subscriptions.length === 0">
                  <td colspan="5" class="abilling__empty">هنوز اشتراکی ثبت نشده است.</td>
                </tr>
                <tr v-for="row in subscriptions" :key="row.id">
                  <td class="ltr">{{ row.userId.slice(0, 8) }}…</td>
                  <td>
                    {{ row.planName }}
                    <div class="abilling__cell-note ltr">{{ row.planSlug }}</div>
                  </td>
                  <td>
                    <span
                      class="abilling__status"
                      :class="row.status === 'active' ? 'abilling__status--success' : 'abilling__status--off'"
                    >
                      {{ SUBSCRIPTION_STATUS_LABELS[row.status] }}
                    </span>
                  </td>
                  <td>{{ formatFullDate(row.currentPeriodEnd) }}</td>
                  <td class="ltr abilling__cell-note">{{ row.sourcePaymentId?.slice(0, 8) ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <!-- ==== لاگ رویدادها ==== -->
        <section v-else class="abilling__section">
          <div class="abilling__table-wrap">
            <table class="abilling__table">
              <thead>
                <tr>
                  <th scope="col">زمان</th>
                  <th scope="col">رویداد</th>
                  <th scope="col">عامل</th>
                  <th scope="col">هدف</th>
                  <th scope="col">مرجع</th>
                </tr>
              </thead>
              <tbody>
                <tr v-if="auditLogs.length === 0">
                  <td colspan="5" class="abilling__empty">رویدادی ثبت نشده است.</td>
                </tr>
                <tr v-for="log in auditLogs" :key="log.id">
                  <td>{{ formatDateTime(log.createdAt) }}</td>
                  <td>{{ AUDIT_LABELS[log.eventType] ?? log.eventType }}</td>
                  <td>{{ log.actor ?? 'سیستم' }}</td>
                  <td class="ltr abilling__cell-note">{{ log.target ?? '—' }}</td>
                  <td class="ltr abilling__cell-note">{{ log.correlationId?.slice(0, 16) ?? '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </template>
    </template>

    <!-- ایجاد/ویرایش طرح -->
    <AppDrawer
      v-if="planDrawerOpen"
      :open="true"
      :title="planEditing ? `ویرایش طرح «${planEditing.name}»` : 'ایجاد طرح جدید'"
      size="lg"
      @close="() => (planDrawerOpen = false)"
    >
      <form class="abilling__form" @submit.prevent="submitPlan">
        <AppInput
          v-if="!planEditing"
          v-model="planForm.slug"
          label="شناسه طرح (لاتین)"
          dir="ltr"
          placeholder="pro"
          hint="بعد از ایجاد قابل تغییر نیست."
        />
        <AppInput v-model="planForm.name" label="نام طرح" placeholder="حرفه‌ای" />
        <div class="abilling__form-row">
          <AppInput v-model="planForm.price" label="قیمت" dir="ltr" placeholder="200000" />
          <AppInput v-model="planForm.currency" label="واحد پول" dir="ltr" placeholder="IRT" />
        </div>
        <div class="abilling__form-field">
          <span class="abilling__form-label">دوره صورتحساب</span>
          <div class="abilling__filters">
            <button
              v-for="period in (['monthly', 'yearly'] as BillingPeriod[])"
              :key="period"
              type="button"
              class="abilling__filter"
              :class="{ 'abilling__filter--active': planForm.billingPeriod === period }"
              :aria-pressed="planForm.billingPeriod === period"
              @click="planForm.billingPeriod = period"
            >
              {{ PERIOD_LABELS[period] }}
            </button>
          </div>
        </div>
        <div class="abilling__form-row">
          <AppInput v-model="planForm.dailyMessageQuota" label="سهمیه پیام روزانه" dir="ltr" />
          <AppInput
            v-model="planForm.dailyTokenQuota"
            label="سهمیه توکن روزانه"
            dir="ltr"
            placeholder="خالی = نامحدود"
          />
        </div>
        <AppInput
          v-model="planForm.allowedModelIds"
          label="شناسه مدل‌های مجاز"
          dir="ltr"
          placeholder="خالی = همه مدل‌ها"
          hint="شناسه‌ها را با کاما جدا کنید."
        />
        <div class="abilling__form-field">
          <span class="abilling__form-label">امکانات</span>
          <label class="abilling__switch-row">
            <AppSwitch v-model="planForm.webSearch" label="جستجوی وب" />
            <span>جستجوی وب</span>
          </label>
          <label class="abilling__switch-row">
            <AppSwitch v-model="planForm.thinking" label="تفکر عمیق" />
            <span>تفکر عمیق</span>
          </label>
          <label class="abilling__switch-row">
            <AppSwitch v-model="planForm.fileProcessing" label="پردازش فایل" />
            <span>پردازش فایل</span>
          </label>
        </div>
        <div class="abilling__form-footer">
          <AppButton type="submit" variant="primary" :loading="planBusy">
            {{ planEditing ? 'ذخیره تغییرات' : 'ایجاد طرح' }}
          </AppButton>
        </div>
      </form>
    </AppDrawer>

    <!-- تأیید فعال/غیرفعال‌سازی طرح -->
    <AppModal
      v-if="confirmPlan"
      :title="confirmActive ? 'فعال‌سازی طرح' : 'غیرفعال‌سازی طرح'"
      size="sm"
      @close="() => (confirmPlan = null)"
    >
      <p class="abilling__confirm-text">
        <template v-if="!confirmActive">
          با غیرفعال‌سازی «{{ confirmPlan.name }}» خرید جدید ممکن نخواهد بود؛ اشتراک‌های فعال تا پایان
          دورهٔ خود باقی می‌مانند و سابقه پرداخت‌ها تغییری نمی‌کند.
        </template>
        <template v-else>
          طرح «{{ confirmPlan.name }}» برای خرید مجدد در دسترس قرار می‌گیرد.
        </template>
      </p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="() => (confirmPlan = null)">بازگشت</AppButton>
        <AppButton
          :variant="confirmActive ? 'primary' : 'danger'"
          size="sm"
          :loading="confirmBusy"
          @click="() => applyPlanActive()"
        >
          تأیید
        </AppButton>
      </template>
    </AppModal>
  </main>
</template>

<style scoped>
.abilling {
  min-height: 100vh;
  max-width: 76rem;
  margin-inline: auto;
  padding: 2rem 1.25rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.abilling__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.abilling__brand {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.abilling__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-1);
}

.abilling__subtitle {
  margin: 0.25rem 0 0;
  font-size: 0.85rem;
  color: var(--text-2);
}

.abilling__header-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.abilling__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.abilling__filters {
  display: inline-flex;
  gap: 0.35rem;
  padding: 0.25rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--surface);
}

.abilling__filter {
  padding: 0.3rem 0.85rem;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-2);
  font-size: 0.8rem;
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}

.abilling__filter:hover {
  color: var(--text-1);
}

.abilling__filter--active {
  background: var(--gradient-primary);
  color: var(--on-accent);
  box-shadow: var(--shadow-glow);
}

.abilling__loading {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.abilling__section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.abilling__table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
}

.abilling__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.abilling__table th {
  padding: 0.75rem 1rem;
  text-align: start;
  font-weight: 600;
  color: var(--text-3);
  border-block-end: 1px solid var(--border);
  white-space: nowrap;
}

.abilling__table td {
  padding: 0.7rem 1rem;
  color: var(--text-1);
  border-block-end: 1px solid var(--border-subtle);
  vertical-align: top;
}

.abilling__table tbody tr:last-child td {
  border-block-end: none;
}

.abilling__empty {
  text-align: center;
  color: var(--text-3);
  padding-block: 2rem;
}

.abilling__cell-note {
  color: var(--text-3);
  font-size: 0.75rem;
}

.abilling__chips,
.abilling__chips-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.abilling__chip {
  padding: 0.15rem 0.55rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: 0.72rem;
  color: var(--text-2);
  white-space: nowrap;
}

.abilling__chip--off {
  color: var(--text-3);
  background: transparent;
}

.abilling__status {
  display: inline-block;
  padding: 0.15rem 0.6rem;
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
}

.abilling__status--success {
  background: var(--success-soft);
  color: var(--success);
}

.abilling__status--pending {
  background: var(--warning-soft);
  color: var(--warning);
}

.abilling__status--failed {
  background: var(--danger-soft);
  color: var(--danger);
}

.abilling__status--cancelled,
.abilling__status--off {
  background: var(--surface-3);
  color: var(--text-3);
}

.abilling__actions {
  display: flex;
  gap: 0.35rem;
}

/* ---- plan form drawer ---- */

.abilling__form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.abilling__form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.abilling__form-field {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.abilling__form-label {
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-2);
}

.abilling__switch-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.85rem;
  color: var(--text-1);
  cursor: pointer;
}

.abilling__form-footer {
  margin-block-start: 0.5rem;
}

.abilling__confirm-text {
  margin: 0;
  font-size: 0.88rem;
  color: var(--text-2);
  line-height: 1.9;
}

@media (max-width: 640px) {
  .abilling {
    padding: 1.25rem 0.9rem 3rem;
  }

  .abilling__form-row {
    grid-template-columns: 1fr;
  }
}
</style>
