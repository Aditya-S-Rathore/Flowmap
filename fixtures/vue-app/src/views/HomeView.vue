<template>
  <main>
    <OrderCard />
    <RouterLink :to="{ name: 'order', params: { id: 1 } }">First order</RouterLink>
    <RouterLink to="/admin/users">Users</RouterLink>
  </main>
</template>

<script setup lang="ts">
import axios from "axios";
import OrderCard from "../components/OrderCard.vue";

const orders = await axios.get("/api/orders");
</script>
