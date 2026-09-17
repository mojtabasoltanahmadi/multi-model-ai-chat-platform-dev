<script setup lang="ts">
import { computed } from 'vue';
import BrandMark from '../ui/BrandMark.vue';
import { useAuth } from '../../composables/useAuth';
import { displayNameFromEmail } from '../../utils/format';

interface Suggestion {
  icon: string;
  title: string;
  prompt: string;
}

const emit = defineEmits<{ pick: [prompt: string] }>();

const auth = useAuth();

/** «سلام Mojtaba عزیز» when a name can be derived, otherwise a generic hello. */
const greeting = computed(() => {
  const name = displayNameFromEmail(auth.state.user?.email);
  return name ? `سلام ${name} عزیز` : 'سلام، آماده‌ای؟';
});

const suggestions: Suggestion[] = [
  {
    icon: 'M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.2 2.2m8.4 8.4 2.2 2.2m0-12.8-2.2 2.2M7.8 16.2l-2.2 2.2',
    title: 'ایده‌پردازی برای پروژه',
    prompt: 'برای یک پروژه جدید به من ایده‌پردازی کن. موضوع پروژه را از من بپرس و چند ایده خلاقانه پیشنهاد بده.',
  },
  {
    icon: 'M12 6.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4',
    title: 'توضیح یک مفهوم پیچیده',
    prompt: 'یک مفهوم پیچیده‌ای که همیشه برایم مبهم بوده را به زبان ساده توضیح بده. پیشنهاد می‌دهم با یک مثال ملموس شروع کنی.',
  },
  {
    icon: 'M4 20h16M6 16l10-10a2.1 2.1 0 0 1 3 3L9 19l-4 1 1-4Z',
    title: 'نوشتن متن حرفه‌ای',
    prompt: 'می‌خواهم یک ایمیل ادبی و حرفه‌ای به همکارم بنویسم. لحن رسمی و صمیمی را ترکیب کن و پیش‌نویس بنویس.',
  },
  {
    icon: 'M3 3v18h18M7 15v3m5-9v9m5-13v13',
    title: 'تحلیل یک موضوع',
    prompt: 'یک موضوع موردعلاقه‌ام را از دو دیدگاه مخالف تحلیل کن و در پایان جمع‌بندی منصفانه‌ای ارائه بده.',
  },
];
</script>

<template>
  <div class="empty-chat">
    <BrandMark :size="46" class="empty-chat__mark" />
    <h2 class="empty-chat__title">
      {{ greeting }}
      <svg class="empty-chat__spark" width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 2c.6 4.5 4.5 8.4 9 9-4.5.6-8.4 4.5-9 9-.6-4.5-4.5-8.4-9-9 4.5-.6 8.4-4.5 9-9Z" />
      </svg>
    </h2>
    <p class="empty-chat__subtitle">امروز چه کاری می‌تونم برات انجام بدم؟</p>
    <p class="empty-chat__hint">
      سؤال بپرس، ایده بساز، بنویس یا تحلیل کن — پاسخ‌ها را زنده و در لحظه دریافت می‌کنی.
    </p>

    <div class="empty-chat__suggestions">
      <button
        v-for="suggestion in suggestions"
        :key="suggestion.title"
        type="button"
        class="empty-chat__card"
        @click="emit('pick', suggestion.prompt)"
      >
        <span class="empty-chat__card-icon" aria-hidden="true">
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true">
            <path :d="suggestion.icon" />
          </svg>
        </span>
        <span class="empty-chat__card-title">{{ suggestion.title }}</span>
        <svg class="empty-chat__card-arrow" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M19 12H5m7-7-7 7 7 7" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.empty-chat {
  max-width: 34rem;
  margin-inline: auto;
  padding: 4rem 1.5rem 2rem;
  display: grid;
  justify-items: center;
  text-align: center;
  gap: 0.5rem;
}

.empty-chat__mark {
  margin-bottom: 1rem;
  filter: drop-shadow(0 8px 24px color-mix(in srgb, var(--accent) 45%, transparent));
}

.empty-chat__title {
  display: inline-flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 1.9rem;
  font-weight: 700;
}

.empty-chat__spark {
  color: var(--accent-text);
  filter: drop-shadow(0 0 10px color-mix(in srgb, var(--accent) 55%, transparent));
}

.empty-chat__subtitle {
  font-size: 1rem;
  color: var(--text-1);
  font-weight: 500;
}

.empty-chat__hint {
  max-width: 42ch;
  font-size: 0.85rem;
  color: var(--text-2);
  margin-bottom: 2rem;
}

.empty-chat__suggestions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.7rem;
  width: 100%;
}

.empty-chat__card {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  padding: 0.85rem 0.95rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  text-align: right;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out),
    translate var(--motion-fast) var(--ease-out);
}

.empty-chat__card:hover {
  border-color: var(--accent-soft-border);
  box-shadow: var(--shadow-glow);
  translate: 0 -1px;
}

.empty-chat__card-icon {
  display: grid;
  place-items: center;
  width: 2rem;
  height: 2rem;
  flex-shrink: 0;
  border-radius: var(--radius-sm);
  background: var(--accent-soft);
  color: var(--text-on-accent-soft);
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

/* On hover the tile lights up with the brand gradient. */
.empty-chat__card:hover .empty-chat__card-icon {
  background: var(--gradient-primary);
  color: var(--on-accent);
}

.empty-chat__card-title {
  flex: 1;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-1);
}

.empty-chat__card-arrow {
  color: var(--text-3);
  flex-shrink: 0;
}

@media (max-width: 640px) {
  .empty-chat {
    padding-top: 2.4rem;
  }

  .empty-chat__title {
    font-size: 1.5rem;
  }

  .empty-chat__suggestions {
    grid-template-columns: 1fr;
  }
}
</style>
