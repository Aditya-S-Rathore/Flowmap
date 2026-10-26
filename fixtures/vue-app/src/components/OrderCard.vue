<template><div>{{ total }}</div></template>
<script setup lang="ts">
const total = await fetch("/api/orders/total").then((r) => r.json());
</script>
