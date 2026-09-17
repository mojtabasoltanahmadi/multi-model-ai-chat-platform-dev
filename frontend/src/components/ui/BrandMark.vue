<script setup lang="ts">
import { computed, useId } from 'vue';

withDefaults(defineProps<{ size?: number }>(), { size: 28 });

// Gradient defs must be referenced by id; useId keeps instances unique.
const gradientId = computed(() => `brand-mark-grad-${useId()}`);
</script>

<template>
  <!-- The Hooshyar spark: one recognizable product mark used everywhere. -->
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 32 32"
    fill="none"
    aria-hidden="true"
    class="brand-mark"
  >
    <rect width="32" height="32" rx="9" :fill="`url(#${gradientId})`" />
    <path
      d="M16 6.5c.5 4.9 4.6 9 9.5 9.5-4.9.5-9 4.6-9.5 9.5-.5-4.9-4.6-9-9.5-9.5 4.9-.5 9-4.6 9.5-9.5Z"
      class="brand-mark__spark"
    />
    <circle cx="23.2" cy="8.8" r="2" class="brand-mark__dot" />
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
        <stop class="brand-mark__grad-start" />
        <stop offset="1" class="brand-mark__grad-end" />
      </linearGradient>
    </defs>
  </svg>
</template>

<style scoped>
.brand-mark__grad-start {
  stop-color: var(--accent);
}

.brand-mark__grad-end {
  stop-color: #8b5cf6;
}

.brand-mark__spark {
  fill: var(--on-accent);
}

.brand-mark__dot {
  fill: var(--on-accent);
  opacity: 0.85;
}
</style>

