<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * Ambient background light — the subtle aurora behind the chat, admin and
 * auth shells. Pure CSS radial gradients from the --aurora-* tokens; static,
 * pointer-transparent, always behind content. The parent establishes the
 * positioning context.
 *
 * Also renders the cursor-reactive orb: a large, blurred, low-opacity
 * brand-colored glow that trails the pointer — ambient lighting, not an
 * effect. Alpha comes from --cursor-glow (theme-scoped; whisper-level).
 * Disabled on coarse pointers (touch) and under prefers-reduced-motion.
 */
const root = ref<HTMLElement | null>(null);
const orb = ref<HTMLElement | null>(null);

let rafId = 0;
let targetX = -9999;
let targetY = -9999;
let currentX = -9999;
let currentY = -9999;

function onPointerMove(event: PointerEvent) {
  const container = root.value;
  if (!container) return;
  const rect = container.getBoundingClientRect();
  targetX = event.clientX - rect.left;
  targetY = event.clientY - rect.top;
  if (!rafId) rafId = requestAnimationFrame(frame);
}

/** Lerp toward the pointer so the light drifts like ambient glow, not a cursor. */
function frame() {
  const dx = targetX - currentX;
  const dy = targetY - currentY;
  currentX += dx * 0.08;
  currentY += dy * 0.08;
  if (orb.value) {
    orb.value.style.transform = `translate3d(${currentX}px, ${currentY}px, 0) translate(-50%, -50%)`;
  }
  if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
    rafId = requestAnimationFrame(frame);
  } else {
    rafId = 0;
  }
}

onMounted(() => {
  const fine = window.matchMedia('(pointer: fine)').matches;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!fine || reduced) return;
  document.addEventListener('pointermove', onPointerMove, { passive: true });
});

onBeforeUnmount(() => {
  document.removeEventListener('pointermove', onPointerMove);
  if (rafId) cancelAnimationFrame(rafId);
});
</script>

<template>
  <div ref="root" class="ambient-glow" aria-hidden="true">
    <span class="ambient-glow__orb ambient-glow__orb--a"></span>
    <span class="ambient-glow__orb ambient-glow__orb--b"></span>
    <span class="ambient-glow__orb ambient-glow__orb--c"></span>
    <span ref="orb" class="ambient-glow__cursor"></span>
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

/* Cursor-reactive light: positioned by JS (lerped), colored per theme. */
.ambient-glow__cursor {
  position: absolute;
  top: 0;
  left: 0;
  width: 36rem;
  height: 36rem;
  border-radius: 50%;
  background: radial-gradient(closest-side, var(--cursor-glow), transparent 70%);
  will-change: transform;
}
</style>
