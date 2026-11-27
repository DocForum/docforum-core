import DefaultTheme from 'vitepress/theme';
import './custom.css';
import ApiReference from './ApiReference.vue';

export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component('ApiReference', ApiReference);
  },
};
