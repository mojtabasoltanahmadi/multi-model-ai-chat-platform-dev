<script setup lang="ts">
import { computed } from 'vue';
import { THEME_DEFINITIONS, type ThemeId } from '../../themes/registry';

/**
 * Miniature app mockup painted from a theme's preview palette (see
 * src/themes/registry.ts) — dark sidebar strip, content area, chat composer
 * and a gradient CTA. Pure presentation: no live tokens, so any theme can be
 * previewed while another one is active. Used by the admin theme manager
 * (list cards + preview modal).
 */
interface Props {
  themeId: ThemeId;
  size?: 'sm' | 'lg';
}

const props = withDefaults(defineProps<Props>(), { size: 'sm' });

const palette = computed(() => THEME_DEFINITIONS[props.themeId].preview);
const label = computed(() => `پیش‌نمایش پوسته ${THEME_DEFINITIONS[props.themeId].name}`);
</script>

<template>
  <div
    class="theme-preview"
    :class="`theme-preview--${size}`"
    role="img"
    :aria-label="label"
    :style="{
      background: palette.bg,
      borderColor: palette.border,
      color: palette.text,
    }"
  >
    <!-- Sidebar strip -->
    <div
      class="theme-preview__sidebar"
      :style="{ borderColor: palette.border }"
    >
      <span
        class="theme-preview__brand-dot"
        :style="{ background: `linear-gradient(135deg, ${palette.accent}, ${palette.accent2})` }"
      ></span>
      <span class="theme-preview__nav theme-preview__nav--active" :style="{ background: palette.accent + '1f', borderColor: palette.accent + '2e' }"></span>
      <span class="theme-preview__nav" :style="{ background: palette.surface2 }"></span>
      <span class="theme-preview__nav theme-preview__nav--short" :style="{ background: palette.surface2 }"></span>
    </div>

    <!-- Content area -->
    <div class="theme-preview__content">
      <span class="theme-preview__greeting" :style="{ background: palette.text, opacity: 0.92 }"></span>
      <span class="theme-preview__greeting theme-preview__greeting--short" :style="{ background: palette.text, opacity: 0.55 }"></span>

      <!-- Sample card -->
      <div
        class="theme-preview__card"
        :style="{ background: palette.surface, borderColor: palette.border }"
      >
        <span class="theme-preview__line" :style="{ background: palette.text2 }"></span>
        <span class="theme-preview__line theme-preview__line--short" :style="{ background: palette.text2, opacity: 0.6 }"></span>
      </div>

      <!-- Composer -->
      <div
        class="theme-preview__composer"
        :style="{ background: palette.surface2, borderColor: palette.border }"
      >
        <span class="theme-preview__composer-hint" :style="{ background: palette.text2, opacity: 0.45 }"></span>
        <span
          class="theme-preview__send"
          :style="{ background: `linear-gradient(135deg, ${palette.accent}, ${palette.accent2})` }"
        ></span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.theme-preview {
  display: flex;
  width: 100%;
  aspect-ratio: 16 / 10;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  overflow: hidden;
  flex-shrink: 0;
}

.theme-preview__sidebar {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14%;
  width: 18%;
  padding-top: 10%;
  border-inline-end: 1px solid var(--border);
}

.theme-preview__brand-dot {
  width: 22%;
  aspect-ratio: 1;
  border-radius: var(--radius-full);
  margin-bottom: 6%;
}

.theme-preview__nav {
  width: 58%;
  height: 7%;
  min-height: 3px;
  border-radius: var(--radius-full);
  border: 1px solid transparent;
}

.theme-preview__nav--short {
  width: 40%;
}

.theme-preview__content {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  gap: 7%;
  padding: 8% 9%;
}

.theme-preview__greeting {
  align-self: stretch;
  height: 6%;
  min-height: 4px;
  width: 62%;
  border-radius: var(--radius-full);
}

.theme-preview__greeting--short {
  width: 44%;
}

.theme-preview__card {
  align-self: stretch;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 12%;
  height: 22%;
  padding: 0 7%;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.theme-preview__line {
  width: 70%;
  height: 2px;
  border-radius: var(--radius-full);
}

.theme-preview__line--short {
  width: 45%;
}

.theme-preview__composer {
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6%;
  height: 17%;
  padding: 0 5%;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.theme-preview__composer-hint {
  width: 46%;
  height: 2px;
  border-radius: var(--radius-full);
}

.theme-preview__send {
  width: 14%;
  aspect-ratio: 1;
  max-width: 14px;
  border-radius: 26%;
  flex-shrink: 0;
}
</style>
