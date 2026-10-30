<script setup>
import { ApiReference } from '@scalar/api-reference'
import '@scalar/api-reference/style.css'
import { withBase } from 'vitepress'

const configuration = {
  spec: { url: withBase('/api/openapi.json') },
  hideTestRequestButton: true,
  hideClientButton: true,
  theme: 'default',
}
</script>

<template>
  <ClientOnly>
    <ApiReference :configuration="configuration" />
  </ClientOnly>
</template>
