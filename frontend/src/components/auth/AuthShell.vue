<script setup lang="ts">
import BrandMark from '../ui/BrandMark.vue';
import AmbientGlow from '../ui/AmbientGlow.vue';

interface Feature {
  title: string;
  description: string;
}

const features: Feature[] = [
  { title: 'چندمدلی', description: 'بین مدل‌های هوش مصنوعی جابه‌جا شوید' },
  { title: 'پاسخ زنده', description: 'پاسخ‌ها را همان لحظه و در جریان ببینید' },
  { title: 'تاریخچه مرتب', description: 'گفتگوها همیشه در دسترس و قابل جستجو' },
];
</script>

<template>
  <main class="auth-shell">
    <!-- Brand panel: the secondary area on desktop, compact header on mobile. -->
    <section class="auth-shell__brand" aria-hidden="false">
      <AmbientGlow />
      <div class="auth-shell__brand-content">
        <div class="auth-shell__logo">
          <BrandMark :size="40" />
          <strong>هوش‌یار</strong>
        </div>
        <h1 class="auth-shell__headline">
          هوش مصنوعی،<br />به ظرافتِ یک همکار.
        </h1>
        <p class="auth-shell__tagline">
          با چند مدل هوش مصنوعی گفتگو کنید، ایده بسازید و به سؤال‌ها برسید — همه در یک فضای آرام و حرفه‌ای.
        </p>
        <ul class="auth-shell__features">
          <li v-for="feature in features" :key="feature.title">
            <span class="auth-shell__feature-dot" aria-hidden="true"></span>
            <span><strong>{{ feature.title }}</strong> — {{ feature.description }}</span>
          </li>
        </ul>
      </div>
      <div class="auth-shell__pattern" aria-hidden="true"></div>
    </section>

    <!-- Form area -->
    <section class="auth-shell__form">
      <slot />
    </section>
  </main>
</template>

<style scoped>
.auth-shell {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  min-height: 100dvh;
}

/* Brand side */
.auth-shell__brand {
  position: relative;
  display: flex;
  align-items: center;
  overflow: hidden;
  padding: 3rem;
  background:
    radial-gradient(120% 90% at 85% -10%, var(--accent-soft) 0%, transparent 55%),
    var(--surface);
  border-inline-end: 1px solid var(--border-subtle);
}

.auth-shell__brand-content {
  position: relative;
  z-index: 1;
  max-width: 26rem;
  display: grid;
  gap: 1rem;
}

.auth-shell__logo {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.6rem;
}

.auth-shell__logo strong {
  font-size: 1.15rem;
}

.auth-shell__headline {
  font-size: 1.9rem;
  font-weight: 700;
  line-height: 1.5;
}

.auth-shell__tagline {
  font-size: 0.9rem;
  color: var(--text-2);
  max-width: 38ch;
}

.auth-shell__features {
  list-style: none;
  margin: 0.8rem 0 0;
  padding: 0;
  display: grid;
  gap: 0.7rem;
}

.auth-shell__features li {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  font-size: 0.82rem;
  color: var(--text-2);
}

.auth-shell__features strong {
  color: var(--text-1);
  font-weight: 600;
}

.auth-shell__feature-dot {
  width: 0.45rem;
  height: 0.45rem;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--accent);
  translate: 0 -0.05rem;
}

/* Subtle geometric signature pattern */
.auth-shell__pattern {
  position: absolute;
  inset-inline-start: -6rem;
  bottom: -6rem;
  width: 22rem;
  height: 22rem;
  background:
    radial-gradient(var(--accent-soft-border) 1.1px, transparent 1.3px);
  background-size: 18px 18px;
  rotate: 12deg;
  mask-image: radial-gradient(closest-side, black, transparent);
  opacity: 0.7;
  z-index: 1;
}

/* Form side */
.auth-shell__form {
  display: grid;
  place-items: center;
  padding: 2.5rem 1.5rem;
}

.auth-shell__form > :deep(*) {
  width: 100%;
  max-width: 24rem;
}

@media (max-width: 900px) {
  .auth-shell {
    grid-template-columns: 1fr;
  }

  .auth-shell__brand {
    padding: 1.4rem 1.5rem 1.2rem;
    border-inline-end: none;
    border-bottom: 1px solid var(--border-subtle);
  }

  .auth-shell__brand-content {
    max-width: none;
    gap: 0.4rem;
  }

  .auth-shell__logo {
    margin-bottom: 0.3rem;
  }

  .auth-shell__headline {
    font-size: 1.25rem;
  }

  .auth-shell__tagline,
  .auth-shell__features {
    display: none;
  }

  .auth-shell__pattern {
    display: none;
  }

  .auth-shell__form {
    padding-top: 2rem;
  }
}
</style>
