<script setup lang="ts">
import AppButton from '../ui/AppButton.vue';
import { formatBytes, formatFullDate } from '../../utils/format';
import type { AdminChatFile, ChatFileStatus } from '../../api/types';

defineProps<{ files: AdminChatFile[]; busy?: boolean }>();
defineEmits<{ reprocess: [file: AdminChatFile] }>();

const STATUS_LABELS: Record<ChatFileStatus, string> = {
  UPLOADING: 'در حال آپلود',
  PROCESSING: 'در حال پردازش',
  READY: 'آماده',
  FAILED: 'ناموفق',
};

function statusLabel(status: ChatFileStatus): string {
  return STATUS_LABELS[status] ?? status;
}

function statusModifier(status: ChatFileStatus): string {
  return `file-table__status--${status.toLowerCase()}`;
}

function kindLabel(mimeType: string): string {
  if (mimeType === 'application/pdf') return 'PDF';
  if (mimeType === 'image/png' || mimeType === 'image/jpeg') return 'تصویر';
  return 'Excel';
}
</script>

<template>
  <!-- Desktop: dense table. Mobile (<768px): stacked cards. -->
  <div class="file-table">
    <table class="file-table__desktop">
      <thead>
        <tr>
          <th scope="col">فایل</th>
          <th scope="col">کاربر</th>
          <th scope="col">گفتگو</th>
          <th scope="col">نوع</th>
          <th scope="col">حجم</th>
          <th scope="col">وضعیت</th>
          <th scope="col">تاریخ</th>
          <th scope="col">خطا</th>
          <th scope="col"><span class="visually-hidden">عملیات</span></th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="file in files" :key="file.id" :class="{ 'file-table__row--failed': file.status === 'FAILED' }">
          <td><span class="file-table__name">{{ file.originalName }}</span></td>
          <td class="file-table__muted ltr">{{ file.userEmail ?? '—' }}</td>
          <td class="file-table__muted">{{ file.conversationTitle || '—' }}</td>
          <td>{{ kindLabel(file.mimeType) }}</td>
          <td class="file-table__muted ltr">{{ formatBytes(file.size) }}</td>
          <td>
            <span class="file-table__status" :class="statusModifier(file.status)">
              {{ statusLabel(file.status) }}
            </span>
          </td>
          <td class="file-table__muted">{{ formatFullDate(file.createdAt) }}</td>
          <!-- Safe reason only: internal stack traces never reach this view. -->
          <td class="file-table__error" :title="file.errorMessage ?? undefined">
            {{ file.errorMessage ?? '—' }}
          </td>
          <td>
            <div class="file-table__actions">
              <AppButton
                v-if="file.status === 'FAILED' || file.status === 'READY'"
                variant="ghost"
                size="sm"
                :loading="busy"
                @click="$emit('reprocess', file)"
              >
                پردازش مجدد
              </AppButton>
            </div>
          </td>
        </tr>
      </tbody>
    </table>

    <ul class="file-table__mobile">
      <li
        v-for="file in files"
        :key="file.id"
        class="file-table__card"
        :class="{ 'file-table__card--failed': file.status === 'FAILED' }"
      >
        <div class="file-table__card-head">
          <span class="file-table__name">{{ file.originalName }}</span>
          <span class="file-table__status" :class="statusModifier(file.status)">
            {{ statusLabel(file.status) }}
          </span>
        </div>
        <div class="file-table__card-meta">
          <span class="ltr">{{ file.userEmail ?? '—' }}</span>
          <span>{{ file.conversationTitle || '—' }}</span>
          <span class="ltr">{{ formatBytes(file.size) }}</span>
        </div>
        <p v-if="file.errorMessage" class="file-table__error">{{ file.errorMessage }}</p>
        <div class="file-table__actions">
          <AppButton
            v-if="file.status === 'FAILED' || file.status === 'READY'"
            variant="ghost"
            size="sm"
            :loading="busy"
            @click="$emit('reprocess', file)"
          >
            پردازش مجدد
          </AppButton>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.file-table__desktop {
  width: 100%;
  border-collapse: collapse;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  box-shadow: var(--shadow-1);
}

.file-table__desktop th,
.file-table__desktop td {
  padding: 0.7rem 0.9rem;
  text-align: right;
  font-size: 0.82rem;
  border-bottom: 1px solid var(--border-subtle);
  vertical-align: top;
}

.file-table__desktop th {
  background: var(--surface-2);
  color: var(--text-2);
  font-weight: 500;
  font-size: 0.74rem;
}

.file-table__desktop tr:last-child td {
  border-bottom: none;
}

.file-table__row--failed td {
  background: color-mix(in srgb, var(--danger) 4%, transparent);
}

.file-table__name {
  font-weight: 600;
  font-size: 0.82rem;
  overflow-wrap: anywhere;
}

.file-table__muted {
  color: var(--text-3);
  font-size: 0.78rem;
}

.file-table__error {
  max-width: 16rem;
  color: var(--danger);
  font-size: 0.76rem;
  overflow-wrap: anywhere;
}

/* Status pill — same language as ModelStatus badges. */
.file-table__status {
  display: inline-flex;
  align-items: center;
  padding: 0.14rem 0.55rem;
  border-radius: var(--radius-full);
  font-size: 0.7rem;
  font-weight: 500;
  border: 1px solid transparent;
  white-space: nowrap;
}

.file-table__status--ready {
  background: var(--success-soft);
  color: var(--success);
  border-color: color-mix(in srgb, var(--success) 25%, transparent);
}

.file-table__status--processing,
.file-table__status--uploading {
  background: var(--info-soft);
  color: var(--info);
  border-color: color-mix(in srgb, var(--info) 25%, transparent);
}

.file-table__status--failed {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 25%, transparent);
}

.file-table__actions {
  display: flex;
  gap: 0.25rem;
  justify-content: flex-end;
}

.file-table__mobile {
  display: none;
  list-style: none;
  margin: 0;
  padding: 0;
  gap: 0.7rem;
}

.file-table__card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 0.9rem 1rem;
  display: grid;
  gap: 0.55rem;
}

.file-table__card--failed {
  border-color: color-mix(in srgb, var(--danger) 30%, transparent);
}

.file-table__card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.6rem;
}

.file-table__card-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.7rem;
  font-size: 0.75rem;
  color: var(--text-3);
}

.file-table__card .file-table__actions {
  justify-content: flex-start;
}

@media (max-width: 767px) {
  .file-table__desktop {
    display: none;
  }

  .file-table__mobile {
    display: grid;
  }
}
</style>
