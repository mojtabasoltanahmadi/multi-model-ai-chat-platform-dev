<script setup lang="ts">
/**
 * Ambient background light — the subtle aurora behind the chat and admin
 * shells (reference atmosphere). Pure CSS radial gradients from the
 * --aurora-* tokens; static (no animation), pointer-transparent, and always
 * behind content. The parent establishes the positioning context.
 */
</script>

<template>
  <div class="ambient-glow" aria-hidden="true">
    <span class="ambient-glow__orb ambient-glow__orb--a"></span>
    <span class="ambient-glow__orb ambient-glow__orb--b"></span>
    <span class="ambient-glow__orb ambient-glow__orb--c"></span>
  </div>
</template>

<style scoped>
.ambient-glow {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 0;
}

.ambient-glow__orb {
  position: absolute;
  border-radius: 50%;
}

.ambient-glow__orb--a {
  width: 42rem;
  height: 42rem;
  inset-inline-start: -8%;
  top: -24%;
  background: radial-gradient(closest-side, var(--aurora-1), transparent 72%);
}

.ambient-glow__orb--b {
  width: 38rem;
  height: 38rem;
  inset-inline-end: -12%;
  bottom: -28%;
  background: radial-gradient(closest-side, var(--aurora-2), transparent 72%);
}

.ambient-glow__orb--c {
  width: 30rem;
  height: 30rem;
  inset-inline-end: 22%;
  top: -30%;
  background: radial-gradient(closest-side, var(--aurora-3), transparent 70%);
}
</style>
