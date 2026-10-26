<template><button @click="cancel">Cancel</button></template>
<script lang="ts">
import axios from "axios";

export default {
  props: ["id"],
  methods: {
    async cancel() {
      await axios.post(`/api/orders/${this.id}/cancel`);
      this.$router.push("/");
    },
  },
};
</script>
