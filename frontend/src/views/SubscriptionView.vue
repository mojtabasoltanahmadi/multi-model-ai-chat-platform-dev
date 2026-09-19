<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BrandMark from '../components/ui/BrandMark.vue';
import AppButton from '../components/ui/AppButton.vue';
import AppModal from '../components/ui/AppModal.vue';
import AppSkeleton from '../components/ui/AppSkeleton.vue';
import ErrorState from '../components/ui/ErrorState.vue';
import {
  cancelMyPayment,
  cancelMySubscription,
  createPayment,
  fetchBillingPlans,
  fetchMyPayments,
  fetchSubscriptionOverview,
  simulatePayment,
} from '../api/client';
import type {
  Plan,
  SubscriptionOverview,
  UserPaymentView,
} from '../api/types';
import { PAYMENT_STATUS_LABELS } from '../api/types';
import { useToast } from '../composables/useToast';
import { useUsage } from '../composables/useUsage';
import { formatFullDate, formatDateTime } from '../utils/format';

const router = useRouter();
const toast = useToast();
const usage = useUsage();

const overview = ref<SubscriptionOverview | null>(null);
const plans = ref<Plan[]>([]);
const payments = ref<UserPaymentView[]>([]);
const loading = ref(true);
const loadError = ref(false);

/** Checkout modal: the PENDING payment being processed in the simulator. */
const checkoutPayment = ref<UserPaymentView | null>(null);
const checkoutBusy = ref(false);

const confirmCancelOpen = ref(false);
const cancelBusy = ref(false);

const purchaseBusyPlanId = ref<string | null>(null);

onMounted(load);

async function load() {
  loading.value = true;
  loadError.value = false;
  try {
    const [subscriptionData, planList, paymentList] = await Promise.all([
      fetchSubscriptionOverview(),
      fetchBillingPlans(),
      fetchMyPayments(),
    ]);
    overview.value = subscriptionData;
    plans.value = planList;
    payments.value = paymentList;
  } catch {
    loadError.value = true;
  } finally {
    loading.value = false;
  }
}

async function refreshData() {
  const [subscriptionData, paymentList] = await Promise.all([
    fetchSubscriptionOverview(),
    fetchMyPayments(),
  ]);
  overview.value = subscriptionData;
  payments.value = paymentList;
  // The sidebar quota line reads from the shared usage composable.
  void usage.refresh();
}

async function startPurchase(plan: Plan) {
  purchaseBusyPlanId.value = plan.id;
  try {
    const payment = await createPayment(plan.id);
    checkoutPayment.value = payment;
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'شروع پرداخت ناموفق بود.');
  } finally {
    purchaseBusyPlanId.value = null;
  }
}

/** MVP gateway simulator — replaced by a real gateway later. */
const SIMULATOR_SCENARIOS: { value: string; label: string }[] = [
  { value: 'success', label: 'پرداخت موفق' },
  { value: 'failed', label: 'پرداخت ناموفق' },
  { value: 'cancelled', label: 'انصراف از پرداخت' },
  { value: 'timeout', label: 'قطع ارتباط با درگاه' },
  { value: 'duplicate_webhook', label: 'وب‌هوک تکراری' },
  { value: 'retry', label: 'ارسال مجدد وب‌هوک' },
  { value: 'out_of_order', label: 'وب‌هوک خارج از ترتیب' },
  { value: 'unknown', label: 'رویداد ناشناخته' },
];

async function runScenario(scenario: string) {
  if (!checkoutPayment.value) return;
  checkoutBusy.value = true;
  try {
    const result = await simulatePayment(checkoutPayment.value.id, scenario);
    checkoutPayment.value = result.payment;
    if (result.payment.status === 'success') {
      toast.success('پرداخت با موفقیت انجام شد و اشتراک شما فعال گردید.');
      await refreshData();
    } else if (result.payment.status === 'failed') {
      toast.error('پرداخت ناموفق بود.');
      await refreshData();
    }
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'اجرای سناریو ناموفق بود.');
  } finally {
    checkoutBusy.value = false;
  }
}

async function abandonCheckout() {
  if (!checkoutPayment.value || checkoutPayment.value.status !== 'pending') {
    checkoutPayment.value = null;
    return;
  }
  checkoutBusy.value = true;
  try {
    checkoutPayment.value = await cancelMyPayment(checkoutPayment.value.id);
    await refreshData();
  } catch {
    /* payment may have settled meanwhile — close anyway */
  } finally {
    checkoutBusy.value = false;
    checkoutPayment.value = null;
  }
}

async function cancelSubscription() {
  cancelBusy.value = true;
  try {
    overview.value = await cancelMySubscription();
    await refreshData();
    toast.info('اشتراک شما لغو شد؛ امکانات رایگان ادامه دارد.');
  } catch (e) {
    toast.error(e instanceof Error ? e.message : 'لغو اشتراک ناموفق بود.');
  } finally {
    cancelBusy.value = false;
    confirmCancelOpen.value = false;
  }
}

function goBack() {
  void router.push({ name: 'chat' });
}

// ---- formatting helpers ----

const numberFmt = new Intl.NumberFormat('fa-IR');

function n(value: number): string {
  return numberFmt.format(value);
}

const CURRENCY_LABELS: Record<string, string> = { IRT: 'تومان', IRR: 'ریال' };

function money(amount: string, currency: string): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return '—';
  return `${numberFmt.format(value)} ${CURRENCY_LABELS[currency] ?? currency}`;
}

function featureList(plan: Plan): { label: string; enabled: boolean }[] {
  return [
    { label: 'جستجوی وب', enabled: plan.webSearch },
    { label: 'تفکر عمیق', enabled: plan.thinking },
    { label: 'پردازش فایل', enabled: plan.fileProcessing },
  ];
}

const PERIOD_LABELS: Record<string, string> = { monthly: 'ماهانه', yearly: 'سالانه' };

const entitlements = computed(() => overview.value?.entitlements ?? null);
const subscription = computed(() => overview.value?.subscription ?? null);
const currentPlanSlug = computed(() =>
  subscription.value && subscription.value.status === 'active' ? subscription.value.planSlug : null,
);
</script>

<template>
  <main class="billing">
    <header class="billing__header">
      <div class="billing__brand">
        <BrandMark :size="26" />
        <div>
          <h1 class="billing__title">اشتراک و پرداخت</h1>
          <p class="billing__subtitle">
            طرح فعلی، امکانات و سابقه پرداخت‌های شما. همه دسترسی‌ها مستقیماً از سمت سرور اعمال می‌شوند.
          </p>
        </div>
      </div>
      <div class="billing__header-actions">
        <AppButton variant="ghost" size="sm" @click="goBack">بازگشت به چت</AppButton>
      </div>
    </header>

    <ErrorState
      v-if="loadError"
      title="بارگذاری اطلاعات اشتراک ناموفق بود"
      description="ارتباط با سرور برقرار نشد. اتصال خود را بررسی کنید."
      action-label="تلاش دوباره"
      icon="offline"
      @action="() => load()"
    />

    <div v-else-if="loading" class="billing__loading">
      <AppSkeleton :lines="2" width="100%" />
      <AppSkeleton :lines="6" width="100%" />
    </div>

    <template v-else>
      <!-- طرح فعلی و امکانات -->
      <section v-if="entitlements" class="billing__current" aria-label="طرح فعلی">
        <div class="billing__current-main">
          <span
            class="billing__tier"
            :class="entitlements.tier === 'premium' ? 'billing__tier--premium' : 'billing__tier--free'"
          >
            {{ entitlements.tier === 'premium' ? entitlements.planName : 'طرح رایگان' }}
          </span>
          <p class="billing__current-line">
            <template v-if="subscription && subscription.status === 'active'">
              تا <strong>{{ formatFullDate(subscription.currentPeriodEnd) }}</strong> فعال است.
            </template>
            <template v-else>در حال حاضر اشتراک فعالی ندارید.</template>
          </p>
        </div>
        <div class="billing__current-side">
          <span class="billing__quota">پیام‌های روزانه: {{ n(entitlements.quota.dailyMessages) }}</span>
          <span
            v-if="entitlements.quota.dailyTokens !== null"
            class="billing__quota"
          >توکن روزانه: {{ n(entitlements.quota.dailyTokens) }}</span>
          <span
            v-for="feature in featureList({
              webSearch: entitlements.features.webSearch,
              thinking: entitlements.features.thinking,
              fileProcessing: entitlements.features.fileProcessing,
            } as Plan)"
            :key="feature.label"
            class="billing__feature"
            :class="{ 'billing__feature--off': !feature.enabled }"
          >
            {{ feature.label }}: {{ feature.enabled ? 'فعال' : 'غیرفعال' }}
          </span>
          <AppButton
            v-if="subscription && subscription.status === 'active'"
            variant="ghost"
            size="sm"
            :loading="cancelBusy"
            @click="confirmCancelOpen = true"
          >
            لغو اشتراک
          </AppButton>
        </div>
      </section>

      <!-- طرح‌های قابل خرید -->
      <section class="billing__section" aria-label="طرح‌های اشتراک">
        <h2 class="billing__section-title">طرح‌های اشتراک</h2>
        <div v-if="plans.length === 0" class="billing__empty">
          در حال حاضر طرحی برای خرید تعریف نشده است. بعداً دوباره بررسی کنید.
        </div>
        <div v-else class="billing__plans">
          <article
            v-for="plan in plans"
            :key="plan.id"
            class="billing__plan"
            :class="{ 'billing__plan--current': plan.slug === currentPlanSlug }"
          >
            <header class="billing__plan-head">
              <h3 class="billing__plan-name">{{ plan.name }}</h3>
              <p class="billing__plan-price">
                <strong>{{ money(plan.price, plan.currency) }}</strong>
                <span class="billing__plan-period">/ {{ PERIOD_LABELS[plan.billingPeriod] ?? plan.billingPeriod }}</span>
              </p>
            </header>
            <p v-if="plan.description" class="billing__plan-desc">{{ plan.description }}</p>
            <ul class="billing__plan-features">
              <li>{{ n(plan.dailyMessageQuota) }} پیام در روز</li>
              <li v-if="plan.dailyTokenQuota !== null">{{ n(plan.dailyTokenQuota) }} توکن در روز</li>
              <li v-else>بدون محدودیت توکن روزانه</li>
              <li v-for="feature in featureList(plan)" :key="feature.label" :class="{ 'is-off': !feature.enabled }">
                {{ feature.enabled ? '✓' : '—' }} {{ feature.label }}
              </li>
            </ul>
            <AppButton
              variant="primary"
              block
              :disabled="plan.slug === currentPlanSlug"
              :loading="purchaseBusyPlanId === plan.id"
              @click="() => startPurchase(plan)"
            >
              {{ plan.slug === currentPlanSlug ? 'طرح فعلی شما' : 'خرید و فعال‌سازی' }}
            </AppButton>
          </article>
        </div>
      </section>

      <!-- سابقه پرداخت -->
      <section class="billing__section" aria-label="سابقه پرداخت">
        <h2 class="billing__section-title">سابقه پرداخت</h2>
        <div class="billing__table-wrap">
          <table class="billing__table">
            <thead>
              <tr>
                <th scope="col">تاریخ</th>
                <th scope="col">طرح</th>
                <th scope="col">مبلغ</th>
                <th scope="col">وضعیت</th>
                <th scope="col">کد پیگیری</th>
              </tr>
            </thead>
            <tbody>
              <tr v-if="payments.length === 0">
                <td colspan="5" class="billing__empty-cell">
                  هنوز پرداختی ثبت نشده است. برای فعال‌سازی امکانات بیشتر، یکی از طرح‌ها را انتخاب کنید.
                </td>
              </tr>
              <tr v-for="payment in payments" :key="payment.id">
                <td>{{ formatDateTime(payment.createdAt) }}</td>
                <td>
                  {{ payment.plan.name }}
                  <span class="billing__cell-note">({{ PERIOD_LABELS[payment.plan.billingPeriod] }})</span>
                </td>
                <td class="ltr">{{ money(payment.amount, payment.currency) }}</td>
                <td>
                  <span class="billing__status" :class="`billing__status--${payment.status}`">
                    {{ PAYMENT_STATUS_LABELS[payment.status] }}
                  </span>
                </td>
                <td class="ltr billing__tracking">{{ payment.trackingId.slice(0, 12) }}…</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </template>

    <!-- پرداخت: درگاه شبیه‌ساز (MVP) -->
    <AppModal
      v-if="checkoutPayment"
      :title="`پرداخت طرح «${checkoutPayment.plan.name}»`"
      size="sm"
      @close="() => abandonCheckout()"
    >
      <template v-if="checkoutPayment">
        <div v-if="checkoutPayment.status === 'pending'" class="billing__pay">
          <p class="billing__pay-amount ltr">
            {{ money(checkoutPayment.amount, checkoutPayment.currency) }}
          </p>
          <p class="billing__pay-note">
            در انتظار تأیید درگاه پرداخت… (شبیه‌ساز درگاه — محیط MVP)
          </p>
          <div class="billing__pay-scenarios" role="group" aria-label="سناریوی شبیه‌ساز">
            <button
              v-for="scenario in SIMULATOR_SCENARIOS"
              :key="scenario.value"
              type="button"
              class="billing__pay-scenario"
              :disabled="checkoutBusy"
              @click="() => runScenario(scenario.value)"
            >
              {{ scenario.label }}
            </button>
          </div>
        </div>

        <div v-else-if="checkoutPayment.status === 'success'" class="billing__pay billing__pay--success">
          <p class="billing__pay-result">پرداخت با موفقیت انجام شد.</p>
          <p class="billing__pay-note">اشتراک شما فعال شد و امکانات جدید بلافاصله در دسترس‌اند.</p>
        </div>

        <div v-else class="billing__pay billing__pay--failed">
          <p class="billing__pay-result">
            {{ PAYMENT_STATUS_LABELS[checkoutPayment.status] }}
          </p>
          <p v-if="checkoutPayment.failureReason" class="billing__pay-note ltr">
            {{ checkoutPayment.failureReason }}
          </p>
          <p class="billing__pay-note">می‌توانید دوباره تلاش کنید یا پرداخت را رها کنید.</p>
        </div>
      </template>
      <template #footer>
        <AppButton variant="ghost" size="sm" :loading="checkoutBusy" @click="() => abandonCheckout()">
          {{ checkoutPayment?.status === 'pending' ? 'انصراف از پرداخت' : 'بستن' }}
        </AppButton>
      </template>
    </AppModal>

    <!-- تأیید لغو اشتراک -->
    <AppModal
      v-if="confirmCancelOpen"
      title="لغو اشتراک"
      size="sm"
      @close="() => (confirmCancelOpen = false)"
    >
      <p class="billing__confirm-text">
        با لغو اشتراک، امکانات طرح شما بلافاصله به سطح رایگان برمی‌گردد. سابقه پرداخت‌ها حفظ می‌شود.
      </p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="() => (confirmCancelOpen = false)">بازگشت</AppButton>
        <AppButton variant="danger" size="sm" :loading="cancelBusy" @click="() => cancelSubscription()">
          لغو اشتراک
        </AppButton>
      </template>
    </AppModal>
  </main>
</template>

<style scoped>
.billing {
  min-height: 100vh;
  max-width: 68rem;
  margin-inline: auto;
  padding: 2rem 1.25rem 4rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.billing__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}

.billing__brand {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}

.billing__title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--text-1);
}

.billing__subtitle {
  margin: 0.25rem 0 0;
  font-size: 0.85rem;
  color: var(--text-2);
}

.billing__header-actions {
  display: flex;
  gap: 0.5rem;
}

.billing__loading {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* ---- current subscription card ---- */

.billing__current {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  padding: 1.25rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
}

.billing__tier {
  display: inline-block;
  padding: 0.2rem 0.75rem;
  border-radius: var(--radius-full);
  font-size: 0.8rem;
  font-weight: 600;
}

.billing__tier--premium {
  background: var(--gradient-primary);
  color: var(--on-accent);
  box-shadow: var(--shadow-glow);
}

.billing__tier--free {
  background: var(--accent-soft);
  color: var(--text-on-accent-soft);
  border: 1px solid var(--accent-soft-border);
}

.billing__current-line {
  margin: 0.6rem 0 0;
  font-size: 0.9rem;
  color: var(--text-2);
}

.billing__current-line strong {
  color: var(--text-1);
}

.billing__current-side {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
}

.billing__quota,
.billing__feature {
  padding: 0.2rem 0.6rem;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  font-size: 0.75rem;
  color: var(--text-2);
}

.billing__feature--off {
  color: var(--text-3);
  background: transparent;
}

/* ---- plans ---- */

.billing__section {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.billing__section-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-1);
}

.billing__plans {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
  gap: 1rem;
}

.billing__plan {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 1.25rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
  transition: border-color var(--motion-fast) var(--ease-out);
}

.billing__plan:hover {
  border-color: var(--border-strong);
}

.billing__plan--current {
  border-color: var(--accent-soft-border);
  background: var(--accent-soft);
}

.billing__plan-head {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.billing__plan-name {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: var(--text-1);
}

.billing__plan-price strong {
  font-size: 1.15rem;
  color: var(--text-1);
}

.billing__plan-period {
  margin-inline-start: 0.25rem;
  font-size: 0.8rem;
  color: var(--text-3);
}

.billing__plan-desc {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-2);
  line-height: 1.8;
}

.billing__plan-features {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  font-size: 0.82rem;
  color: var(--text-2);
  flex: 1;
}

.billing__plan-features .is-off {
  color: var(--text-3);
}

.billing__empty {
  padding: 2rem;
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  text-align: center;
  font-size: 0.88rem;
  color: var(--text-2);
}

/* ---- history table ---- */

.billing__table-wrap {
  overflow-x: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--surface);
}

.billing__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}

.billing__table th {
  padding: 0.75rem 1rem;
  text-align: start;
  font-weight: 600;
  color: var(--text-3);
  border-block-end: 1px solid var(--border);
  white-space: nowrap;
}

.billing__table td {
  padding: 0.7rem 1rem;
  color: var(--text-1);
  border-block-end: 1px solid var(--border-subtle);
}

.billing__table tbody tr:last-child td {
  border-block-end: none;
}

.billing__empty-cell {
  text-align: center;
  color: var(--text-3);
  padding-block: 2rem;
}

.billing__cell-note {
  color: var(--text-3);
  font-size: 0.78rem;
}

.billing__tracking {
  font-size: 0.78rem;
  color: var(--text-2);
}

.billing__status {
  display: inline-block;
  padding: 0.15rem 0.6rem;
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 600;
}

.billing__status--success {
  background: var(--success-soft);
  color: var(--success);
}

.billing__status--pending {
  background: var(--warning-soft);
  color: var(--warning);
}

.billing__status--failed {
  background: var(--danger-soft);
  color: var(--danger);
}

.billing__status--cancelled {
  background: var(--surface-3);
  color: var(--text-3);
}

/* ---- payment modal ---- */

.billing__pay {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding-block: 0.5rem;
  text-align: center;
}

.billing__pay-amount {
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--text-1);
  margin: 0;
}

.billing__pay-result {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-1);
}

.billing__pay--success .billing__pay-result {
  color: var(--success);
}

.billing__pay--failed .billing__pay-result {
  color: var(--danger);
}

.billing__pay-note {
  margin: 0;
  font-size: 0.82rem;
  color: var(--text-2);
  line-height: 1.8;
}

.billing__pay-scenarios {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.4rem;
  margin-block-start: 0.5rem;
}

.billing__pay-scenario {
  padding: 0.35rem 0.7rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 0.75rem;
  cursor: pointer;
  transition: border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}

.billing__pay-scenario:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent-text);
}

.billing__pay-scenario:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.billing__confirm-text {
  margin: 0;
  font-size: 0.88rem;
  color: var(--text-2);
  line-height: 1.9;
}

@media (max-width: 640px) {
  .billing {
    padding: 1.25rem 0.9rem 3rem;
  }

  .billing__current {
    flex-direction: column;
  }
}
</style>
