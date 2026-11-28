<template>
  <ButtonIcon
    :label="label"
    class="item" 
    :class="{ active: active }" 
    v-tooltip="{ text: label, position: 'right' }"
    @click="onClick"
  >
    <slot />
  </ButtonIcon>
</template>

<script setup lang="ts">

import ButtonIcon from './ButtonIcon.vue'

const emit = defineEmits(['click'])

const props = defineProps({
  label: {
    type: String,
    required: true,
  },
  action: {
    type: String,
    required: true,
  },
  active: {
    type: Boolean,
    default: false,
  },
})

const onClick = () => {
  emit('click', props.action)
}

</script>

<style scoped>

.item {
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  padding: 0.5rem;
  cursor: pointer;
  color: #848CAF;
  position: relative;

  &.active:deep() svg {
    color: var(--menubar-highlight-color) !important;
  }

  &:deep() {

    svg {
      width: var(--icon-lg);
      height: var(--icon-lg);
    }

    span {
      display: none;
    }

  }

}


</style>
