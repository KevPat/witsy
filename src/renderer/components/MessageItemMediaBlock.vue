<template>
  <div class="media-container" v-if="source">
    <video :src="source" :alt="desc" class="media video" @load="onMediaLoaded" controls v-if="isVideo()"></video>
    <img :src="source" :alt="desc" class="media image" @click="onFullscreen" @load="onMediaLoaded" v-else/>
    <div class="media-actions">
      <InfoIcon v-if="prompt" class="action info" @click="onInfo"/>
      <ClipboardIcon v-if="!isVideo() && !copying" class="action copy" @click="onCopy" />
      <ClipboardCheckIcon v-if="copying" class="action copy" />
      <DownloadIcon class="action download" @click="onDownload" />
    </div>
  </div>
  <div class="media-refused text variable-font-size" v-else><p>{{ refusedText }}</p></div>
</template>

<script setup lang="ts">

import { ClipboardCheckIcon, ClipboardIcon, DownloadIcon, InfoIcon } from 'lucide-vue-next'
import { computed, ref } from 'vue'
import Dialog from '@renderer/utils/dialog'
import { downloadWithPrompt } from '@services/download'
import useEventBus from '@composables/event_bus'
import Message from '@models/message'
const { emitBusEvent } = useEventBus()

const props = defineProps({
  url: {
    type: String,
    required: true,
  },
  desc: String,
  prompt: String
})

const copying = ref(false)

const emits = defineEmits(['media-loaded'])

// This page loads local files and network shares as readily as web pages, and the url
// comes from message content. The main process says what to load for it: the url itself
// when it is remote, the canonical url of a file of the app data folder, or nothing.
const source = computed((): string | null => {
  // an inline image names no location, and can be too large for a round trip
  if (props.url.startsWith('data:')) return props.url
  return window.api.markdown.resolveMediaUrl(props.url)
})

// what is not loaded is shown as the markdown that asked for it
const refusedText = computed(() => {
  return props.desc ? `![${props.desc}](${props.url})` : props.url
})

const isVideo = () => {
  return Message.isVideoUrl(props.url)
}

const onMediaLoaded = () => {
  emits('media-loaded')
}

const onFullscreen = () => {
  emitBusEvent('fullscreen', source.value)
}

const onInfo = () => {
  Dialog.show({
    title: props.desc,
    text: props.desc == props.prompt ? '' : props.prompt,
  })
}

const onCopy = () => {
  copying.value = true
  window.api.clipboard.writeImage(props.url)
  setTimeout(() => {
    copying.value = false
  }, 1000)
}

const onDownload = () => {
  downloadWithPrompt(props.url, `${isVideo() ? 'video' : 'image'}.${props.url.split('.').pop()}`)
}

</script>

<style scoped>

img {
  cursor: pointer;
}

</style>