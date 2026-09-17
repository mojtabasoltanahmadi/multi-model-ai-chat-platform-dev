<script setup lang="ts">
import { useId } from 'vue';
import type { AiProviderKind } from '../../api/types';

/**
 * Provider-kind tile — the model's visual identity in tables, panels and
 * selectors. The MVP ships two provider kinds, each with a fixed identity
 * gradient (constant across themes, like a brand logo):
 *   mock               → violet, flask glyph (experimental)
 *   openai-compatible  → cyan, node glyph (OpenAI-compatible APIs)
 */
interface Props {
  provider: AiProviderKind;
  size?: number;
}

const props = withDefaults(defineProps<Props>(), { size: 28 });

// Gradient defs are referenced by id; useId keeps instances unique.
const gradientId = `provider-mark-grad-${useId()}`;

const glyphPath =
  props.provider === 'mock'
    ? 'M10 2.5v5.2L4.8 17.6a1.9 1.9 0 0 0 1.7 2.9h11a1.9 1.9 0 0 0 1.7-2.9L14 7.7V2.5M8 2.5h8M7.5 14.5h9'
    : 'M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4L12 2.8ZM12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z';
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    aria-hidden="true"
    class="provider-mark"
    :class="`provider-mark--${provider}`"
  >
    <rect width="24" height="24" rx="7" :fill="`url(#${gradientId})`" />
    <path
      :d="glyphPath"
      fill="none"
      stroke="#fff"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      opacity="0.95"
    />
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
        <template v-if="provider === 'mock'">
          <stop stop-color="#8b5cf6" />
          <stop offset="1" stop-color="#6366f1" />
        </template>
        <template v-else>
          <stop stop-color="#06b6d4" />
          <stop offset="1" stop-color="#0ea5e9" />
        </template>
      </linearGradient>
    </defs>
  </svg>
</template>

<style scoped>
.provider-mark {
  flex-shrink: 0;
  display: block;
}
</style>
