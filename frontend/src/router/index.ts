import { createRouter, createWebHistory } from 'vue-router';
import { useAuth } from '../composables/useAuth';

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { guestOnly: true },
  },
  {
    path: '/register',
    name: 'register',
    component: () => import('../views/RegisterView.vue'),
    meta: { guestOnly: true },
  },
  {
    path: '/',
    name: 'chat',
    component: () => import('../views/ChatView.vue'),
  },
  {
    path: '/admin/models',
    name: 'admin-models',
    component: () => import('../views/AdminModelsView.vue'),
    meta: { adminOnly: true },
  },
  {
    // Route guard is convenience only — the backend enforces @Roles('admin')
    // on every /admin/files endpoint.
    path: '/admin/files',
    name: 'admin-files',
    component: () => import('../views/AdminFilesView.vue'),
    meta: { adminOnly: true },
  },
  {
    // Consumption & cost overview (usage_records aggregation) + plan management.
    path: '/admin/usage',
    name: 'admin-usage',
    component: () => import('../views/AdminUsageView.vue'),
    meta: { adminOnly: true },
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

export const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach((to) => {
  const auth = useAuth();
  if (to.meta.guestOnly && auth.isLoggedIn.value) return { name: 'chat' };
  if (!to.meta.guestOnly && !auth.isLoggedIn.value) return { name: 'login' };
  if (to.meta.adminOnly && !auth.isAdmin.value) return { name: 'chat' };
  return true;
});
