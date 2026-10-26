import { createRouter, createWebHistory } from "vue-router";
import Home from "../views/HomeView.vue";
import AdminLayout from "../layouts/AdminLayout.vue";

export default createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", component: Home },
    { path: "/orders/:id", name: "order", component: () => import("../views/OrderView.vue") },
    {
      path: "/admin",
      component: AdminLayout,
      children: [{ path: "users", component: () => import("../views/AdminUsers.vue") }],
    },
  ],
});
