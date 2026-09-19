<script setup lang="ts">
import { watch } from 'vue';
import ToastHost from './components/ui/ToastHost.vue';
import { useAuth } from './composables/useAuth';
import { useTheme } from './composables/useTheme';

const auth = useAuth();
const theme = useTheme();

// Theme availability is public; the stored preference only exists once signed
// in. Re-sync on every login/logout flip (and once at startup).
watch(
  () => auth.isLoggedIn.value,
  (loggedIn) => {
    void theme.syncServerState(loggedIn);
  },
  { immediate: true },
);
</script>

<template>
  <router-view />
  <ToastHost />
</template>
