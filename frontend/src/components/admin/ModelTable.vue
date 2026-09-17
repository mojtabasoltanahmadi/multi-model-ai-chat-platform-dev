<script setup lang="ts">
import ModelStatus from './ModelStatus.vue';
import AppSwitch from '../ui/AppSwitch.vue';
import ProviderMark from '../ui/ProviderMark.vue';
import { formatFullDate } from '../../utils/format';
import type { AiModel } from '../../api/types';

interface Props {
  models: AiModel[];
  /** Row currently open in the configuration panel. */
  selectedId?: string | null;
}

withDefaults(defineProps<Props>(), { selectedId: null });

defineEmits<{
  edit: [model: AiModel];
  'set-default': [model: AiModel];
  'toggle-active': [model: AiModel];
  'toggle-free': [model: AiModel];
  remove: [model: AiModel];
}>();

const providerLabel: Record<AiModel['provider'], string> = {
  mock: 'ماک',
  'openai-compatible': 'سازگار با OpenAI',
};
</script>

<template>
  <!-- Desktop: model rows. Mobile (<768px): stacked cards. -->
  <div class="model-table">
    <table class="model-table__desktop">
      <thead>
        <tr>
          <th scope="col">مدل</th>
          <th scope="col">وضعیت</th>
          <th scope="col">دسترسی</th>
          <th scope="col">پیش‌فرض</th>
          <th scope="col">سازنده</th>
          <th scope="col">تاریخ افزودن</th>
          <th scope="col"><span class="visually-hidden">عملیات</span></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="model in models"
          :key="model.id"
          :class="{
            'model-table__row--inactive': !model.isActive,
            'model-table__row--selected': model.id === selectedId,
          }"
        >
          <td>
            <div class="model-table__model">
              <span class="model-table__name">{{ model.name }}</span>
              <span class="mono ltr model-table__id">{{ model.externalModelId }}</span>
            </div>
          </td>
          <td>
            <!-- The default model must stay active (backend-enforced), so its
                 switch is disabled instead of producing a 400 error. -->
            <AppSwitch
              :model-value="model.isActive"
              :label="model.isActive ? 'غیرفعال کردن مدل' : 'فعال کردن مدل'"
              :disabled="model.isDefault"
              :title="model.isDefault ? 'مدل پیش‌فرض همیشه فعال است — ابتدا مدل دیگری را پیش‌فرض کنید' : undefined"
              @update:model-value="$emit('toggle-active', model)"
            />
          </td>
          <td>
            <button
              type="button"
              class="model-table__free-toggle"
              :class="model.isFree ? 'model-table__free-toggle--on' : 'model-table__free-toggle--off'"
              role="switch"
              :aria-checked="model.isFree"
              :aria-label="model.isFree ? 'حذف دسترسی رایگان' : 'افزودن دسترسی رایگان'"
              :disabled="model.isDefault"
              :title="model.isDefault ? 'مدل پیش‌فرض همیشه رایگان است — ابتدا مدل دیگری را پیش‌فرض کنید' : undefined"
              @click="$emit('toggle-free', model)"
            >
              {{ model.isFree ? 'رایگان' : 'پریمیوم' }}
            </button>
          </td>
          <td>
            <span v-if="model.isDefault" class="model-table__default">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <path d="M12 2c.6 4.5 4.5 8.4 9 9-4.5.6-8.4 4.5-9 9-.6-4.5-4.5-8.4-9-9 4.5-.6 8.4-4.5 9-9Z" />
              </svg>
              پیش‌فرض
            </span>
            <button
              v-else-if="model.isActive"
              type="button"
              class="model-table__icon-btn model-table__icon-btn--default"
              aria-label="تنظیم به‌عنوان پیش‌فرض"
              title="تنظیم به‌عنوان پیش‌فرض"
              @click="$emit('set-default', model)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 2c.6 4.5 4.5 8.4 9 9-4.5.6-8.4 4.5-9 9-.6-4.5-4.5-8.4-9-9 4.5-.6 8.4-4.5 9-9Z" />
              </svg>
            </button>
            <span v-else class="model-table__muted">—</span>
          </td>
          <td>
            <div class="model-table__provider">
              <ProviderMark :provider="model.provider" :size="22" />
              <span>{{ providerLabel[model.provider] }}</span>
            </div>
          </td>
          <td class="model-table__date">{{ formatFullDate(model.createdAt) }}</td>
          <td>
            <div class="model-table__actions">
              <button
                type="button"
                class="model-table__icon-btn"
                aria-label="ویرایش و تنظیمات مدل"
                title="ویرایش و تنظیمات"
                @click="$emit('edit', model)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                </svg>
              </button>
              <button
                v-if="!model.isDefault"
                type="button"
                class="model-table__icon-btn model-table__icon-btn--danger"
                aria-label="حذف مدل"
                title="حذف مدل"
                @click="$emit('remove', model)"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z" />
                </svg>
              </button>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <ul class="model-table__mobile">
      <li
        v-for="model in models"
        :key="model.id"
        class="model-table__card"
        :class="{
          'model-table__card--inactive': !model.isActive,
          'model-table__card--selected': model.id === selectedId,
        }"
      >
        <div class="model-table__card-head">
          <ProviderMark :provider="model.provider" :size="30" />
          <div class="model-table__model">
            <span class="model-table__name">{{ model.name }}</span>
            <span class="mono ltr model-table__id">{{ model.externalModelId }}</span>
          </div>
          <ModelStatus :is-default="model.isDefault" :is-active="model.isActive" :is-free="model.isFree" />
        </div>
        <div class="model-table__card-controls">
          <label class="model-table__card-control">
            <span>وضعیت</span>
            <AppSwitch
              :model-value="model.isActive"
              :label="model.isActive ? 'غیرفعال کردن مدل' : 'فعال کردن مدل'"
              :disabled="model.isDefault"
              @update:model-value="$emit('toggle-active', model)"
            />
          </label>
          <button
            v-if="!model.isDefault"
            type="button"
            class="model-table__free-toggle"
            :class="model.isFree ? 'model-table__free-toggle--on' : 'model-table__free-toggle--off'"
            role="switch"
            :aria-checked="model.isFree"
            @click="$emit('toggle-free', model)"
          >
            {{ model.isFree ? 'رایگان' : 'پریمیوم' }}
          </button>
          <button
            v-else-if="model.isDefault"
            type="button"
            class="model-table__default"
            disabled
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <path d="M12 2c.6 4.5 4.5 8.4 9 9-4.5.6-8.4 4.5-9 9-.6-4.5-4.5-8.4-9-9 4.5-.6 8.4-4.5 9-9Z" />
            </svg>
            پیش‌فرض
          </button>
          <button
            v-else-if="model.isActive"
            type="button"
            class="model-table__free-toggle model-table__free-toggle--off"
            @click="$emit('set-default', model)"
          >
            تنظیم پیش‌فرض
          </button>
        </div>
        <div class="model-table__card-meta">
          <span>{{ providerLabel[model.provider] }}</span>
          <span>{{ formatFullDate(model.createdAt) }}</span>
        </div>
        <div class="model-table__actions model-table__actions--card">
          <button type="button" class="model-table__card-action" @click="$emit('edit', model)">
            ویرایش
          </button>
          <button
            v-if="!model.isDefault"
            type="button"
            class="model-table__card-action model-table__card-action--danger"
            @click="$emit('remove', model)"
          >
            حذف
          </button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.model-table__desktop {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-1);
}

.model-table__desktop th,
.model-table__desktop td {
  padding: 0.7rem 0.9rem;
  text-align: right;
  font-size: 0.84rem;
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: middle;
}

.model-table__desktop th {
  background: var(--surface-2);
  color: var(--text-2);
  font-weight: 500;
  font-size: 0.74rem;
}

.model-table__desktop tbody tr:last-child td {
  border-bottom: none;
}

.model-table__desktop tbody tr {
  transition: background var(--motion-fast) var(--ease-out);
}

.model-table__desktop tbody tr:hover {
  background: var(--surface-2);
}

.model-table__row--inactive td {
  color: var(--text-3);
}

.model-table__row--selected,
.model-table__row--selected:hover {
  background: var(--accent-soft);
  box-shadow: inset 2px 0 0 var(--accent);
}

.model-table__model {
  display: grid;
  gap: 0.05rem;
  min-width: 0;
}

.model-table__name {
  font-weight: 600;
  font-size: 0.86rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-table__id {
  font-size: 0.72rem;
  color: var(--text-3);
}

.model-table__default {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.16rem 0.6rem;
  border-radius: var(--radius-full);
  font-size: 0.7rem;
  font-weight: 500;
  background: var(--accent-soft);
  color: var(--text-on-accent-soft);
  border: 1px solid var(--accent-soft-border);
}

.model-table__muted {
  color: var(--text-disabled);
}

.model-table__provider {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.8rem;
  color: var(--text-2);
  white-space: nowrap;
}

.model-table__date {
  font-size: 0.78rem;
  color: var(--text-3);
  white-space: nowrap;
}

/* Free-access switch: same pill language as the status badges. */
.model-table__free-toggle {
  padding: 0.2rem 0.7rem;
  border-radius: var(--radius-full);
  font-size: 0.72rem;
  font-weight: 500;
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-3);
  cursor: pointer;
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.model-table__free-toggle--on {
  background: var(--info-soft);
  color: var(--info);
  border-color: color-mix(in srgb, var(--info) 25%, transparent);
}

.model-table__free-toggle--off:hover {
  border-color: var(--border-strong);
  color: var(--text-2);
}

.model-table__free-toggle:disabled {
  cursor: not-allowed;
  opacity: 0.75;
}

.model-table__free-toggle:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

/* Icon actions */
.model-table__actions {
  display: flex;
  gap: 0.3rem;
  justify-content: flex-end;
}

.model-table__icon-btn {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  color: var(--text-3);
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out);
}

.model-table__icon-btn:hover {
  background: var(--accent-soft);
  border-color: var(--accent-soft-border);
  color: var(--accent-text);
}

.model-table__icon-btn--default:hover {
  background: var(--accent-soft);
  color: var(--text-on-accent-soft);
}

.model-table__icon-btn--danger:hover {
  background: var(--danger-soft);
  border-color: color-mix(in srgb, var(--danger) 25%, transparent);
  color: var(--danger);
}

/* mobile cards */
.model-table__mobile {
  display: none;
  list-style: none;
  margin: 0;
  padding: 0;
  gap: 0.7rem;
}

.model-table__card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 0.9rem 1rem;
  display: grid;
  gap: 0.65rem;
}

.model-table__card--inactive {
  opacity: 0.75;
}

.model-table__card--selected {
  border-color: var(--accent-soft-border);
  box-shadow: 0 0 0 1px var(--accent-soft-border);
}

.model-table__card-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}

.model-table__card-head .model-table__model {
  flex: 1;
  min-width: 0;
}

.model-table__card-head .model-table__name {
  font-size: 0.9rem;
}

.model-table__card-controls {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  flex-wrap: wrap;
}

.model-table__card-control {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.76rem;
  color: var(--text-2);
}

.model-table__card-meta {
  display: flex;
  gap: 0.9rem;
  font-size: 0.74rem;
  color: var(--text-3);
}

.model-table__actions--card {
  justify-content: flex-start;
  border-top: 1px solid var(--border-subtle);
  padding-top: 0.6rem;
}

.model-table__card-action {
  padding: 0.35rem 0.8rem;
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 0.78rem;
  color: var(--text-2);
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out);
}

.model-table__card-action:hover {
  background: var(--accent-soft);
  border-color: var(--accent-soft-border);
  color: var(--text-on-accent-soft);
}

.model-table__card-action--danger:hover {
  background: var(--danger-soft);
  border-color: color-mix(in srgb, var(--danger) 25%, transparent);
  color: var(--danger);
}

@media (max-width: 767px) {
  .model-table__desktop {
    display: none;
  }

  .model-table__mobile {
    display: grid;
  }
}
</style>
