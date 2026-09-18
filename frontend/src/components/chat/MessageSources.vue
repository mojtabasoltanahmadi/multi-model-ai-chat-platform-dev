<script setup lang="ts">
import { computed } from 'vue';
import { isSafeExternalUrl, safeDomainOf } from '../../utils/urlSafety';
import type { MessageSource } from '../../api/types';

interface Props {
  sources: MessageSource[];
}

const props = defineProps<Props>();

/**
 * Defense in depth: the backend already persists http(s) URLs only, but an
 * unsafe row must never become a link even if it ever arrives here.
 */
const safeSources = computed(() =>
  props.sources.filter((source) => isSafeExternalUrl(source?.url)),
);
</script>

<template>
  <section v-if="safeSources.length > 0" class="sources" aria-label="منابع">
    <h4 class="sources__title">منابع</h4>
    <ul class="sources__list">
      <li v-for="(source, index) in safeSources" :key="`${source.url}#${index}`" class="sources__item">
        <a
          class="sources__card"
          :href="source.url"
          target="_blank"
          rel="noopener"
          :title="source.title"
        >
          <span class="sources__index" aria-hidden="true">{{ (index + 1).toLocaleString('fa-IR') }}</span>
          <span class="sources__text">
            <span class="sources__name">{{ source.title }}</span>
            <span class="sources__domain ltr mono">{{ safeDomainOf(source.url, source.domain) }}</span>
          </span>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M7 17 17 7" />
            <path d="M8 7h9v9" />
          </svg>
        </a>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.sources {
  display: grid;
  gap: 0.45rem;
  margin-top: 0.6rem;
}

.sources__title {
  margin: 0;
  font-size: 0.78rem;
  font-weight: 600;
  color: var(--text-2);
}

.sources__list {
  display: grid;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.sources__card {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.5rem 0.65rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: inherit;
  text-decoration: none;
  transition:
    border-color var(--motion-fast) var(--ease-out),
    background var(--motion-fast) var(--ease-out);
}

.sources__card:hover {
  background: var(--surface-2);
  border-color: var(--border-strong);
}

.sources__index {
  display: grid;
  place-items: center;
  width: 1.4rem;
  height: 1.4rem;
  flex-shrink: 0;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--text-on-accent-soft);
  background: var(--accent-soft);
  border: 1px solid var(--accent-soft-border);
  border-radius: var(--radius-full);
}

.sources__text {
  display: grid;
  gap: 0.1rem;
  min-width: 0;
  flex: 1;
}

.sources__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.82rem;
  font-weight: 500;
  color: var(--text-1);
}

.sources__domain {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.7rem;
  color: var(--text-3);
}

.sources__card > svg {
  flex-shrink: 0;
  color: var(--text-3);
}
</style>
