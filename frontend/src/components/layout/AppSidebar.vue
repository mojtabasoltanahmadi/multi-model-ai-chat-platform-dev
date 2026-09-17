<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import BrandMark from '../ui/BrandMark.vue';
import AppButton from '../ui/AppButton.vue';
import AppAvatar from '../ui/AppAvatar.vue';
import ThemeToggle from '../ui/ThemeToggle.vue';
import AppSkeleton from '../ui/AppSkeleton.vue';
import { useAuth } from '../../composables/useAuth';
import { formatRelative } from '../../utils/format';
import type { Conversation } from '../../api/types';

interface Props {
  conversations: Conversation[];
  activeId: string | null;
  loading?: boolean;
  /** Drawer mode on small screens. */
  open?: boolean;
  /** Desktop-only: collapsed to a narrow rail. Ignored by the mobile drawer. */
  collapsed?: boolean;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  select: [id: string];
  create: [];
  close: [];
  toggleCollapse: [];
}>();

const router = useRouter();
const auth = useAuth();

const search = ref('');
const profileOpen = ref(false);
const profileRoot = ref<HTMLElement | null>(null);

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase();
  if (!query) return props.conversations;
  return props.conversations.filter((conversation) =>
    conversation.title.toLowerCase().includes(query),
  );
});

interface ConversationGroup {
  label: string;
  items: Conversation[];
}

/** Groups conversations into «today / yesterday / last 7 days / older» buckets. */
const groups = computed<ConversationGroup[]>(() => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfLast7 = new Date(startOfToday);
  startOfLast7.setDate(startOfLast7.getDate() - 7);

  const buckets: Record<string, Conversation[]> = {
    'امروز': [],
    'دیروز': [],
    '۷ روز گذشته': [],
    'قدیمی‌تر': [],
  };

  for (const conversation of filtered.value) {
    const updated = new Date(conversation.updatedAt);
    if (updated >= startOfToday) buckets['امروز']!.push(conversation);
    else if (updated >= startOfYesterday) buckets['دیروز']!.push(conversation);
    else if (updated >= startOfLast7) buckets['۷ روز گذشته']!.push(conversation);
    else buckets['قدیمی‌تر']!.push(conversation);
  }

  return Object.entries(buckets)
    .filter(([, items]) => items.length > 0)
    .map(([label, items]) => ({ label, items }));
});

function onProfileToggle() {
  profileOpen.value = !profileOpen.value;
}

function onDocumentClick(event: MouseEvent) {
  if (profileOpen.value && !profileRoot.value?.contains(event.target as Node)) {
    profileOpen.value = false;
  }
}

function onDocumentKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    profileOpen.value = false;
    emit('close');
  }
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick);
  document.addEventListener('keydown', onDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick);
  document.removeEventListener('keydown', onDocumentKeydown);
});

function goAdmin() {
  profileOpen.value = false;
  emit('close');
  void router.push({ name: 'admin-models' });
}

function onLogout() {
  profileOpen.value = false;
  emit('close');
  auth.logout();
  void router.push({ name: 'login' });
}

function onSelect(id: string) {
  emit('select', id);
  emit('close');
  void nextTick();
}

function onCreate() {
  emit('create');
  emit('close');
}
</script>

<template>
  <aside
    id="chat-sidebar"
    class="sidebar"
    :class="{ 'sidebar--open': open, 'sidebar--collapsed': collapsed }"
    aria-label="فهرست گفتگوها"
  >
    <div class="sidebar__inner">
      <header class="sidebar__brand">
        <button
          type="button"
          class="sidebar__toggle"
          aria-label="باز و بسته کردن فهرست گفتگوها"
          :aria-expanded="!collapsed"
          aria-controls="chat-sidebar"
          @click="emit('toggleCollapse')"
        >
          <!-- Panel icon; mirrored for RTL so the divider hugs the sidebar edge. -->
          <svg v-if="!collapsed" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2.5" />
            <path d="M9 3v18" />
            <path d="m16 15-3-3 3-3" />
          </svg>
          <svg v-else width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2.5" />
            <path d="M9 3v18" />
            <path d="m13 9 3 3-3 3" />
          </svg>
        </button>
        <BrandMark v-if="!collapsed" :size="30" />
        <div v-if="!collapsed" class="sidebar__brand-text">
          <strong>هوش‌یار</strong>
          <span>دستیار هوشمند شما</span>
        </div>
        <button
          type="button"
          class="sidebar__close-drawer"
          aria-label="بستن فهرست"
          @click="emit('close')"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div class="sidebar__actions">
        <AppButton block @click="onCreate">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
            <path d="M12 5v14M5 12h14" />
          </svg>
          گفتگو تازه
        </AppButton>
        <div class="sidebar__search">
          <svg class="sidebar__search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.2-3.2" />
          </svg>
          <input
            v-model="search"
            type="search"
            class="sidebar__search-input"
            placeholder="جستجو در گفتگوها…"
            aria-label="جستجو در گفتگوها"
          />
        </div>
      </div>

      <nav class="sidebar__list" aria-label="گفتگوها">
        <template v-if="loading">
          <div v-for="row in 4" :key="row" class="sidebar__skeleton">
            <AppSkeleton :lines="1" width="80%" />
          </div>
        </template>
        <template v-else-if="groups.length === 0">
          <p class="sidebar__empty">
            {{ search ? 'نتیجه‌ای پیدا نشد.' : 'هنوز گفتگو ندارید. یکی بسازید!' }}
          </p>
        </template>
        <template v-else>
          <section v-for="group in groups" :key="group.label" class="sidebar__group">
            <h3 class="sidebar__group-label">{{ group.label }}</h3>
            <button
              v-for="conversation in group.items"
              :key="conversation.id"
              type="button"
              class="sidebar__item"
              :class="{ 'sidebar__item--active': conversation.id === activeId }"
              :aria-current="conversation.id === activeId ? 'true' : undefined"
              @click="onSelect(conversation.id)"
            >
              <span class="sidebar__item-title">{{ conversation.title }}</span>
              <span class="sidebar__item-time">{{ formatRelative(conversation.updatedAt) }}</span>
            </button>
          </section>
        </template>
      </nav>

      <footer ref="profileRoot" class="sidebar__profile">
        <button
          type="button"
          class="sidebar__profile-trigger"
          :aria-expanded="profileOpen"
          aria-haspopup="menu"
          @click="onProfileToggle"
        >
          <AppAvatar :name="auth.state.user?.email ?? '?'" :size="30" />
          <span class="sidebar__profile-email ltr">{{ auth.state.user?.email }}</span>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>

        <Transition name="sidebar-pop">
          <div v-if="profileOpen" class="sidebar__menu" role="menu">
            <div class="sidebar__menu-section">
              <span class="sidebar__menu-label">پوسته</span>
              <ThemeToggle />
            </div>
            <button
              v-if="auth.isAdmin.value"
              type="button"
              class="sidebar__menu-item"
              role="menuitem"
              @click="goAdmin"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1.5" />
                <rect x="14" y="3" width="7" height="7" rx="1.5" />
                <rect x="3" y="14" width="7" height="7" rx="1.5" />
                <rect x="14" y="14" width="7" height="7" rx="1.5" />
              </svg>
              مدیریت مدل‌ها
            </button>
            <button type="button" class="sidebar__menu-item sidebar__menu-item--exit" role="menuitem" @click="onLogout">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">
                <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9" />
              </svg>
              خروج از حساب
            </button>
          </div>
        </Transition>
      </footer>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  height: 100dvh;
  flex-shrink: 0;
}

.sidebar__inner {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 1rem 0.9rem;
  background: var(--surface);
  border-inline-end: 1px solid var(--border);
  overflow: hidden;
}

/* Brand */
.sidebar__brand {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.2rem 0.4rem 1rem;
}

.sidebar__brand-text {
  display: grid;
  line-height: 1.35;
}

.sidebar__brand-text strong {
  font-size: 1rem;
}

.sidebar__brand-text span {
  font-size: 0.72rem;
  color: var(--text-3);
}

.sidebar__close-drawer {
  display: none;
  margin-inline-start: auto;
}

/* Actions */
.sidebar__actions {
  display: grid;
  gap: 0.6rem;
  margin-bottom: 0.9rem;
}

.sidebar__search {
  position: relative;
}

.sidebar__search-icon {
  position: absolute;
  inset-inline-start: 0.7rem;
  top: 50%;
  translate: 0 -50%;
  color: var(--text-3);
  pointer-events: none;
}

.sidebar__search-input {
  width: 100%;
  height: 2.3rem;
  padding: 0 2.1rem;
  background: var(--surface-inset);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  font-size: 0.82rem;
  outline: none;
  transition: border-color var(--motion-fast) var(--ease-out);
}

.sidebar__search-input::-webkit-search-cancel-button {
  display: none;
}

.sidebar__search-input:focus {
  background: var(--surface);
  border-color: var(--accent);
}

/* List */
.sidebar__list {
  flex: 1;
  overflow-y: auto;
  display: grid;
  gap: 1rem;
  align-content: start;
  padding: 0.2rem;
  margin: -0.2rem;
}

.sidebar__group {
  display: grid;
  gap: 2px;
}

.sidebar__group-label {
  font-size: 0.68rem;
  font-weight: 500;
  color: var(--text-3);
  padding: 0 0.5rem 0.25rem;
  letter-spacing: 0.02em;
}

.sidebar__item {
  display: grid;
  gap: 0.1rem;
  width: 100%;
  text-align: right;
  padding: 0.5rem 0.65rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out);
}

.sidebar__item:hover {
  background: var(--surface-2);
}

.sidebar__item--active {
  background: var(--accent-soft);
  border-color: var(--accent-soft-border);
  box-shadow: 0 2px 14px color-mix(in srgb, var(--accent) 16%, transparent);
}

.sidebar__item--active:hover {
  background: var(--accent-soft);
}

.sidebar__item-title {
  font-size: 0.85rem;
  color: var(--text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sidebar__item-time {
  font-size: 0.7rem;
  color: var(--text-3);
}

.sidebar__skeleton {
  padding: 0.5rem 0.65rem;
}

.sidebar__empty {
  padding: 1rem 0.5rem;
  font-size: 0.8rem;
  color: var(--text-3);
}

/* Profile */
.sidebar__profile {
  position: relative;
  border-top: 1px solid var(--border-subtle);
  padding-top: 0.6rem;
  margin-top: 0.6rem;
}

.sidebar__profile-trigger {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.45rem 0.5rem;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  transition: background var(--motion-fast) var(--ease-out);
}

.sidebar__profile-trigger:hover {
  background: var(--surface-2);
}

.sidebar__profile-email {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  font-size: 0.78rem;
  color: var(--text-2);
}

.sidebar__menu {
  position: absolute;
  bottom: calc(100% + 0.5rem);
  inset-inline-end: 0;
  z-index: var(--z-dropdown);
  width: 15rem;
  padding: 0.6rem;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-3);
}

.sidebar__menu-section {
  display: grid;
  gap: 0.45rem;
  padding: 0.2rem 0.3rem 0.7rem;
  border-bottom: 1px solid var(--border-subtle);
  margin-bottom: 0.4rem;
}

.sidebar__menu-label {
  font-size: 0.7rem;
  color: var(--text-3);
}

.sidebar__menu-item {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.5rem 0.55rem;
  background: transparent;
  border: none;
  border-radius: var(--radius-xs);
  font-size: 0.83rem;
  color: var(--text-1);
  transition: background var(--motion-fast) var(--ease-out);
}

.sidebar__menu-item:hover {
  background: var(--surface-2);
}

.sidebar__menu-item--exit {
  color: var(--danger);
}

.sidebar__menu-item--exit:hover {
  background: var(--danger-soft);
}

/* popover transition */
.sidebar-pop-enter-active,
.sidebar-pop-leave-active {
  transition:
    opacity var(--motion-fast) var(--ease-out),
    transform var(--motion-fast) var(--ease-out);
}

.sidebar-pop-enter-from,
.sidebar-pop-leave-to {
  opacity: 0;
  transform: translateY(6px);
}

/* Collapse toggle — desktop only; mobile uses the drawer controls. */
.sidebar__toggle {
  display: none;
  place-items: center;
  width: 2.2rem;
  height: 2.2rem;
  flex-shrink: 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-2);
  transition:
    background var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out);
}

.sidebar__toggle:hover {
  background: var(--surface-2);
  color: var(--text-1);
}

/* Mirror the panel icon so its divider hugs the sidebar edge in RTL. */
[dir='rtl'] .sidebar__toggle svg {
  transform: scaleX(-1);
}

/* Elements hidden while collapsed; visibility removes them from tab order
   and the accessibility tree, flipping discretely with the fade. */
.sidebar__brand-text,
.sidebar__actions,
.sidebar__list,
.sidebar__profile {
  transition:
    opacity var(--motion-fast) var(--ease-out),
    visibility var(--motion-fast);
}

/* Collapsed rail (desktop only — the mobile drawer ignores collapse state). */
@media (min-width: 1024px) {
  .sidebar__toggle {
    display: grid;
  }

  .sidebar {
    transition: width var(--motion-normal) var(--ease-out);
  }

  .sidebar--collapsed {
    width: var(--sidebar-collapsed-width);
  }

  .sidebar--collapsed .sidebar__inner {
    padding-inline: 0.4rem;
  }

  .sidebar--collapsed .sidebar__brand {
    justify-content: center;
    padding-inline: 0;
  }

  .sidebar--collapsed .sidebar__brand-text,
  .sidebar--collapsed .sidebar__actions,
  .sidebar--collapsed .sidebar__list,
  .sidebar--collapsed .sidebar__profile,
  .sidebar--collapsed :deep(.brand-mark) {
    opacity: 0;
    visibility: hidden;
  }
}

/* Drawer (mobile/tablet) — inline-start is the natural sidebar edge in both directions. */
@media (max-width: 1023px) {
  .sidebar {
    position: fixed;
    inset-block: 0;
    inset-inline-start: 0;
    z-index: var(--z-drawer);
    translate: 100% 0;
    transition: translate var(--motion-slow) var(--ease-out);
  }

  .sidebar--open {
    translate: 0 0;
  }

  .sidebar__close-drawer {
    display: grid;
    place-items: center;
    width: 2.5rem;
    height: 2.5rem;
    background: transparent;
    border: none;
    border-radius: var(--radius-xs);
    color: var(--text-3);
  }

  .sidebar__close-drawer:hover {
    background: var(--surface-2);
    color: var(--text-1);
  }
}
</style>
