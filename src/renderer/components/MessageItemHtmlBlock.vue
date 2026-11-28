<template>
  <div class="artifact panel">
    <div class="panel-header">
      <ChevronDownIcon class="icon toggle" @click.stop="togglePanel" />
      <label>{{ title }}</label>
      <ButtonIcon class="preview" @click="toggleHtml">
        <ScanEyeIcon v-if="!previewHtml" />
        <EyeOffIcon v-else />
      </ButtonIcon>
      <ButtonIcon>
        <ClipboardCheckIcon v-if="copying" />
        <ClipboardIcon @click="onCopy" v-else />
      </ButtonIcon>
      <ContextMenuTrigger class="download" position="below-right">
        <template #trigger>
          <DownloadIcon />
        </template>
        <template #menu>
          <div class="item" @click="onDownloadFormat('raw')">HTML</div>
          <div class="item" @click="onDownloadFormat('pdf')">PDF</div>
        </template>
      </ContextMenuTrigger>
    </div>
    <div class="panel-body variable-font-size" ref="panelBody">
      <MessageItemBody v-if="!previewHtml" :message="message" tool-calls-display="none" />
      <iframe ref="htmlIframe" sandbox="allow-scripts allow-forms" v-else-if="!transient || headComplete" :srcdoc="html" style="width: 100%; border: none;" />
      <div v-else class="html-loading">{{ t('common.htmlGeneration') }}</div>
    </div>

  </div>
</template>

<script setup lang="ts">

import { useArtifactCopy } from '@composables/artifact_copy'
import useEventListener from '@composables/event_listener'
import Message from '@models/message'
import { togglePanel } from '@renderer/utils/panel'
import { t } from '@services/i18n'
import { addExtension, extractCodeBlockContent, extractHtmlContent as extractHtml } from '@services/markdown'
import { exportToPdf } from '@services/pdf'
import { store } from '@services/store'
import { ChevronDownIcon, ClipboardCheckIcon, ClipboardIcon, DownloadIcon, EyeOffIcon, ScanEyeIcon } from 'lucide-vue-next'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ButtonIcon from './ButtonIcon.vue'
import ContextMenuTrigger from './ContextMenuTrigger.vue'
import MessageItemBody from './MessageItemBody.vue'

const content = () => extractCodeBlockContent(props.content)

const { onDomEvent } = useEventListener()
const { copying, onCopy } = useArtifactCopy(content)

const previewHtml = ref(false)
const htmlRenderingDelayPassed = ref(false)
const panelBody = ref<HTMLElement>()
const htmlIframe = ref<HTMLIFrameElement>()
const headComplete = ref(false)
const initialHtmlWithListener = ref('')

const kMaxFrameHeight = 20000
const kMaxSnapshotLength = 20 * 1024 * 1024
const kSnapshotTimeout = 2000

const frameId = crypto.randomUUID()

// The artifact runs in an opaque origin (no allow-same-origin), so the app cannot read its document
// and it cannot read the app's: the two only exchange messages. An opaque origin cannot be named
// as a postMessage target, hence '*' on both sides; each side checks event.source instead.
// The height is reported at fixed moments and not from a ResizeObserver: the app sets the frame
// height from these reports, and a page sized in vh would then grow on every report, without end.
// For the same reason a resize is only reported when the width changed.
const frameBridge = `
<script data-witsy-bridge>
(() => {
  const id = '${frameId}';
  const post = (message) => window.parent.postMessage(message, '*');
  const reportHeight = () => post({ type: 'witsy-artifact-height', id, height: document.documentElement.offsetHeight });
  const snapshot = () => {
    const root = document.documentElement.cloneNode(true);
    const canvases = document.querySelectorAll('canvas');
    root.querySelectorAll('canvas').forEach((canvas, index) => {
      try {
        const image = document.createElement('img');
        image.src = canvases[index].toDataURL('image/png');
        image.style.cssText = canvas.style.cssText;
        if (!image.style.width) image.style.width = canvases[index].width + 'px';
        if (!image.style.height) image.style.height = canvases[index].height + 'px';
        canvas.replaceWith(image);
      } catch (e) { /* tainted canvas */ }
    });
    return root.outerHTML;
  };
  let width = window.innerWidth;
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || !event.data) return;
    if (event.data.type === 'update' && document.body) {
      document.body.innerHTML = event.data.body;
      reportHeight();
    } else if (event.data.type === 'witsy-artifact-snapshot-request' && event.data.id === id) {
      post({ type: 'witsy-artifact-snapshot', id, html: snapshot() });
    }
  });
  window.addEventListener('load', () => {
    reportHeight();
    setTimeout(reportHeight, 100); // what the page renders in its own load handlers
  });
  let resizeTimeout;
  window.addEventListener('resize', () => {
    if (window.innerWidth === width) return;
    width = window.innerWidth;
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(reportHeight, 100);
  });
})();
<\/script>
`

const props = defineProps({
  title: {
    type: String,
    required: true,
  },
  content: {
    type: String,
    required: true,
  },
  transient: {
    type: Boolean,
    required: true,
  },
})

const message = computed(() => new Message('assistant', props.content))

const extractHtmlContent = () => extractHtml(props.content)

const extractBodyContent = (htmlContent: string) => {
  const bodyStart = htmlContent.indexOf('<body')
  if (bodyStart === -1) return ''
  const bodyTagEnd = htmlContent.indexOf('>', bodyStart)
  if (bodyTagEnd === -1) return ''
  const bodyEnd = htmlContent.lastIndexOf('</body>')
  if (bodyEnd === -1) return htmlContent.slice(bodyTagEnd + 1)
  return htmlContent.slice(bodyTagEnd + 1, bodyEnd)
}

const isDarkMode = () => {
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

const getDarkModeCSS = () => {
  return `
    <style>
      *:not([style*="color"]) {
        color: ${getComputedStyle(document.documentElement).getPropertyValue('--color-on-surface').trim()};
      }
    </style>
  `
}

const injectDarkModeCSS = (htmlContent: string) => {
  if (!isDarkMode()) {
    return htmlContent
  }

  const darkModeCSS = getDarkModeCSS()

  // Find the head tag and inject CSS
  const headEndIndex = htmlContent.indexOf('</head>')
  if (headEndIndex !== -1) {
    return htmlContent.substring(0, headEndIndex) + darkModeCSS + htmlContent.substring(headEndIndex)
  }

  // If no head tag, try to inject after opening html tag
  const htmlTagEnd = htmlContent.indexOf('>')
  if (htmlTagEnd !== -1 && htmlContent.substring(0, htmlTagEnd + 1).toLowerCase().includes('<html')) {
    return htmlContent.substring(0, htmlTagEnd + 1) + '<head>' + darkModeCSS + '</head>' + htmlContent.substring(htmlTagEnd + 1)
  }

  // Otherwise, prepend to the content
  return darkModeCSS + htmlContent
}

const injectFrameBridge = (htmlContent: string) => {
  const headEndIndex = htmlContent.search(/<\/head\s*>/i)
  if (headEndIndex !== -1) {
    return htmlContent.substring(0, headEndIndex) + frameBridge + htmlContent.substring(headEndIndex)
  }

  // no head: stay behind the doctype and the html tag so the page keeps its rendering mode
  const prefix = htmlContent.match(/^\s*(<!doctype[^>]*>)?\s*(<html[^>]*>)?/i)?.[0] ?? ''
  return prefix + frameBridge + htmlContent.substring(prefix.length)
}

const html = computed(() => {
  // Non-transient: return full HTML content with dark mode CSS injected
  if (!props.transient) {
    return injectFrameBridge(injectDarkModeCSS(extractHtmlContent()))
  }

  // Transient: wait for head to complete
  if (!headComplete.value) {
    return '' // No iframe yet
  }

  // Transient with head complete: return cached HTML with listener (already has CSS injected)
  return initialHtmlWithListener.value
})

let resolveSnapshot: ((html: string|null) => void)|null = null
let snapshotRequest: Promise<string|null>|null = null

// what the frame sends is written by the artifact: only a bounded number and a bounded string
// are read from it, and the string is never inserted in the document of the app
const onFrameMessage = (event: Event) => {
  const { source, data } = event as MessageEvent
  const iframe = htmlIframe.value
  if (!iframe?.contentWindow || source !== iframe.contentWindow) return
  if (!data || typeof data !== 'object' || data.id !== frameId) return

  if (data.type === 'witsy-artifact-height') {
    const height = data.height
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return
    iframe.style.height = Math.min(Math.ceil(height), kMaxFrameHeight) + 'px'
  } else if (data.type === 'witsy-artifact-snapshot') {
    if (typeof data.html !== 'string' || data.html.length > kMaxSnapshotLength) return
    resolveSnapshot?.(data.html)
  }
}

const requestSnapshot = (frame: Window): Promise<string|null> => {
  if (!snapshotRequest) {
    snapshotRequest = new Promise((resolve) => {
      const done = (html: string|null) => {
        clearTimeout(timeout)
        resolveSnapshot = null
        snapshotRequest = null
        resolve(html)
      }
      const timeout = setTimeout(() => done(null), kSnapshotTimeout)
      resolveSnapshot = done
      frame.postMessage({ type: 'witsy-artifact-snapshot-request', id: frameId }, '*')
    })
  }
  return snapshotRequest
}

const updateIframeContent = () => {
  const htmlContent = extractHtmlContent()
  if (!htmlContent) return

  // Check if head is complete (contains </head>)
  if (!headComplete.value && htmlContent.includes('</head>')) {
    // Extract everything up to and including </head>
    const headEndIndex = htmlContent.indexOf('</head>') + 7
    const headSection = htmlContent.substring(0, headEndIndex)

    // Inject dark mode CSS and listener before </head> and add empty body
    const darkModeCSS = isDarkMode() ? getDarkModeCSS() : ''
    const htmlWithListener = headSection.replace('</head>', () => darkModeCSS + frameBridge + '</head>')
    initialHtmlWithListener.value = htmlWithListener + '<body></body></html>'

    headComplete.value = true
    return
  }

  // Send body updates via postMessage
  if (headComplete.value) {
    if (!htmlIframe.value || !htmlIframe.value.contentWindow) return

    const bodyContent = extractBodyContent(htmlContent)
    htmlIframe.value.contentWindow.postMessage(
      { type: 'update', body: bodyContent },
      '*'
    )
  }
}

let delayTimeout: NodeJS.Timeout | null = null

const setupHtmlDelay = () => {
  if (!props.transient) {
    // Non-transient messages: show HTML immediately
    htmlRenderingDelayPassed.value = true
  } else {
    // Transient messages: reset delay and start timeout
    htmlRenderingDelayPassed.value = false

    // Clear any existing timeout
    if (delayTimeout) {
      clearTimeout(delayTimeout)
    }

    // Start new timeout
    delayTimeout = setTimeout(() => {
      htmlRenderingDelayPassed.value = true
    }, 2000)
  }
}

onMounted(() => {
  previewHtml.value = store.config.appearance.chat.autoPreview.html ?? true
  setupHtmlDelay()

  // Watch content changes for transient messages
  watch(() => props.content, () => {
    if (props.transient) {
      setupHtmlDelay()
      updateIframeContent()
    }
  })

  // Watch transient state changes
  watch(() => props.transient, (newTransient) => {
    if (!newTransient) {
      // Message is no longer transient (streaming completed)
      // Clear any pending timeout and show HTML immediately
      if (delayTimeout) {
        clearTimeout(delayTimeout)
        delayTimeout = null
      }
      htmlRenderingDelayPassed.value = true
    } else {
      // Message became transient (shouldn't happen normally, but handle it)
      setupHtmlDelay()
    }
  })

  // The frame reports its height and answers snapshot requests with messages
  onDomEvent(window, 'message', onFrameMessage)
})

onBeforeUnmount(() => {
  if (delayTimeout) clearTimeout(delayTimeout)
})

const toggleHtml = () => {
  previewHtml.value = !previewHtml.value
}

const onDownloadFormat = async (action: string) => {

  let filename = props.title
  let fileContent = ''

  switch (action) {
    case 'raw':
      fileContent = content()
      filename = addExtension(filename, '.html')
      break

    case 'pdf':
      try {
        // For HTML content, export the iframe content directly
        if (previewHtml.value) {
          const iframe = panelBody.value?.querySelector('iframe') as HTMLIFrameElement
          if (!iframe) {
            console.error('Could not find iframe element')
            return
          }

          // The frame sends its rendered document as a string; without an answer the source is exported.
          // DOMParser gives an inert document: its scripts do not run in the app.
          const snapshot = iframe.contentWindow ? await requestSnapshot(iframe.contentWindow) : null
          const iframeDoc = new DOMParser().parseFromString(snapshot ?? extractHtmlContent(), 'text/html')
          iframeDoc.querySelectorAll('script[data-witsy-bridge]').forEach((script) => script.remove())

          // Export the entire HTML document of the artifact
          await exportToPdf({
            title: filename.replace(/\.[^.]+$/, ''),
            element: iframeDoc.documentElement, // This gets the <html> element with all its content
          })

          return
        }
      } catch (error) {
        console.error('Failed to generate PDF:', error)
        return
      }

      // exportToPdf is already doing the save
      return
  }

  // Save file using the API for text and markdown
  window.api.file.save({
    contents: window.api.base64.encode(fileContent),
    properties: {
      filename,
      prompt: true
    }
  })
}

</script>

<style scoped>

.panel {
  .panel-body:has(.html-loading) {
    min-height: 300px;
  }
}

</style>