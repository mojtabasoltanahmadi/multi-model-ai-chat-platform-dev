<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import ProviderMark from '../ui/ProviderMark.vue';
import type { AiModel } from '../../api/types';

interface Props {
  models: AiModel[];
  modelId: string;
  /** 'up' opens above the trigger (composer), 'down' below (header). */
  placement?: 'up' | 'down';
  compact?: boolean;
}

const props = withDefaults(defineProps<Props>(), { placement: 'up', compact: false });
const emit = defineEmits<{ select: [id: string] }>();

const open = ref(false);
const root = ref<HTMLElement | null>(null);

const selected = computed(
  () => props.models.find((model) => model.id === props.modelId) ?? props.models[0] ?? null,
);

const providerLabel: Record<AiModel['provider'], string> = {
  mock: 'ماک آزمایشی',
  'openai-compatible': 'سازگار با OpenAI',
};

function choose(model: AiModel) {
  open.value = false;
  emit('select', model.id);
}

function onDocumentClick(event: MouseEvent) {
  if (open.value && !root.value?.contains(event.target as Node)) open.value = false;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') open.value = false;
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onKeydown);
});
</script>

<template>
  <div ref="root" class="model-selector">
    <button
      type="button"
      class="model-selector__trigger"
      :class="{ 'model-selector__trigger--compact': compact, 'model-selector__trigger--open': open }"
      aria-haspopup="listbox"
      :aria-expanded="open"
      aria-label="انتخاب مدل هوش مصنوعی"
      @click="open = !open"
    >
      <ProviderMark v-if="selected" :provider="selected.provider" :size="18" />
      <span v-if="selected" class="model-selector__name">{{ selected.name }}</span>
      <svg
        class="model-selector__chevron"
        :class="{ 'model-selector__chevron--flip': open }"
        width="13"
        height="13"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.2"
        stroke-linecap="round"
        aria-hidden="true"
      >
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    <Transition name="model-selector-pop">
      <ul
        v-if="open"
        class="model-selector__menu"
        :class="`model-selector__menu--${placement}`"
        role="listbox"
        aria-label="مدل‌های فعال"
      >
        <li v-if="models.length === 0" class="model-selector__empty">
          مدلی موجود نیست — با مدیر سیستم تماس بگیرید.
        </li>
        <li v-for="model in models" :key="model.id">
          <button
            type="button"
            class="model-selector__option"
            role="option"
            :aria-selected="model.id === (selected?.id ?? '')"
            @click="choose(model)"
          >
            <ProviderMark :provider="model.provider" :size="26" />
            <span class="model-selector__option-body">
              <span class="model-selector__option-name">
                {{ model.name }}
                <span v-if="model.isDefault" class="model-selector__default">پیش‌فرض</span>
              </span>
              <span class="model-selector__option-provider">{{ providerLabel[model.provider] }}</span>
            </span>
            <svg
              v-if="model.id === selected?.id"
              class="model-selector__check"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.4"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </button>
        </li>
      </ul>
    </Transition>
  </div>
</template>

<style scoped>
.model-selector {
  position: relative;
}

.model-selector__trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  height: 2.2rem;
  padding: 0 0.6rem;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  color: var(--text-1);
  font-size: 0.82rem;
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out);
}

.model-selector__trigger:hover,
.model-selector__trigger--open {
  background: var(--surface-2);
  border-color: var(--border-strong);
}

.model-selector__trigger--compact {
  height: 1.9rem;
  font-size: 0.78rem;
}

.model-selector__name {
  /* Long model names must ellipsize instead of widening the pill past the
     header/composer row on narrow screens. */
  max-width: 8.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-selector__chevron {
  color: var(--text-3);
  transition: rotate var(--motion-fast) var(--ease-out);
}

.model-selector__chevron--flip {
  rotate: 180deg;
}

.model-selector__menu {
  position: absolute;
  inset-inline-start: 0;
  z-index: var(--z-dropdown);
  min-width: 17rem;
  /* Never let the dropdown extend past the viewport on small screens. */
  max-width: calc(100vw - 2rem);
  max-height: 18rem;
  overflow-y: auto;
  margin: 0;
  padding: 0.35rem;
  list-style: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-3);
}

.model-selector__menu--up {
  bottom: calc(100% + 0.5rem);
}

.model-selector__menu--down {
  top: calc(100% + 0.5rem);
}

.model-selector__empty {
  padding: 0.8rem;
  font-size: 0.8rem;
  color: var(--text-2);
}

.model-selector__option {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.5rem 0.55rem;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  text-align: right;
  transition: background var(--motion-fast) var(--ease-out);
}

.model-selector__option:hover {
  background: var(--surface-2);
}

.model-selector__option-body {
  display: grid;
  gap: 0.05rem;
  flex: 1;
  min-width: 0;
}

.model-selector__option-name {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.84rem;
  color: var(--text-1);
}

.model-selector__default {
  font-size: 0.64rem;
  padding: 0.05rem 0.4rem;
  border-radius: var(--radius-full);
  background: var(--accent-soft);
  color: var(--text-on-accent-soft);
}

.model-selector__option-provider {
  font-size: 0.7rem;
  color: var(--text-3);
}

.model-selector__check {
  color: var(--accent-text);
  flex-shrink: 0;
}

.model-selector-pop-enter-active,
.model-selector-pop-leave-active {
  transition:
    opacity var(--motion-fast) var(--ease-out),
    transform var(--motion-fast) var(--ease-out);
}

.model-selector-pop-enter-from,
.model-selector-pop-leave-to {
  opacity: 0;
}

.model-selector-pop-enter-from.model-selector__menu--up,
.model-selector-pop-leave-to.model-selector__menu--up {
  transform: translateY(6px);
}

.model-selector-pop-enter-from.model-selector__menu--down,
.model-selector-pop-leave-to.model-selector__menu--down {
  transform: translateY(-6px);
}
</style>
