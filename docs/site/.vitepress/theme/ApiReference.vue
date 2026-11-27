<template>
  <div class="api-reference-wrapper">
    <div ref="container" id="api-reference-container">
      <div v-if="loading" class="api-reference-loading">
        Loading interactive API reference...
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { withBase } from 'vitepress';

const container = ref(null);
const loading = ref(true);

onMounted(() => {
  const specUrl = withBase('/openapi.json');

  if (window.Redoc) {
    initRedoc(specUrl);
  } else {
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js';
    script.onload = () => {
      initRedoc(specUrl);
    };
    script.onerror = () => {
      loading.value = false;
      if (container.value) {
        container.value.innerHTML = `<p>Failed to load API reference renderer. You can view the raw <a href="${specUrl}">OpenAPI spec</a> or read the <a href="${withBase('/api/narrative')}">Narrative Reference</a>.</p>`;
      }
    };
    document.head.appendChild(script);
  }
});

function initRedoc(specUrl) {
  if (!window.Redoc || !container.value) return;
  loading.value = false;
  window.Redoc.init(
    specUrl,
    {
      scrollYOffset: 64,
      hideDownloadButton: false,
      expandResponses: 'all',
      theme: {
        colors: {
          primary: {
            main: '#1f4d3a',
          },
          text: {
            primary: '#1c1815',
            secondary: '#5e5648',
          },
          http: {
            get: '#1f4d3a',
            post: '#2e6b52',
            put: '#9a7b2c',
            delete: '#a83232',
          },
        },
        typography: {
          fontSize: '15px',
          fontFamily: "'IBM Plex Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
          headings: {
            fontFamily: "'Fraunces', 'IBM Plex Sans', serif",
            fontWeight: '600',
          },
          code: {
            fontFamily: "'IBM Plex Mono', Menlo, monospace",
          },
        },
        sidebar: {
          backgroundColor: '#f1ebe1',
          textColor: '#1c1815',
          activeTextColor: '#1f4d3a',
        },
        rightPanel: {
          backgroundColor: '#1b2a22',
          textColor: '#ffffff',
        },
      },
    },
    container.value
  );
}
</script>

<style scoped>
.api-reference-wrapper {
  margin-top: 1.5rem;
  width: 100%;
  min-height: 600px;
}
.api-reference-loading {
  padding: 3rem 1rem;
  text-align: center;
  font-size: 1.1rem;
  color: var(--vp-c-text-2);
}
</style>
