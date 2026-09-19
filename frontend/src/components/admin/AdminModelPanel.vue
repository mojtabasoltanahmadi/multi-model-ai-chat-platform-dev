<script lang="ts">
import type { AiProviderKind, ModelCapability } from '../../api/types';

/** Raw form values; the view turns them into POST/PATCH payloads. */
export interface PanelFormValues {
  name: string;
  provider: AiProviderKind;
  externalModelId: string;
  baseUrl: string;
  apiKey: string;
  capabilities: ModelCapability[];
  inputPricePerMillion: string;
  outputPricePerMillion: string;
  isActive: boolean;
  isFree: boolean;
}
</script>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import AppDrawer from '../ui/AppDrawer.vue';
import AppInput from '../ui/AppInput.vue';
import AppButton from '../ui/AppButton.vue';
import AppSwitch from '../ui/AppSwitch.vue';
import ProviderMark from '../ui/ProviderMark.vue';
import { formatFullDate } from '../../utils/format';
import {
  MODEL_CAPABILITIES,
  MODEL_CAPABILITY_LABELS,
  type AdminModel,
} from '../../api/types';

interface Props {
  /** null → create mode; otherwise edit this model. */
  model: AdminModel | null;
  saving?: boolean;
}

const props = withDefaults(defineProps<Props>(), { saving: false });
const emit = defineEmits<{
  submit: [values: PanelFormValues];
  close: [];
  setDefault: [model: AdminModel];
}>();

/** One entry per registered provider kind (mirrors the backend adapters). */
const providerOptions: { value: AiProviderKind; title: string; subtitle: string }[] = [
  { value: 'mock', title: 'ماک', subtitle: 'آزمایشی، بدون کلید' },
  { value: 'openai-compatible', title: 'سازگار با OpenAI', subtitle: 'OpenAI و سرویس‌های مشابه' },
  { value: 'anthropic', title: 'Anthropic', subtitle: 'مدل‌های Claude' },
  { value: 'google', title: 'Google Gemini', subtitle: 'مدل‌های Gemini' },
];

/** Per-provider examples so the form stays self-explanatory. */
const providerPlaceholders: Record<AiProviderKind, { modelId: string; baseUrl: string }> = {
  mock: { modelId: 'mock-model', baseUrl: '' },
  'openai-compatible': { modelId: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
  anthropic: { modelId: 'claude-3-5-sonnet-latest', baseUrl: 'https://api.anthropic.com/v1' },
  google: {
    modelId: 'gemini-1.5-flash',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },
};

const apiKeyLabels: Record<AiProviderKind, string> = {
  mock: 'کلید API (اختیاری برای ماک)',
  'openai-compatible': 'کلید API',
  anthropic: 'کلید API (الزامی برای Anthropic)',
  google: 'کلید API (الزامی برای Gemini)',
};

const values = reactive<PanelFormValues>({
  name: '',
  provider: 'mock',
  externalModelId: '',
  baseUrl: '',
  apiKey: '',
  capabilities: [],
  inputPricePerMillion: '',
  outputPricePerMillion: '',
  isActive: true,
  isFree: true,
});

const placeholders = computed(() => providerPlaceholders[values.provider]);

const validation = ref({ name: '', externalModelId: '' });
const copied = ref(false);

function init(from: AdminModel | null) {
  values.name = from?.name ?? '';
  values.provider = from?.provider ?? 'mock';
  values.externalModelId = from?.externalModelId ?? '';
  values.baseUrl = from?.baseUrl ?? '';
  // The stored key never reaches the client — the field starts empty and
  // only a typed value is submitted (view handles the "keep existing" case).
  values.apiKey = '';
  values.capabilities = from?.capabilities ? [...from.capabilities] : [];
  values.inputPricePerMillion = from?.inputPricePerMillion ?? '';
  values.outputPricePerMillion = from?.outputPricePerMillion ?? '';
  values.isActive = from?.isActive ?? true;
  values.isFree = from?.isFree ?? true;
  validation.value = { name: '', externalModelId: '' };
}

watch(() => props.model, init, { immediate: true });

function toggleCapability(capability: ModelCapability) {
  values.capabilities = values.capabilities.includes(capability)
    ? values.capabilities.filter((value) => value !== capability)
    : [...values.capabilities, capability];
}

function validate(): boolean {
  validation.value = {
    name: values.name.trim() ? '' : 'نام مدل الزامی است.',
    externalModelId: values.externalModelId.trim() ? '' : 'شناسه مدل الزامی است.',
  };
  return !validation.value.name && !validation.value.externalModelId;
}

function submit() {
  if (!validate() || props.saving) return;
  emit('submit', {
    name: values.name.trim(),
    provider: values.provider,
    externalModelId: values.externalModelId.trim(),
    baseUrl: values.baseUrl.trim(),
    apiKey: values.apiKey.trim(),
    capabilities: values.capabilities,
    inputPricePerMillion: values.inputPricePerMillion.trim(),
    outputPricePerMillion: values.outputPricePerMillion.trim(),
    isActive: values.isActive,
    isFree: values.isFree,
  });
}

async function copyId() {
  if (!props.model) return;
  try {
    await navigator.clipboard.writeText(props.model.id);
    copied.value = true;
    window.setTimeout(() => (copied.value = false), 1600);
  } catch {
    /* clipboard unavailable — silently ignore */
  }
}
</script>

<template>
  <AppDrawer :open="true" size="lg" @close="emit('close')">
    <template #header>
      <div v-if="model" class="panel-head">
        <ProviderMark :provider="model.provider" :size="38" />
        <div class="panel-head__text">
          <strong class="panel-head__name">{{ model.name }}</strong>
          <span class="panel-head__id mono ltr">{{ model.externalModelId }}</span>
        </div>
        <span
          class="panel-head__badge"
          :class="model.isActive ? 'panel-head__badge--on' : 'panel-head__badge--off'"
        >
          {{ model.isActive ? 'فعال' : 'غیرفعال' }}
        </span>
      </div>
      <h2 v-else class="panel-head__title">افزودن مدل جدید</h2>
    </template>

    <form class="panel-form" novalidate @submit.prevent="submit">
      <!-- تنظیمات پایه -->
      <p class="panel-form__section">تنظیمات پایه</p>
      <AppInput
        v-model="values.name"
        label="نام نمایشی (نام مدل برای کاربران)"
        placeholder="مثلاً GPT-4o mini"
        :error="validation.name"
        required
      />

      <div class="panel-form__field">
        <span class="panel-form__label">نوع ارائه‌دهنده</span>
        <div class="panel-form__providers" role="radiogroup" aria-label="نوع ارائه‌دهنده">
          <button
            v-for="option in providerOptions"
            :key="option.value"
            type="button"
            role="radio"
            class="panel-form__provider"
            :aria-checked="values.provider === option.value"
            :class="{ 'panel-form__provider--active': values.provider === option.value }"
            @click="values.provider = option.value"
          >
            <ProviderMark :provider="option.value" :size="24" />
            <span class="panel-form__provider-text">
              <strong>{{ option.title }}</strong>
              <span>{{ option.subtitle }}</span>
            </span>
          </button>
        </div>
      </div>

      <AppInput
        v-model="values.externalModelId"
        label="شناسه مدل نزد ارائه‌دهنده (Model ID)"
        dir="ltr"
        :placeholder="placeholders.modelId"
        :error="validation.externalModelId"
        required
      />
      <AppInput
        v-model="values.baseUrl"
        label="آدرس پایه (اختیاری — در صورت خالی بودن، آدرس رسمی ارائه‌دهنده استفاده می‌شود)"
        dir="ltr"
        :placeholder="placeholders.baseUrl"
      />
      <AppInput
        v-model="values.apiKey"
        :label="model?.hasApiKey ? 'کلید API (برای جایگزینی مقدار جدید وارد کنید)' : apiKeyLabels[values.provider]"
        type="password"
        dir="ltr"
        autocomplete="off"
        placeholder="sk-…"
      />

      <div class="panel-form__field">
        <span class="panel-form__label">قابلیت‌های مدل (اختیاری)</span>
        <div class="panel-form__capabilities">
          <button
            v-for="capability in MODEL_CAPABILITIES"
            :key="capability"
            type="button"
            class="panel-form__capability"
            :aria-pressed="values.capabilities.includes(capability)"
            :class="{ 'panel-form__capability--on': values.capabilities.includes(capability) }"
            @click="toggleCapability(capability)"
          >
            {{ MODEL_CAPABILITY_LABELS[capability] }}
          </button>
        </div>
        <span class="panel-form__hint">
          قابلیت‌ها ویژگی‌های جانبی این مدل را معرفی می‌کنند و در فهرست انتخاب کاربران نمایش داده می‌شوند.
        </span>
      </div>

      <!-- قیمت‌گذاری (مبنای محاسبه هزینه مصرف) -->
      <div class="panel-form__field">
        <span class="panel-form__label">قیمت هر یک میلیون توکن (تومان — اختیاری)</span>
        <div class="panel-form__prices">
          <AppInput
            v-model="values.inputPricePerMillion"
            label="توکن ورودی"
            dir="ltr"
            inputmode="decimal"
            placeholder="1000000"
          />
          <AppInput
            v-model="values.outputPricePerMillion"
            label="توکن خروجی"
            dir="ltr"
            inputmode="decimal"
            placeholder="2000000"
          />
        </div>
        <span class="panel-form__hint">
          در صورت خالی گذاشتن هر دو قیمت، هزینه این مدل محاسبه نمی‌شود. قیمت‌ها فقط در پنل مدیریت دیده می‌شوند.
        </span>
      </div>

      <!-- دسترسی و وضعیت -->
      <p class="panel-form__section">دسترسی و وضعیت</p>

      <div class="panel-form__switch-row">
        <span class="panel-form__switch-text">
          <strong>فعال‌سازی مدل</strong>
          <span>مدل غیرفعال در فهرست انتخاب کاربران دیده نمی‌شود</span>
        </span>
        <AppSwitch
          v-model="values.isActive"
          label="فعال‌سازی مدل"
          :disabled="Boolean(model?.isDefault)"
        />
      </div>

      <div class="panel-form__switch-row">
        <span class="panel-form__switch-text">
          <strong>دسترسی رایگان (طرح FREE)</strong>
          <span>کاربران طرح رایگان فقط مدل‌های رایگان را می‌بینند</span>
        </span>
        <AppSwitch
          v-model="values.isFree"
          label="دسترسی رایگان"
          :disabled="Boolean(model?.isDefault)"
        />
      </div>

      <p v-if="model?.isDefault" class="panel-form__default-note">
        این مدل پیش‌فرض گفتگوست و همیشه فعال و رایگان است. برای تغییر، ابتدا مدل دیگری را پیش‌فرض کنید.
      </p>
      <AppButton
        v-else-if="model"
        variant="secondary"
        size="sm"
        :disabled="!model.isActive"
        :title="model.isActive ? undefined : 'ابتدا مدل را فعال کنید'"
        @click="emit('setDefault', model)"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 2c.6 4.5 4.5 8.4 9 9-4.5.6-8.4 4.5-9 9-.6-4.5-4.5-8.4-9-9 4.5-.6 8.4-4.5 9-9Z" />
        </svg>
        تنظیم به‌عنوان پیش‌فرض
      </AppButton>

      <!-- اطلاعات فنی -->
      <template v-if="model">
        <p class="panel-form__section">اطلاعات فنی</p>
        <dl class="panel-form__info">
          <div class="panel-form__info-row">
            <dt>شناسه یکتا</dt>
            <dd class="panel-form__info-value">
              <span class="mono ltr">{{ model.id }}</span>
              <button
                type="button"
                class="panel-form__copy"
                :aria-label="copied ? 'کپی شد' : 'کپی شناسه'"
                :title="copied ? 'کپی شد' : 'کپی شناسه'"
                @click="copyId"
              >
                <svg v-if="!copied" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                  <rect x="9" y="9" width="12" height="12" rx="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
                <svg v-else width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </button>
            </dd>
          </div>
          <div class="panel-form__info-row">
            <dt>تاریخ افزودن</dt>
            <dd>{{ formatFullDate(model.createdAt) }}</dd>
          </div>
          <div class="panel-form__info-row">
            <dt>کلید API</dt>
            <dd>{{ model.hasApiKey ? 'ثبت شده است' : 'ثبت نشده' }}</dd>
          </div>
          <div class="panel-form__info-row">
            <dt>آدرس پایه</dt>
            <dd>
              <span v-if="model.baseUrl" class="mono ltr panel-form__info-url">{{ model.baseUrl }}</span>
              <span v-else>—</span>
            </dd>
          </div>
        </dl>
      </template>

      <p v-if="!model" class="panel-form__note">
        کلید API فقط در سرور ذخیره می‌شود و هرگز نمایش داده نمی‌شود. اولین مدل فعال و رایگان،
        به‌طور خودکار پیش‌فرض می‌شود.
      </p>
    </form>

    <template #footer>
      <AppButton variant="secondary" @click="emit('close')">لغو</AppButton>
      <AppButton :loading="saving" @click="submit">
        {{ model ? 'ذخیره تغییرات' : 'افزودن مدل' }}
      </AppButton>
    </template>
  </AppDrawer>
</template>

<style scoped>
.panel-head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-width: 0;
}

.panel-head__text {
  display: grid;
  gap: 0.05rem;
  min-width: 0;
  flex: 1;
}

.panel-head__name {
  font-size: 0.95rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.panel-head__id {
  font-size: 0.72rem;
  color: var(--text-3);
}

.panel-head__badge {
  flex-shrink: 0;
  padding: 0.14rem 0.6rem;
  border-radius: var(--radius-full);
  font-size: 0.7rem;
  font-weight: 500;
  border: 1px solid transparent;
}

.panel-head__badge--on {
  background: var(--success-soft);
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 25%, transparent);
}

.panel-head__badge--off {
  background: var(--surface-2);
  color: var(--text-3);
  border-color: var(--border);
}

.panel-head__title {
  font-size: 1rem;
}

.panel-form {
  display: grid;
  gap: 0.9rem;
}

.panel-form__section {
  margin-top: 0.4rem;
  padding-inline-start: 0.55rem;
  border-inline-start: 2px solid var(--accent);
  font-size: 0.82rem;
  font-weight: 600;
  color: var(--text-1);
}

.panel-form__field {
  display: grid;
  gap: 0.4rem;
}

.panel-form__label {
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-2);
}

.panel-form__providers {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
}

.panel-form__provider {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.65rem 0.75rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  text-align: right;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.panel-form__provider--active {
  border-color: var(--accent);
  background: var(--accent-soft);
  box-shadow: 0 0 0 1px var(--accent-soft-border);
}

.panel-form__provider-text {
  display: grid;
  gap: 0.05rem;
  min-width: 0;
}

.panel-form__provider-text strong {
  font-size: 0.8rem;
  font-weight: 600;
}

.panel-form__provider-text span {
  font-size: 0.68rem;
  color: var(--text-3);
}

.panel-form__provider--active .panel-form__provider-text span {
  color: var(--text-on-accent-soft);
}

.panel-form__capabilities {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}

.panel-form__capability {
  padding: 0.35rem 0.75rem;
  font-size: 0.76rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text-2);
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.panel-form__capability:hover {
  border-color: var(--border-strong);
  color: var(--text-1);
}

.panel-form__capability--on {
  background: var(--accent-soft);
  border-color: var(--accent-soft-border);
  color: var(--text-on-accent-soft);
}

.panel-form__hint {
  font-size: 0.7rem;
  color: var(--text-3);
}

.panel-form__prices {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.6rem;
}

@media (max-width: 640px) {
  .panel-form__prices {
    grid-template-columns: 1fr;
  }
}

.panel-form__switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  padding: 0.65rem 0.8rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.panel-form__switch-text {
  display: grid;
  gap: 0.1rem;
}

.panel-form__switch-text strong {
  font-size: 0.84rem;
  font-weight: 600;
  color: var(--text-1);
}

.panel-form__switch-text span {
  font-size: 0.7rem;
  color: var(--text-3);
}

.panel-form__default-note {
  font-size: 0.72rem;
  color: var(--text-on-accent-soft);
  background: var(--accent-soft);
  border: 1px solid var(--accent-soft-border);
  border-radius: var(--radius-sm);
  padding: 0.55rem 0.75rem;
}

.panel-form__info {
  margin: 0;
  display: grid;
  gap: 0;
  background: var(--surface-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.panel-form__info-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.5rem 0.75rem;
}

.panel-form__info-row + .panel-form__info-row {
  border-top: 1px solid var(--border-subtle);
}

.panel-form__info-row dt {
  font-size: 0.76rem;
  color: var(--text-2);
  flex-shrink: 0;
}

.panel-form__info-row dd {
  margin: 0;
  font-size: 0.76rem;
  color: var(--text-1);
  display: flex;
  align-items: center;
  gap: 0.35rem;
  min-width: 0;
}

.panel-form__info-url {
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.panel-form__copy {
  display: grid;
  place-items: center;
  width: 1.6rem;
  height: 1.6rem;
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  color: var(--text-3);
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.panel-form__copy:hover {
  background: var(--surface-2);
  color: var(--text-1);
}

.panel-form__note {
  font-size: 0.72rem;
  color: var(--text-3);
  background: var(--surface-inset);
  border-radius: var(--radius-sm);
  padding: 0.55rem 0.75rem;
}

@media (max-width: 640px) {
  .panel-form__providers {
    grid-template-columns: 1fr;
  }
}
</style>
