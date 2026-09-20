<script setup lang="ts">
import logo from '@/assets/brand-mark.png';
// import logo from '../../assets/brand-mark.png';

withDefaults(
  defineProps<{ size?: number }>(),
  { size: 32 }
);
</script>

<template>
  <img
    :src="logo"
    :width="size"
    :height="size"
    alt="Brand mark"
    class="brand-mark"
  />
</template>

<style scoped>
.brand-mark {
  object-fit: contain;
}
</style>