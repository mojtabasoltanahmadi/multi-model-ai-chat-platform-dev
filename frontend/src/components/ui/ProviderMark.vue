<script setup lang="ts">
import { useId } from 'vue';
import type { AiProviderKind } from '../../api/types';

/**
 * Provider-kind tile — the model's visual identity in tables, panels and
 * selectors. Each kind has a fixed identity gradient (constant across themes,
 * like a brand logo) and an abstract glyph — never a fake vendor logo:
 *   mock               → violet, flask glyph (experimental)
 *   openai-compatible  → cyan, hexagon-node glyph (OpenAI-compatible APIs)
 *   anthropic          → terracotta, A-frame glyph (Claude)
 *   google             → blue→teal, four-point spark glyph (Gemini)
 */
interface Props {
  provider: AiProviderKind;
  size?: number;
}

const props = withDefaults(defineProps<Props>(), { size: 28 });

// Gradient defs are referenced by id; useId keeps instances unique.
const gradientId = `provider-mark-grad-${useId()}`;

interface ProviderIdentity {
  glyphPath: string;
  from: string;
  to: string;
}

const identities: Record<AiProviderKind, ProviderIdentity> = {
  mock: {
    glyphPath:
      'M10 2.5v5.2L4.8 17.6a1.9 1.9 0 0 0 1.7 2.9h11a1.9 1.9 0 0 0 1.7-2.9L14 7.7V2.5M8 2.5h8M7.5 14.5h9',
    from: '#8b5cf6',
    to: '#6366f1',
  },
  'openai-compatible': {
    glyphPath:
      'M12 2.8 20 7.4v9.2L12 21.2 4 16.6V7.4L12 2.8ZM12 8.4a3.6 3.6 0 1 0 0 7.2 3.6 3.6 0 0 0 0-7.2Z',
    from: '#06b6d4',
    to: '#0ea5e9',
  },
  anthropic: {
    // Abstract A-frame strokes — brand-adjacent without copying the logo.
    glyphPath: 'M6.5 20 12 4l5.5 16M8.6 14.6h6.8',
    from: '#d97757',
    to: '#c2410c',
  },
  google: {
    // Four-point spark — reads as Gemini while staying an abstract mark.
    glyphPath: 'M12 3c.9 4.4 4.6 8.1 9 9-4.4.9-8.1 4.6-9 9-.9-4.4-4.6-8.1-9-9 4.4-.9 8.1-4.6 9-9Z',
    from: '#4285f4',
    to: '#0ea5e9',
  },
};

const identity = identities[props.provider];
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
      :d="identity.glyphPath"
      fill="none"
      stroke="#fff"
      stroke-width="1.7"
      stroke-linecap="round"
      stroke-linejoin="round"
      opacity="0.95"
    />
    <defs>
      <linearGradient :id="gradientId" x1="0" y1="0" x2="24" y2="24" gradientUnits="userSpaceOnUse">
        <stop :stop-color="identity.from" />
        <stop offset="1" :stop-color="identity.to" />
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
