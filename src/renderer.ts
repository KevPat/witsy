import { createApp } from 'vue'
import { vTooltip } from './renderer/directives/tooltip'
import i18n from './renderer/services/i18n'
import { installCopyCodeHandler } from './renderer/services/copy_code'
import App from './renderer/App.vue'

// the links under the code blocks have no inline handler (content security policy)
installCopyCodeHandler()

try {
  const app = createApp(App)
  app.use(i18n)
  app.directive('tooltip', vTooltip)
  app.mount('#app')
} catch (e) {
  alert(e)
}
