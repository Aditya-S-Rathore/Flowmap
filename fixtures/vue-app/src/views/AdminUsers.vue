<template><ul /></template>
<script setup lang="ts">
const users = await fetch("/api/users").then((r) => r.json());
</script>
