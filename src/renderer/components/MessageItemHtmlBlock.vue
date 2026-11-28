<template>
  <div class="artifact panel">
    <div class="panel-header">
      <ChevronDownIcon class="icon toggle" @click.stop="togglePanel" />
      <label>{{ title }}</label>
      <ButtonIcon :label="previewHtml ? t('common.close') : t('common.preview')" class="preview" @click="toggleHtml">
        <ScanEyeIcon v-if="!previewHtml" />
        <EyeOffIcon v-else />
      </ButtonIcon>
      <ButtonIcon :label="t('common.copy')">
        <ClipboardCheckIcon v-if="copying" />
        <ClipboardIcon @click="onCopy" v-else />
      </ButtonIcon>
      <ContextMenuTrigger :label="t('common.download')" class="download" position="below-right">
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
      <iframe ref="htmlIframe" :key="frameGeneration" sandbox="allow-scripts allow-forms" v-else-if="!transient || headComplete" :src="kArtifactFrameUrl" :style="{ width: '100%', border: 'none', height: frameHeight }" />
      <div v-else class="html-loading">{{ t('common.htmlGeneration') }}</div>
    </div>

  </div>
</template>

<script setup lang="ts">

import { useArtifactCopy } from '@composables/artifact_copy'
import useEventListener from '@composables/event_listener'
import { kArtifactContentMessage, kArtifactFrameUrl, kArtifactReadyMessage } from '@/consts'
import Message from '@models/message'
import { togglePanel } from '@renderer/utils/panel'
import { t } from '@services/i18n'
import { buildFrameBridge, injectFrameBridge, kFrameHeightMessage, kFrameSnapshotMessage, kFrameSnapshotRequestMessage } from '@services/artifact_frame'
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

// The artifact is not a srcdoc frame: such a frame gets the content security policy of the app, which
// forbids the inline scripts an artifact is made of. The frame loads a fixed page of the app instead
// (kArtifactFrameUrl, served by the main process without that policy), which asks for its content when
// it is loaded and becomes the page it is sent.
// The artifact runs in an opaque origin (no allow-same-origin) and only exchanges messages with the app:
// the script that does it on the side of the artifact is in @services/artifact_frame.
const frameBridge = buildFrameBridge(frameId)

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

const html = computed(() => {
  // Non-transient: return full HTML content with dark mode CSS injected
  if (!props.transient) {
    return injectFrameBridge(injectDarkModeCSS(extractHtmlContent()), frameBridge)
  }

  // Transient: wait for head to complete
  if (!headComplete.value) {
    return '' // No iframe yet
  }

  // Transient with head complete: return cached HTML with listener (already has CSS injected)
  return initialHtmlWithListener.value
})

// the frame is a page of its own that is written once: other html means another frame.
// The new frame starts with the height of the previous one, until it reports its own:
// the message does not jump when the page of a streaming message is complete
const frameGeneration = ref(0)
const frameHeight = ref('')
watch(html, () => {
  frameGeneration.value++
})

// the frame asked for its page: it gets the html of this artifact
const sendPageToFrame = () => {
  const frame = htmlIframe.value?.contentWindow
  if (!frame) return
  frame.postMessage({ type: kArtifactContentMessage, html: html.value }, '*')

  // a message that is still streaming: the body received so far comes after the head
  if (props.transient && headComplete.value) {
    updateIframeContent()
  }
}

let resolveSnapshot: ((html: string|null) => void)|null = null
let snapshotRequest: Promise<string|null>|null = null

// what the frame sends is written by the artifact: only a bounded number and a bounded string
// are read from it, and the string is never inserted in the document of the app
const onFrameMessage = (event: Event) => {
  const { source, data } = event as MessageEvent
  const iframe = htmlIframe.value
  if (!iframe?.contentWindow || source !== iframe.contentWindow) return
  if (!data || typeof data !== 'object') return

  // sent by the page of the frame each time it is loaded (the artifact may reload itself): it has no id yet
  if (data.type === kArtifactReadyMessage) {
    sendPageToFrame()
    return
  }

  if (data.id !== frameId) return

  if (data.type === kFrameHeightMessage) {
    const height = data.height
    if (typeof height !== 'number' || !Number.isFinite(height) || height <= 0) return
    frameHeight.value = Math.min(Math.ceil(height), kMaxFrameHeight) + 'px'
  } else if (data.type === kFrameSnapshotMessage) {
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
      frame.postMessage({ type: kFrameSnapshotRequestMessage, id: frameId }, '*')
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