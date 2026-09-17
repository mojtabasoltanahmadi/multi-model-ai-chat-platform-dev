<script setup lang="ts">
import BrandMark from '../ui/BrandMark.vue';
import ModelSelector from './ModelSelector.vue';
import type { AiModel } from '../../api/types';

interface Props {
  title: string;
  models: AiModel[];
  modelId: string;
}

defineProps<Props>();
const emit = defineEmits<{ 'update:modelId': [id: string]; openMenu: [] }>();
</script>

<template>
  <header class="chat-header">
    <button
      type="button"
      class="chat-header__menu-button"
      aria-label="باز کردن فهرست گفتگوها"
      @click="emit('openMenu')"
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
        <path d="M4 6h16M4 12h16M4 18h10" />
      </svg>
    </button>

    <BrandMark :size="24" class="chat-header__brand" />

    <h1 class="chat-header__title">{{ title }}</h1>

    <div class="chat-header__spacer"></div>

    <ModelSelector
      :models="models"
      :model-id="modelId"
      placement="down"
      compact
      @update:model-id="emit('update:modelId', $event)"
    />
  </header>
</template>

<style scoped>
.chat-header {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  height: 3.6rem;
  padding: 0 1.2rem;
  background: var(--surface-glass);
  backdrop-filter: blur(8px);
  border-bottom: 1px solid var(--border-subtle);
}

.chat-header__menu-button {
  display: none;
  place-items: center;
  width: 2.2rem;
  height: 2.2rem;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-2);
}

.chat-header__menu-button:hover {
  background: var(--surface-2);
  color: var(--text-1);
}

.chat-header__brand {
  display: none;
}

.chat-header__title {
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  /* Flex items don't shrink below content width without this; without it a
     long title overflows the header row on narrow screens. */
  min-width: 0;
}

.chat-header__spacer {
  flex: 1;
}

@media (max-width: 1023px) {
  .chat-header__menu-button {
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
  }

  .chat-header__brand {
    display: block;
  }
}
</style>
